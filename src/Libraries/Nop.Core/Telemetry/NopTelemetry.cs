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

}
