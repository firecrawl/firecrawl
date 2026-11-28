using System.Text.Json.Serialization;

namespace Firecrawl.Models;

/// <summary>
/// Status and results of a crawl job.
/// </summary>
public class CrawlJob
{
    [JsonPropertyName("id")]
    public string? Id { get; set; }

    [JsonPropertyName("status")]
    public string? Status { get; set; }

    /// <summary>
    /// The failure reason reported when the job could not start.
    /// </summary>
    [JsonPropertyName("error")]
    [JsonIgnore(Condition = JsonIgnoreCondition.WhenWritingNull)]
    public string? Error { get; set; }

    /// <summary>
    /// A warning reported with the job status, such as incomplete coverage.
    /// </summary>
    [JsonPropertyName("warning")]
    [JsonIgnore(Condition = JsonIgnoreCondition.WhenWritingNull)]
    public string? Warning { get; set; }

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
    /// Returns true if the crawl job has reached a terminal state.
    /// </summary>
    public bool IsDone =>
        Status == "completed" || Status == "cancelled" || Status == "failed";
}
