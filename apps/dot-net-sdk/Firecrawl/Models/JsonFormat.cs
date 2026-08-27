using System.Text.Json.Serialization;

namespace Firecrawl.Models;

/// <summary>
/// JSON extraction format specification for use in ScrapeOptions.Formats.
/// </summary>
public class JsonFormat
{
    [JsonPropertyName("type")]
    public string Type { get; } = "json";

    [JsonPropertyName("prompt")]
    [JsonIgnore(Condition = JsonIgnoreCondition.WhenWritingNull)]
    public string? Prompt { get; set; }

    [JsonPropertyName("schema")]
    [JsonIgnore(Condition = JsonIgnoreCondition.WhenWritingNull)]
    public Dictionary<string, object>? Schema { get; set; }

    [JsonPropertyName("checkPromptInjection")]
    [JsonIgnore(Condition = JsonIgnoreCondition.WhenWritingNull)]
    public bool? CheckPromptInjection { get; set; }
}
