using System.Text.Json.Serialization;

namespace Firecrawl.Models;

/// <summary>
/// Response from starting an async batch scrape job.
/// </summary>
public class BatchScrapeResponse
{
    [JsonPropertyName("success")]
    public bool Success { get; set; }

    [JsonPropertyName("id")]
    public string? Id { get; set; }

    [JsonPropertyName("invalidURLs")]
    public List<string>? InvalidURLs { get; set; }
}
