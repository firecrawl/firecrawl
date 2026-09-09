using System.Text.Json.Serialization;

namespace Firecrawl.Models;

/// <summary>
/// Configuration options for scraping a single URL.
/// </summary>
public class ScrapeOptions
{
    [JsonPropertyName("formats")]
    [JsonIgnore(Condition = JsonIgnoreCondition.WhenWritingNull)]
    public List<object>? Formats { get; set; }

    [JsonPropertyName("headers")]
    [JsonIgnore(Condition = JsonIgnoreCondition.WhenWritingNull)]
    public Dictionary<string, string>? Headers { get; set; }

    [JsonPropertyName("includeTags")]
    [JsonIgnore(Condition = JsonIgnoreCondition.WhenWritingNull)]
    public List<string>? IncludeTags { get; set; }

    [JsonPropertyName("excludeTags")]
    [JsonIgnore(Condition = JsonIgnoreCondition.WhenWritingNull)]
    public List<string>? ExcludeTags { get; set; }

    [JsonPropertyName("onlyMainContent")]
    [JsonIgnore(Condition = JsonIgnoreCondition.WhenWritingNull)]
    public bool? OnlyMainContent { get; set; }

    [JsonPropertyName("timeout")]
    [JsonIgnore(Condition = JsonIgnoreCondition.WhenWritingNull)]
    public int? Timeout { get; set; }

    [JsonPropertyName("waitFor")]
    [JsonIgnore(Condition = JsonIgnoreCondition.WhenWritingNull)]
    public int? WaitFor { get; set; }

    [JsonPropertyName("mobile")]
    [JsonIgnore(Condition = JsonIgnoreCondition.WhenWritingNull)]
    public bool? Mobile { get; set; }

    [JsonPropertyName("parsers")]
    [JsonIgnore(Condition = JsonIgnoreCondition.WhenWritingNull)]
    public List<object>? Parsers { get; set; }

    [JsonPropertyName("actions")]
    [JsonIgnore(Condition = JsonIgnoreCondition.WhenWritingNull)]
    public List<Dictionary<string, object>>? Actions { get; set; }

    [JsonPropertyName("location")]
    [JsonIgnore(Condition = JsonIgnoreCondition.WhenWritingNull)]
    public LocationConfig? Location { get; set; }

    [JsonPropertyName("skipTlsVerification")]
    [JsonIgnore(Condition = JsonIgnoreCondition.WhenWritingNull)]
    public bool? SkipTlsVerification { get; set; }

    [JsonPropertyName("removeBase64Images")]
    [JsonIgnore(Condition = JsonIgnoreCondition.WhenWritingNull)]
    public bool? RemoveBase64Images { get; set; }

    [JsonPropertyName("blockAds")]
    [JsonIgnore(Condition = JsonIgnoreCondition.WhenWritingNull)]
    public bool? BlockAds { get; set; }

    [JsonPropertyName("proxy")]
    [JsonIgnore(Condition = JsonIgnoreCondition.WhenWritingNull)]
    public string? Proxy { get; set; }

    [JsonPropertyName("maxAge")]
    [JsonIgnore(Condition = JsonIgnoreCondition.WhenWritingNull)]
    public long? MaxAge { get; set; }

    [JsonPropertyName("storeInCache")]
    [JsonIgnore(Condition = JsonIgnoreCondition.WhenWritingNull)]
    public bool? StoreInCache { get; set; }

    [JsonPropertyName("redactPII")]
    [JsonIgnore(Condition = JsonIgnoreCondition.WhenWritingNull)]
    public bool? RedactPII { get; set; }

    [JsonPropertyName("auditMetadata")]
    [JsonIgnore(Condition = JsonIgnoreCondition.WhenWritingNull)]
    public AuditMetadata? AuditMetadata { get; set; }

    [JsonPropertyName("integration")]
    [JsonIgnore(Condition = JsonIgnoreCondition.WhenWritingNull)]
    public string? Integration { get; set; }
}
