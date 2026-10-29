using System.Text.Json.Serialization;

namespace Firecrawl.Models;

/// <summary>
/// URL discovery (map) results.
/// </summary>
public class MapData
{
    [JsonPropertyName("links")]
    public List<MapLink>? Links { get; set; }
}

/// <summary>
/// A URL discovered by map, with the page title and description when known.
/// </summary>
public class MapLink
{
    [JsonPropertyName("url")]
    public string? Url { get; set; }

    [JsonPropertyName("title")]
    public string? Title { get; set; }

    [JsonPropertyName("description")]
    public string? Description { get; set; }
}
