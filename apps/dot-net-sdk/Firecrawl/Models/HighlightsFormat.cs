using System.Text.Json.Serialization;

namespace Firecrawl.Models;

/// <summary>
/// Highlights format specification for use in ScrapeOptions.Formats.
/// </summary>
public class HighlightsFormat
{
    [JsonPropertyName("type")]
    public string Type { get; } = "highlights";

    [JsonPropertyName("query")]
    public required string Query { get; set; }
}
