using System.Text.Json.Serialization;

namespace Firecrawl.Models;

/// <summary>
/// URL discovery (map) results.
/// </summary>
public class MapData
{
    private List<string>? _links;
    private List<MapLink>? _linkDetails;

    [JsonPropertyName("success")]
    public bool Success { get; set; }

    [JsonPropertyName("id")]
    public string? Id { get; set; }

    [JsonPropertyName("warning")]
    public string? Warning { get; set; }

    [JsonPropertyName("error")]
    public string? Error { get; set; }

    [JsonPropertyName("links")]
    public List<MapLink>? LinkDetails
    {
        get => _linkDetails;
        set
        {
            _linkDetails = value;
            _links = value?.Select(link => link.Url).ToList();
        }
    }

    /// <summary>URL-only view retained for callers of earlier SDK versions.</summary>
    [JsonIgnore]
    public List<string>? Links
    {
        get => _links;
        set
        {
            _links = value;
            _linkDetails = value?.Select(url => new MapLink { Url = url }).ToList();
        }
    }
}
