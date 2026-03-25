docker run --rm -i --network host \
  -e BASE_URL=http://localhost \
  -e PRODUCT_SKU=LE_TX1_CL \
  -e COUNTRY_NAME=Portugal \
  -e PAYMENT_METHODS="Payments.CheckMoneyOrder,Payments.Manual" \
  -v "$PWD:/work" \
  grafana/k6 run /work/assessment/load-test/k6/checkout-order-flow.js