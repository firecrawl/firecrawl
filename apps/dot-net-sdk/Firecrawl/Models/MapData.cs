using System.Text.Json.Serialization;

namespace Firecrawl.Models;

/// <summary>
/// URL discovery (map) results.
/// </summary>
public class MapData
{
    [JsonPropertyName("success")]
    public bool Success { get; set; }

    [JsonPropertyName("id")]
    public string? Id { get; set; }

    [JsonPropertyName("warning")]
    public string? Warning { get; set; }

    [JsonPropertyName("links")]
    public List<MapLink>? LinkDetails { get; set; }

    /// <summary>URL-only view retained for callers of earlier SDK versions.</summary>
    [JsonIgnore]
    public List<string>? Links
    {
        get => LinkDetails?.Select(link => link.Url).ToList();
        set => LinkDetails = value?.Select(url => new MapLink { Url = url }).ToList();
    }
}
