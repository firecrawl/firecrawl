using System.Text.Json.Serialization;

namespace Firecrawl.Models;

/// <summary>
/// Configuration options for batch scraping multiple URLs.
/// </summary>
public class BatchScrapeOptions
{
    [JsonPropertyName("options")]
    [JsonIgnore(Condition = JsonIgnoreCondition.WhenWritingNull)]
    public ScrapeOptions? Options { get; set; }

    [JsonPropertyName("webhook")]
    [JsonIgnore(Condition = JsonIgnoreCondition.WhenWritingNull)]
    public object? Webhook { get; set; }

    [JsonPropertyName("appendToId")]
    [JsonIgnore(Condition = JsonIgnoreCondition.WhenWritingNull)]
    public string? AppendToId { get; set; }

    [JsonPropertyName("ignoreInvalidURLs")]
    [JsonIgnore(Condition = JsonIgnoreCondition.WhenWritingNull)]
    public bool? IgnoreInvalidURLs { get; set; }

    [JsonPropertyName("maxConcurrency")]
    [JsonIgnore(Condition = JsonIgnoreCondition.WhenWritingNull)]
    public int? MaxConcurrency { get; set; }

    [JsonPropertyName("zeroDataRetention")]
    [JsonIgnore(Condition = JsonIgnoreCondition.WhenWritingNull)]
    public bool? ZeroDataRetention { get; set; }

    [JsonPropertyName("integration")]
    [JsonIgnore(Condition = JsonIgnoreCondition.WhenWritingNull)]
    public string? Integration { get; set; }

    /// <summary>
    /// Idempotency key sent as the x-idempotency-key HTTP header (not in the JSON body).
    /// </summary>
    [JsonIgnore]
    public string? IdempotencyKey { get; set; }
}
