using System.Text.Json.Serialization;

namespace Firecrawl.Models;

/// <summary>
/// Account credit usage information.
/// </summary>
public class CreditUsage
{
    [JsonPropertyName("remaining_credits")]
    public int? RemainingCredits { get; set; }

    [JsonPropertyName("total_credits_used")]
    public int? TotalCreditsUsed { get; set; }

    [JsonPropertyName("billing_period_start")]
    public string? BillingPeriodStart { get; set; }

    [JsonPropertyName("billing_period_end")]
    public string? BillingPeriodEnd { get; set; }
}
