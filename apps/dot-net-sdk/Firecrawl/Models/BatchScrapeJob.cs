using System.Text.Json.Serialization;

namespace Firecrawl.Models;

/// <summary>
/// Status and results of a batch scrape job.
/// </summary>
public class BatchScrapeJob
{
    [JsonPropertyName("id")]
    public string? Id { get; set; }

    [JsonPropertyName("status")]
    public string? Status { get; set; }

    [JsonPropertyName("completed")]
    public int? Completed { get; set; }

    [JsonPropertyName("total")]
    public int? Total { get; set; }

    [JsonPropertyName("creditsUsed")]
    public int? CreditsUsed { get; set; }

    [JsonPropertyName("expiresAt")]
    public string? ExpiresAt { get; set; }

    [JsonPropertyName("next")]
    public string? Next { get; set; }

    [JsonPropertyName("data")]
    public List<Document>? Data { get; set; }

    /// <summary>
    /// Returns true if the batch scrape job has reached a terminal state.
    /// </summary>
    public bool IsDone =>
        Status == "completed" || Status == "cancelled" || Status == "failed";
}
