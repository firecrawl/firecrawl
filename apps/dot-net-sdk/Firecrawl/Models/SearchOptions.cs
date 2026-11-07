using System.Text.Json.Serialization;

namespace Firecrawl.Models;

/// <summary>
/// Configuration options for web search.
/// </summary>
public class SearchOptions
{
    [JsonPropertyName("sources")]
    [JsonIgnore(Condition = JsonIgnoreCondition.WhenWritingNull)]
    public List<object>? Sources { get; set; }

    [JsonPropertyName("categories")]
    [JsonIgnore(Condition = JsonIgnoreCondition.WhenWritingNull)]
    public List<object>? Categories { get; set; }

    [JsonPropertyName("includeDomains")]
    [JsonIgnore(Condition = JsonIgnoreCondition.WhenWritingNull)]
    public List<string>? IncludeDomains { get; set; }

    [JsonPropertyName("excludeDomains")]
    [JsonIgnore(Condition = JsonIgnoreCondition.WhenWritingNull)]
    public List<string>? ExcludeDomains { get; set; }

    [JsonPropertyName("limit")]
    [JsonIgnore(Condition = JsonIgnoreCondition.WhenWritingNull)]
    public int? Limit { get; set; }

    [JsonPropertyName("tbs")]
    [JsonIgnore(Condition = JsonIgnoreCondition.WhenWritingNull)]
    public string? Tbs { get; set; }

    [JsonPropertyName("location")]
    [JsonIgnore(Condition = JsonIgnoreCondition.WhenWritingNull)]
    public string? Location { get; set; }

    [JsonPropertyName("ignoreInvalidURLs")]
    [JsonIgnore(Condition = JsonIgnoreCondition.WhenWritingNull)]
    public bool? IgnoreInvalidURLs { get; set; }

    [JsonPropertyName("timeout")]
    [JsonIgnore(Condition = JsonIgnoreCondition.WhenWritingNull)]
    public int? Timeout { get; set; }

    /// <summary>Generate query-relevant highlights for search results. Defaults to true.</summary>
    [JsonPropertyName("highlights")]
    [JsonIgnore(Condition = JsonIgnoreCondition.WhenWritingNull)]
    public bool? Highlights { get; set; }

    [JsonPropertyName("scrapeOptions")]
    [JsonIgnore(Condition = JsonIgnoreCondition.WhenWritingNull)]
    public ScrapeOptions? ScrapeOptions { get; set; }

    [JsonPropertyName("integration")]
    [JsonIgnore(Condition = JsonIgnoreCondition.WhenWritingNull)]
    public string? Integration { get; set; }

    [JsonPropertyName("country")]
    [JsonIgnore(Condition = JsonIgnoreCondition.WhenWritingNull)]
    public string? Country { get; set; }

    /// <summary>
    /// Enterprise search options. Use <c>["zdr"]</c> for end-to-end Zero Data
    /// Retention or <c>["anon"]</c> for anonymized search. Must be enabled for your team.
    /// </summary>
    [JsonPropertyName("enterprise")]
    [JsonIgnore(Condition = JsonIgnoreCondition.WhenWritingNull)]
    public List<string>? Enterprise { get; set; }
}
