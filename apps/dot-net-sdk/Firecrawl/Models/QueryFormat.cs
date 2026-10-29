using System.Text.Json.Serialization;

namespace Firecrawl.Models;

/// <summary>
/// Deprecated query format specification for use in ScrapeOptions.Formats.
/// </summary>
[Obsolete("Use QuestionFormat or HighlightsFormat instead.")]
public class QueryFormat
{
    public const string FreeformMode = "freeform";
    public const string DirectQuoteMode = "directQuote";

    [JsonPropertyName("type")]
    public string Type { get; } = "query";

    [JsonPropertyName("prompt")]
    public required string Prompt { get; set; }

    [JsonPropertyName("mode")]
    [JsonIgnore(Condition = JsonIgnoreCondition.WhenWritingNull)]
    public string? Mode { get; set; }
}
