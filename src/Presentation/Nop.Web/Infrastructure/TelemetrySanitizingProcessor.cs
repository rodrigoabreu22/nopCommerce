using System.Diagnostics;
using OpenTelemetry;

namespace Nop.Web.Infrastructure;

/// <summary>
/// OpenTelemetry processor that removes PII attributes from spans before export.
/// This is a belt-and-suspenders safeguard: instrumentation code should never set PII tags,
/// but this processor ensures that any tag matching a sensitive pattern is stripped
/// regardless of how it was added.
/// </summary>
public class TelemetrySanitizingProcessor : BaseProcessor<Activity>
{
    // Attribute key substrings that indicate PII. Case-insensitive check.
    private static readonly string[] _sensitiveKeyPatterns =
    [
        "email",
        "address",
        "phone",
        "card",
        "password",
        "customer.id",
        "user.id",
        "firstname",
        "lastname",
        "first_name",
        "last_name",
    ];

    public override void OnEnd(Activity activity)
    {
        if (activity is null)
            return;

        var keysToRemove = new List<string>();

        foreach (var tag in activity.TagObjects)
        {
            if (IsSensitive(tag.Key))
                keysToRemove.Add(tag.Key);
        }

        foreach (var key in keysToRemove)
            activity.SetTag(key, null);
    }

    private static bool IsSensitive(string key)
    {
        var lower = key.ToLowerInvariant();
        foreach (var pattern in _sensitiveKeyPatterns)
        {
            if (lower.Contains(pattern))
                return true;
        }
        return false;
    }
}
