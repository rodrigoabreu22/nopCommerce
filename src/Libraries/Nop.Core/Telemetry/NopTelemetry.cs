using System.Diagnostics;
using System.Diagnostics.Metrics;

namespace Nop.Core.Telemetry;

/// <summary>
/// Shared OpenTelemetry sources for nopCommerce.
/// </summary>
public static class NopTelemetry
{
    public const string ServiceName = "nopCommerce";

    public static readonly ActivitySource ActivitySource = new(ServiceName);
    public static readonly Meter Meter = new(ServiceName);

    public static readonly Counter<long> CartAddResultTotal =
        Meter.CreateCounter<long>("cart_add_result_total", unit: "1", description: "Total add-to-cart attempts by result.");

    public static readonly Histogram<double> CartAddDurationMs =
        Meter.CreateHistogram<double>("cart_add_duration_ms", unit: "ms", description: "Add-to-cart service duration.");

    public static readonly Counter<long> CheckoutPaymentResultTotal =
        Meter.CreateCounter<long>("checkout_payment_result_total", unit: "1", description: "Checkout payment processing results by method and outcome.");

    public static readonly Counter<long> CheckoutPlaceOrderFailuresTotal =
        Meter.CreateCounter<long>("checkout_place_order_failures_total", unit: "1", description: "Checkout place-order failures by stage.");

    public static readonly Histogram<double> CheckoutPlaceOrderDurationMs =
        Meter.CreateHistogram<double>("checkout_place_order_duration_ms", unit: "ms", description: "End-to-end place-order service duration.");

    public static readonly Histogram<double> CheckoutOrderSaveDurationMs =
        Meter.CreateHistogram<double>("checkout_order_save_duration_ms", unit: "ms", description: "Order persistence duration during checkout.");

    /// <summary>
    /// Counts exceptions caught at the OpcConfirmOrder controller entry point — before PlaceOrderAsync is reached.
    /// These represent presentation-layer rejections: empty cart, session expiry, captcha failure, minimum
    /// order interval.  A spike here that is NOT matched by a spike in checkout_place_order_failures_total
    /// points to a client-side or session issue rather than a payment/persistence problem.
    /// </summary>
    public static readonly Counter<long> CheckoutOpcConfirmErrorsTotal =
        Meter.CreateCounter<long>("checkout_opc_confirm_errors_total", unit: "1", description: "Exceptions caught at the OpcConfirmOrder controller entry point.");
}
