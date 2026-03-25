import http from 'k6/http';
import exec from 'k6/execution';
import { check, fail, sleep } from 'k6';

// ---------------------------------------------------------------------------
// Scenarios
//
//  happy_path  (80 % of VUs) — full checkout: add to cart → billing →
//              shipping → payment method → confirm order
//              Drives: checkout_payment_result_total, checkout_place_order_duration_ms,
//                      checkout_order_save_duration_ms, cart_add_result_total
//
//  invalid_checkout (20 % of VUs) — adds a product to cart then jumps
//              directly to OpcConfirmOrder without selecting a payment method.
//              nopCommerce rejects this with "Payment information is not
//              entered" (or "Your cart is empty" for guest flow restrictions).
//              With the activity.SetStatus(Error) fix this shows in Jaeger as
//              a checkout.opc_confirm span with error status.
//              Drives: checkout.opc_confirm error spans in Jaeger
//
// Why two scenarios?  A dashboard that only shows success is not a useful
// diagnostic tool.  The invalid_checkout scenario produces visible error
// traces that an on-call engineer would investigate using the trace panel.
// It also keeps the error rate panel honest: the metric stays at 0 (because
// the rejection happens at the controller layer, before PlaceOrderAsync), but
// the trace view shows where and why things fail.
// ---------------------------------------------------------------------------
export const options = {
  scenarios: {
    happy_path: {
      executor: 'ramping-vus',
      stages: [
        { duration: '30s', target: 5 },
        { duration: '2m',  target: 10 },
        { duration: '30s', target: 0 },
      ],
      exec: 'happyPath',
    },
    invalid_checkout: {
      executor: 'ramping-vus',
      stages: [
        { duration: '30s', target: 3 },
        { duration: '2m',  target: 5 },
        { duration: '30s', target: 0 },
      ],
      exec: 'invalidCheckout',
    },
  },
  thresholds: {
    // happy_path VUs should keep overall HTTP failure rate low
    http_req_failed: ['rate<0.05'],
    http_req_duration: ['p(95)<3000'],
  },
};

const config = {
  baseUrl: (__ENV.BASE_URL || 'http://localhost').replace(/\/$/, ''),
  productId: __ENV.PRODUCT_ID,
  productSku: __ENV.PRODUCT_SKU,
  quantity: __ENV.QUANTITY || '1',
  countryId: __ENV.COUNTRY_ID,
  countryName: __ENV.COUNTRY_NAME,
  stateProvinceId: __ENV.STATE_PROVINCE_ID || '0',
  stateProvinceName: __ENV.STATE_PROVINCE_NAME,
  // PAYMENT_METHODS accepts a comma-separated list of system names.
  // Each happy_path VU picks one method round-robin so all methods appear
  // as separate series in the "Checkout Payment Result Rate by Method" panel.
  // Falls back to PAYMENT_METHOD (singular) for backwards compatibility.
  // Example: -e PAYMENT_METHODS="Payments.CheckMoneyOrder,Payments.Manual"
  paymentMethods: (__ENV.PAYMENT_METHODS || __ENV.PAYMENT_METHOD || 'Payments.CheckMoneyOrder')
    .split(',').map((m) => m.trim()).filter(Boolean),
  firstName: __ENV.FIRST_NAME || 'Load',
  lastName: __ENV.LAST_NAME || 'Tester',
  company: __ENV.COMPANY || '',
  city: __ENV.CITY || 'Lisbon',
  address1: __ENV.ADDRESS1 || 'Rua da Carga 1',
  address2: __ENV.ADDRESS2 || '',
  zipPostalCode: __ENV.ZIP_POSTAL_CODE || '1000-001',
  phoneNumber: __ENV.PHONE_NUMBER || '910000000',
  shipToSameAddress: (__ENV.SHIP_TO_SAME_ADDRESS || 'true').toLowerCase() === 'true',
};

function ensureRequiredConfig() {
  const missing = [];

  if (!config.productId && !config.productSku) missing.push('PRODUCT_ID or PRODUCT_SKU');
  if (!config.countryId && !config.countryName) missing.push('COUNTRY_ID or COUNTRY_NAME');

  if (missing.length) {
    fail(`Missing required environment variables: ${missing.join(', ')}`);
  }
}

function htmlDecode(value) {
  return value
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>');
}

function extractAntiForgeryToken(body) {
  const match = body.match(/name="__RequestVerificationToken"[^>]*value="([^"]+)"/i);
  return match ? htmlDecode(match[1]) : null;
}

function extractFirstValue(body, regex, description) {
  const match = body.match(regex);
  if (!match) {
    fail(`Could not find ${description} in response HTML`);
  }

  return htmlDecode(match[1]);
}

function resolveProductIdFromSku() {
  // nopCommerce's autocomplete endpoint returns JSON only for AJAX requests.
  // Without X-Requested-With it may return HTML or redirect to login.
  const response = http.get(
    `${config.baseUrl}/catalog/searchtermautocomplete?term=${encodeURIComponent(config.productSku)}&categoryId=0`,
    { headers: { 'X-Requested-With': 'XMLHttpRequest', Accept: 'application/json' } }
  );

  check(response, {
    'search autocomplete returned 200': (r) => r.status === 200,
  });

  let results;
  try {
    results = response.json();
  } catch (error) {
    fail(`Could not parse search autocomplete response while resolving PRODUCT_SKU (body: ${String(response.body).slice(0, 200)})`);
  }

  if (!Array.isArray(results) || !results.length) {
    fail(`Could not find a product for SKU ${config.productSku}`);
  }

  let fallbackProductId = null;

  for (const result of results) {
    if (!result.producturl) {
      continue;
    }

    const detailsPage = http.get(`${config.baseUrl}${result.producturl}`);
    check(detailsPage, {
      'product details returned 200': (r) => r.status === 200,
    });

    const productIdMatch = detailsPage.body.match(/data-productid="(\d+)"/i);
    if (!productIdMatch) {
      continue;
    }

    if (!fallbackProductId) {
      fallbackProductId = productIdMatch[1];
    }

    const skuMatch = detailsPage.body.match(/<span class="value" id="sku-\d+">\s*([^<]+?)\s*<\/span>/i);
    if (skuMatch && htmlDecode(skuMatch[1]).trim() === config.productSku) {
      return productIdMatch[1];
    }
  }

  if (fallbackProductId) {
    return fallbackProductId;
  }

  fail(`Could not resolve PRODUCT_SKU ${config.productSku} to a product id`);
}

function resolveCountryIdFromName(checkoutPageHtml) {
  const optionRegex = /<option[^>]*value="(\d+)"[^>]*>\s*([^<]+?)\s*<\/option>/gi;
  const normalizedCountryName = config.countryName.trim().toLowerCase();

  for (const match of checkoutPageHtml.matchAll(optionRegex)) {
    const optionValue = match[1];
    const optionLabel = htmlDecode(match[2]).trim().toLowerCase();

    if (optionValue !== '0' && optionLabel === normalizedCountryName) {
      return match[1];
    }
  }

  fail(`Could not resolve COUNTRY_NAME ${config.countryName} from checkout page`);
}

function resolveStateProvinceId(countryId) {
  if (config.stateProvinceId && config.stateProvinceId !== '0') {
    return config.stateProvinceId;
  }

  const response = http.get(
    `${config.baseUrl}/country/getstatesbycountryid?countryId=${encodeURIComponent(countryId)}&addSelectStateItem=true`
  );

  check(response, {
    'get states by country returned 200': (r) => r.status === 200,
  });

  let states;
  try {
    states = response.json();
  } catch (error) {
    fail('Could not parse states/provinces response');
  }

  if (!Array.isArray(states) || !states.length) {
    return '0';
  }

  const actualStates = states.filter((state) => String(state.id) !== '0');
  if (!actualStates.length) {
    return '0';
  }

  if (config.stateProvinceName) {
    const normalizedStateName = config.stateProvinceName.trim().toLowerCase();
    const namedState = actualStates.find(
      (state) => String(state.name || '').trim().toLowerCase() === normalizedStateName
    );

    if (!namedState) {
      fail(`Could not resolve STATE_PROVINCE_NAME ${config.stateProvinceName} for country ${countryId}`);
    }

    return String(namedState.id);
  }

  return String(actualStates[0].id);
}

function parseCheckoutAttributes(cartPageHtml) {
  const payload = {};
  const hasCheckoutAttributes = cartPageHtml.includes('class="checkout-attributes"');
  if (!hasCheckoutAttributes) {
    return payload;
  }

  const requiredAttributeIds = new Set();
  for (const match of cartPageHtml.matchAll(/<dt id="checkout_attribute_label_(\d+)">[\s\S]*?<span class="required">\*<\/span>/gi)) {
    requiredAttributeIds.add(match[1]);
  }

  for (const attributeId of requiredAttributeIds) {
    const controlName = `checkout_attribute_${attributeId}`;

    const selectMatch = cartPageHtml.match(
      new RegExp(`<select[^>]*name="${controlName}"[^>]*>([\\s\\S]*?)<\\/select>`, 'i')
    );
    if (selectMatch) {
      const optionMatch = selectMatch[1].match(/<option[^>]*value="([1-9]\d*)"[^>]*>/i);
      if (optionMatch) {
        payload[controlName] = optionMatch[1];
        continue;
      }
    }

    const radioMatch = cartPageHtml.match(
      new RegExp(`<input[^>]*type="radio"[^>]*name="${controlName}"[^>]*value="([1-9]\\d*)"[^>]*>`, 'i')
    );
    if (radioMatch) {
      payload[controlName] = radioMatch[1];
      continue;
    }

    const checkboxMatches = [...cartPageHtml.matchAll(
      new RegExp(`<input[^>]*type="checkbox"[^>]*name="${controlName}"[^>]*value="([1-9]\\d*)"[^>]*>`, 'gi')
    )];
    if (checkboxMatches.length) {
      payload[controlName] = checkboxMatches.map((match) => match[1]).join(',');
      continue;
    }

    const textInputMatch = cartPageHtml.match(
      new RegExp(`<input[^>]*name="${controlName}"[^>]*type="text"[^>]*value="([^"]*)"[^>]*>`, 'i')
    );
    if (textInputMatch) {
      payload[controlName] = htmlDecode(textInputMatch[1]) || 'Load test';
      continue;
    }

    const textAreaMatch = cartPageHtml.match(
      new RegExp(`<textarea[^>]*name="${controlName}"[^>]*>([\\s\\S]*?)<\\/textarea>`, 'i')
    );
    if (textAreaMatch) {
      payload[controlName] = htmlDecode(textAreaMatch[1]).trim() || 'Load test';
      continue;
    }

    fail(`Could not resolve a value for required checkout attribute ${attributeId}`);
  }

  return payload;
}

function submitCheckoutAttributes(cartToken, cartPageHtml) {
  const checkoutAttributesPayload = parseCheckoutAttributes(cartPageHtml);
  if (!Object.keys(checkoutAttributesPayload).length) {
    return;
  }

  const response = http.post(
    `${config.baseUrl}/shoppingcart/checkoutattributechange/true`,
    {
      __RequestVerificationToken: cartToken,
      ...checkoutAttributesPayload,
    },
    buildHeaders()
  );

  check(response, {
    'checkout attribute change returned 200': (r) => r.status === 200,
  });
}

function buildHeaders() {
  return {
    headers: {
      'Content-Type': 'application/x-www-form-urlencoded',
      Accept: 'application/json, text/plain, */*',
    },
    redirects: 0,
  };
}

function buildBillingPayload(token, countryId, stateProvinceId) {
  const uniqueSuffix = `${exec.vu.idInTest}-${exec.scenario.iterationInTest}`;
  const email = `load-${uniqueSuffix}@example.test`;

  return {
    __RequestVerificationToken: token,
    billing_address_id: '0',
    ShipToSameAddress: String(config.shipToSameAddress).toLowerCase(),
    'BillingNewAddress.Id': '0',
    'BillingNewAddress.FirstName': config.firstName,
    'BillingNewAddress.LastName': config.lastName,
    'BillingNewAddress.Email': email,
    'BillingNewAddress.Company': config.company,
    'BillingNewAddress.CountryId': countryId,
    'BillingNewAddress.StateProvinceId': stateProvinceId,
    'BillingNewAddress.City': config.city,
    'BillingNewAddress.Address1': config.address1,
    'BillingNewAddress.Address2': config.address2,
    'BillingNewAddress.ZipPostalCode': config.zipPostalCode,
    'BillingNewAddress.PhoneNumber': config.phoneNumber,
  };
}

function buildShippingPayload(token, countryId, stateProvinceId) {
  const uniqueSuffix = `${exec.vu.idInTest}-${exec.scenario.iterationInTest}`;
  const email = `load-${uniqueSuffix}@example.test`;

  return {
    __RequestVerificationToken: token,
    shipping_address_id: '',
    'ShippingNewAddress.Id': '0',
    'ShippingNewAddress.FirstName': config.firstName,
    'ShippingNewAddress.LastName': config.lastName,
    'ShippingNewAddress.Email': email,
    'ShippingNewAddress.Company': config.company,
    'ShippingNewAddress.CountryId': countryId,
    'ShippingNewAddress.StateProvinceId': stateProvinceId,
    'ShippingNewAddress.City': config.city,
    'ShippingNewAddress.Address1': config.address1,
    'ShippingNewAddress.Address2': config.address2,
    'ShippingNewAddress.ZipPostalCode': config.zipPostalCode,
    'ShippingNewAddress.PhoneNumber': config.phoneNumber,
  };
}

function unwrapJsonResponse(response, stepName) {
  check(response, {
    [`${stepName} returned 200`]: (r) => r.status === 200,
  });

  let data;
  try {
    data = response.json();
  } catch (error) {
    fail(`${stepName} did not return valid JSON`);
  }

  if (data.error) {
    fail(`${stepName} failed: ${JSON.stringify(data.message)}`);
  }

  return data;
}

function submitShippingIfNeeded(token, currentStep, countryId, stateProvinceId) {
  if (!currentStep.update_section || currentStep.update_section.name !== 'shipping') {
    return currentStep;
  }

  const response = http.post(
    `${config.baseUrl}/checkout/OpcSaveShipping/`,
    buildShippingPayload(token, countryId, stateProvinceId),
    buildHeaders()
  );

  return unwrapJsonResponse(response, 'OpcSaveShipping');
}

function submitShippingMethodIfNeeded(token, currentStep) {
  if (!currentStep.update_section || currentStep.update_section.name !== 'shipping-method') {
    return currentStep;
  }

  const shippingOption = extractFirstValue(
    currentStep.update_section.html,
    /name="shippingoption"[^>]*value="([^"]+)"/i,
    'shipping option'
  );

  const response = http.post(
    `${config.baseUrl}/checkout/OpcSaveShippingMethod/`,
    {
      __RequestVerificationToken: token,
      shippingoption: shippingOption,
    },
    buildHeaders()
  );

  return unwrapJsonResponse(response, 'OpcSaveShippingMethod');
}

function pickPaymentMethod(html) {
  // Round-robin across the configured list using VU ID so each VU consistently
  // uses one method — this produces distinct series per method in Grafana.
  const idx = (exec.vu.idInTest - 1) % config.paymentMethods.length;
  const desired = config.paymentMethods[idx];

  // Only use the desired method if it is actually present on the checkout page.
  // If the store has it disabled, fall back to the first available method so
  // the checkout still completes and records a metric rather than crashing.
  if (html.includes(desired)) {
    return desired;
  }

  return extractFirstValue(html, /name="paymentmethod"[^>]*value="([^"]+)"/i, 'payment method');
}

function submitPaymentMethod(token, currentStep) {
  if (!currentStep.update_section || currentStep.update_section.name !== 'payment-method') {
    fail('Expected payment-method step before selecting a payment method');
  }

  const paymentMethod = pickPaymentMethod(currentStep.update_section.html);

  const response = http.post(
    `${config.baseUrl}/checkout/OpcSavePaymentMethod/`,
    {
      __RequestVerificationToken: token,
      paymentmethod: paymentMethod,
      UseRewardPoints: 'false',
    },
    buildHeaders()
  );

  return unwrapJsonResponse(response, 'OpcSavePaymentMethod');
}

// Test card values used when a payment plugin shows a card-entry form.
// These are standard test numbers that pass Luhn validation without
// hitting any real payment network.
const TEST_CARD = {
  number: '4111111111111111', // Visa test number
  holder: 'Load Tester',
  cvv: '123',
  expireMonth: '12',
  expireYear: '2030',
};

function submitPaymentInfoIfNeeded(currentStep) {
  if (!currentStep.update_section || currentStep.update_section.name !== 'payment-info') {
    return currentStep;
  }

  const html = currentStep.update_section.html;
  const payload = {};

  // Extract hidden fields (anti-forgery tokens etc.) as-is.
  for (const m of html.matchAll(/<input[^>]*type="hidden"[^>]*name="([^"]+)"[^>]*value="([^"]*)"[^>]*>/gi)) {
    payload[m[1]] = htmlDecode(m[2]);
  }
  // Also handle value-before-name order
  for (const m of html.matchAll(/<input[^>]*value="([^"]*)"[^>]*type="hidden"[^>]*name="([^"]+)"[^>]*>/gi)) {
    payload[m[2]] = htmlDecode(m[1]);
  }

  // Fill visible text/tel/number inputs using field-name heuristics.
  for (const m of html.matchAll(/<input[^>]*type="(?:text|tel|number)"[^>]*name="([^"]+)"[^>]*/gi)) {
    const name = m[1];
    const lower = name.toLowerCase();
    if (lower.includes('cardnumber') || lower.includes('card_number') || lower.includes('ccnumber')) {
      payload[name] = TEST_CARD.number;
    } else if (lower.includes('cardholder') || lower.includes('holdername') || lower.includes('ccname')) {
      payload[name] = TEST_CARD.holder;
    } else if (lower.includes('cardcode') || lower.includes('cvv') || lower.includes('cvc') || lower.includes('csc')) {
      payload[name] = TEST_CARD.cvv;
    } else {
      payload[name] = '';
    }
  }

  // Fill select fields: expiry month/year and card type.
  for (const m of html.matchAll(/<select[^>]*name="([^"]+)"[^>]*>([\s\S]*?)<\/select>/gi)) {
    const name = m[1];
    const lower = name.toLowerCase();
    const optionValues = [...m[2].matchAll(/<option[^>]*value="([^"]+)"[^>]*>/gi)].map((o) => o[1]);
    if (!optionValues.length) continue;

    if (lower.includes('expireyear') || lower.includes('expire_year') || lower.includes('cardyear')) {
      const future = optionValues.find((v) => parseInt(v) >= 2026) || optionValues[0];
      payload[name] = future;
    } else if (lower.includes('expiremonth') || lower.includes('expire_month') || lower.includes('cardmonth')) {
      payload[name] = '12';
    } else {
      // Card type — pick first available option
      payload[name] = optionValues[0];
    }
  }

  const response = http.post(
    `${config.baseUrl}/checkout/OpcSavePaymentInfo/`,
    payload,
    buildHeaders()
  );

  return unwrapJsonResponse(response, 'OpcSavePaymentInfo');
}

function submitConfirmOrder(token) {
  const response = http.post(
    `${config.baseUrl}/checkout/OpcConfirmOrder/`,
    {
      __RequestVerificationToken: token,
      captchaValid: 'true',
    },
    buildHeaders()
  );

  const data = unwrapJsonResponse(response, 'OpcConfirmOrder');
  check(data, {
    'order placement succeeded': (d) => d.success === 1 || typeof d.redirect === 'string',
  });
}

// ---------------------------------------------------------------------------
// setup() — runs ONCE before any VU starts.
// Resolves the product ID from SKU here so that concurrent VUs don't hammer
// the search autocomplete endpoint simultaneously on every iteration.
// The returned object is passed as the first argument to every scenario function.
// ---------------------------------------------------------------------------
export function setup() {
  ensureRequiredConfig();
  const productId = config.productId || resolveProductIdFromSku();
  return { productId };
}

// ---------------------------------------------------------------------------
// Happy-path scenario — full checkout flow
// ---------------------------------------------------------------------------
export function happyPath({ productId }) {
  const landing = http.get(`${config.baseUrl}/`);
  const antiForgeryToken = extractAntiForgeryToken(landing.body);
  if (!antiForgeryToken) {
    fail('Could not extract antiforgery token from landing page');
  }

  const addToCart = http.post(
    `${config.baseUrl}/addproducttocart/catalog/${productId}/1/${config.quantity}`,
    { __RequestVerificationToken: antiForgeryToken },
    buildHeaders()
  );

  const addToCartData = unwrapJsonResponse(addToCart, 'AddProductToCart_Catalog');
  check(addToCartData, {
    'product added to cart': (d) => d.success === true || typeof d.redirect === 'string',
  });

  const cartPage = http.get(`${config.baseUrl}/cart`);
  const cartToken = extractAntiForgeryToken(cartPage.body);
  if (!cartToken) {
    fail('Could not extract antiforgery token from cart page');
  }
  submitCheckoutAttributes(cartToken, cartPage.body);

  const checkoutPage = http.get(`${config.baseUrl}/onepagecheckout/`);
  const checkoutToken = extractAntiForgeryToken(checkoutPage.body);
  if (!checkoutToken) {
    fail('Could not extract antiforgery token from one page checkout');
  }

  const countryId = config.countryId || resolveCountryIdFromName(checkoutPage.body);
  const stateProvinceId = resolveStateProvinceId(countryId);

  let currentStep = unwrapJsonResponse(
    http.post(
      `${config.baseUrl}/checkout/OpcSaveBilling/`,
      buildBillingPayload(checkoutToken, countryId, stateProvinceId),
      buildHeaders()
    ),
    'OpcSaveBilling'
  );

  currentStep = submitShippingIfNeeded(checkoutToken, currentStep, countryId, stateProvinceId);
  currentStep = submitShippingMethodIfNeeded(checkoutToken, currentStep);
  currentStep = submitPaymentMethod(checkoutToken, currentStep);
  currentStep = submitPaymentInfoIfNeeded(currentStep);
  submitConfirmOrder(checkoutToken);

  sleep(1);
}

// ---------------------------------------------------------------------------
// Invalid-checkout scenario — adds a product to cart, then calls
// OpcConfirmOrder WITHOUT going through billing, shipping or payment selection.
//
// Why this triggers checkout_opc_confirm_errors_total:
//   CheckMoneyOrder uses SkipPaymentInfo=true, so SetProcessPaymentRequestAsync
//   is only called inside OpcLoadStepAfterPaymentMethod, which is reached from
//   OpcSavePaymentMethod.  By skipping OpcSavePaymentMethod, the session never
//   gets a ProcessPaymentRequest.  At OpcConfirmOrder:
//     GetProcessPaymentRequestAsync() → null
//     IsPaymentWorkflowRequiredAsync(cart with paid items) → true
//     throw new Exception("Payment information is not entered")
//   ...which is caught by the OpcConfirmOrder catch block, increments
//   checkout_opc_confirm_errors_total and marks the checkout.opc_confirm
//   span ERROR in Jaeger.
//
// NOTE: requires docker compose up --build so the updated CheckoutController
// catch block (with CheckoutOpcConfirmErrorsTotal.Add(1)) is deployed.
//
// What you see in Grafana after rebuild:
//   - Checkout Entry Errors (5m) rises (green → yellow/red)
//   - entry-point errors/s line rises in the error rate panel
//   - Jaeger trace panel shows checkout.opc_confirm spans in error state
// ---------------------------------------------------------------------------
export function invalidCheckout({ productId }) {
  const landing = http.get(`${config.baseUrl}/`);
  const antiForgeryToken = extractAntiForgeryToken(landing.body);
  if (!antiForgeryToken) {
    return;
  }

  // Add product to cart — cart must be non-empty so that
  // IsPaymentWorkflowRequiredAsync(cart) returns true and the exception path fires.
  const addToCart = http.post(
    `${config.baseUrl}/addproducttocart/catalog/${productId}/1/${config.quantity}`,
    { __RequestVerificationToken: antiForgeryToken },
    buildHeaders()
  );
  let addData;
  try { addData = addToCart.json(); } catch (_) { addData = {}; }
  if (!addData.success && typeof addData.redirect !== 'string') {
    // Add-to-cart failed (product requires attributes, out of stock, etc.).
    // Skip iteration — we only want the payment-missing error, not cart noise.
    return;
  }

  // Get the checkout page to obtain a valid antiforgery token for the POST.
  const checkoutPage = http.get(`${config.baseUrl}/onepagecheckout/`);
  const checkoutToken = extractAntiForgeryToken(checkoutPage.body);
  if (!checkoutToken) {
    return;
  }

  // Jump straight to OpcConfirmOrder — no billing, shipping, or payment selected.
  // This guarantees the "Payment information is not entered" exception path.
  const response = http.post(
    `${config.baseUrl}/checkout/OpcConfirmOrder/`,
    {
      __RequestVerificationToken: checkoutToken,
      captchaValid: 'true',
    },
    buildHeaders()
  );

  let data;
  try { data = response.json(); } catch (_) { data = {}; }

  // error=1 means OpcConfirmOrder caught an exception — exactly what we want.
  check(data, {
    'confirm without payment correctly rejected': (d) => d.error === 1,
  });

  sleep(1);
}

// Default export is required by k6 but only used when no scenario is
// specified.  Point it at the happy path.
export default happyPath;
