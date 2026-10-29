using System.Text.Json.Serialization;

namespace Firecrawl.Models;

/// <summary>
/// Geolocation configuration for requests.
/// </summary>
public class LocationConfig
{
    [JsonPropertyName("country")]
    [JsonIgnore(Condition = JsonIgnoreCondition.WhenWritingNull)]
    public string? Country { get; set; }

    [JsonPropertyName("languages")]
    [JsonIgnore(Condition = JsonIgnoreCondition.WhenWritingNull)]
    public List<string>? Languages { get; set; }
}
