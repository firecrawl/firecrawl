using System.Text.Json.Serialization;

namespace Firecrawl.Models;

/// <summary>
/// Configuration for parsing PDF documents.
/// </summary>
public class PdfParser
{
    [JsonPropertyName("type")]
    public string Type { get; } = "pdf";

    [JsonPropertyName("mode")]
    [JsonIgnore(Condition = JsonIgnoreCondition.WhenWritingNull)]
    public string? Mode { get; set; }

    [JsonPropertyName("maxPages")]
    [JsonIgnore(Condition = JsonIgnoreCondition.WhenWritingNull)]
    public int? MaxPages { get; set; }

    [JsonPropertyName("pageMarkdown")]
    [JsonIgnore(Condition = JsonIgnoreCondition.WhenWritingNull)]
    public bool? PageMarkdown { get; set; }
}
