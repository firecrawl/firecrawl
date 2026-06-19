using System.Text.Json.Serialization;

namespace Firecrawl.Models;

/// <summary>
/// Represents a scraped document returned by the Firecrawl API.
/// </summary>
public class Document
{
    [JsonPropertyName("markdown")]
    public string? Markdown { get; set; }

    [JsonPropertyName("html")]
    public string? Html { get; set; }

    [JsonPropertyName("rawHtml")]
    public string? RawHtml { get; set; }

    [JsonPropertyName("json")]
    public object? Json { get; set; }

    [JsonPropertyName("summary")]
    public string? Summary { get; set; }

    [JsonPropertyName("metadata")]
    public Dictionary<string, object>? Metadata { get; set; }

    [JsonPropertyName("links")]
    public List<string>? Links { get; set; }

    [JsonPropertyName("images")]
    public List<string>? Images { get; set; }

    [JsonPropertyName("screenshot")]
    public string? Screenshot { get; set; }

    [JsonPropertyName("audio")]
    public object? Audio { get; set; }

    [JsonPropertyName("video")]
    public string? Video { get; set; }

    [JsonPropertyName("actions")]
    public object? Actions { get; set; }

    [JsonPropertyName("answer")]
    public string? Answer { get; set; }

    [JsonPropertyName("highlights")]
    public string? Highlights { get; set; }

    [JsonPropertyName("warning")]
    public string? Warning { get; set; }

    [JsonPropertyName("changeTracking")]
    public object? ChangeTracking { get; set; }

    [JsonPropertyName("branding")]
    public object? Branding { get; set; }

    [JsonPropertyName("product")]
    public ProductProfile? Product { get; set; }

    [JsonPropertyName("menu")]
    public MenuProfile? Menu { get; set; }
}
