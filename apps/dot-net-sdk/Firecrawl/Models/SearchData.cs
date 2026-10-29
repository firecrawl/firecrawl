using System.Text.Json.Serialization;

namespace Firecrawl.Models;

/// <summary>
/// Represents a single web search hit.
/// </summary>
public class WebSearchHit
{
    [JsonPropertyName("url")]
    public string? Url { get; set; }

    [JsonPropertyName("title")]
    public string? Title { get; set; }

    [JsonPropertyName("description")]
    public string? Description { get; set; }

    [JsonPropertyName("position")]
    public int? Position { get; set; }

    [JsonPropertyName("category")]
    public string? Category { get; set; }

    [JsonPropertyName("markdown")]
    public string? Markdown { get; set; }

    [JsonPropertyName("html")]
    public string? Html { get; set; }

    [JsonPropertyName("rawHtml")]
    public string? RawHtml { get; set; }

    [JsonPropertyName("links")]
    public List<string>? Links { get; set; }

    [JsonPropertyName("screenshot")]
    public string? Screenshot { get; set; }

    [JsonPropertyName("metadata")]
    public Dictionary<string, object>? Metadata { get; set; }

    [JsonPropertyName("answer")]
    public string? Answer { get; set; }

    [JsonPropertyName("highlights")]
    public string? Highlights { get; set; }
}

/// <summary>
/// Represents a news search result with news-specific fields.
/// </summary>
public class NewsSearchHit
{
    [JsonPropertyName("url")]
    public string? Url { get; set; }

    [JsonPropertyName("title")]
    public string? Title { get; set; }

    [JsonPropertyName("snippet")]
    public string? Snippet { get; set; }

    [JsonPropertyName("date")]
    public string? Date { get; set; }

    [JsonPropertyName("imageUrl")]
    public string? ImageUrl { get; set; }

    [JsonPropertyName("position")]
    public int? Position { get; set; }

    [JsonPropertyName("category")]
    public string? Category { get; set; }

    [JsonPropertyName("markdown")]
    public string? Markdown { get; set; }

    [JsonPropertyName("html")]
    public string? Html { get; set; }

    [JsonPropertyName("rawHtml")]
    public string? RawHtml { get; set; }

    [JsonPropertyName("links")]
    public List<string>? Links { get; set; }

    [JsonPropertyName("screenshot")]
    public string? Screenshot { get; set; }

    [JsonPropertyName("metadata")]
    public Dictionary<string, object>? Metadata { get; set; }

    [JsonPropertyName("answer")]
    public string? Answer { get; set; }

    [JsonPropertyName("highlights")]
    public string? Highlights { get; set; }
}

/// <summary>
/// Represents an image search result.
/// </summary>
public class ImageSearchHit
{
    [JsonPropertyName("title")]
    public string? Title { get; set; }

    [JsonPropertyName("imageUrl")]
    public string? ImageUrl { get; set; }

    [JsonPropertyName("imageWidth")]
    public int? ImageWidth { get; set; }

    [JsonPropertyName("imageHeight")]
    public int? ImageHeight { get; set; }

    [JsonPropertyName("url")]
    public string? Url { get; set; }

    [JsonPropertyName("position")]
    public int? Position { get; set; }

    [JsonPropertyName("answer")]
    public string? Answer { get; set; }

    [JsonPropertyName("highlights")]
    public string? Highlights { get; set; }
}

/// <summary>
/// Web search results.
/// </summary>
public class SearchData
{
    [JsonPropertyName("web")]
    public List<WebSearchHit>? Web { get; set; }

    [JsonPropertyName("news")]
    public List<NewsSearchHit>? News { get; set; }

    [JsonPropertyName("images")]
    public List<ImageSearchHit>? Images { get; set; }
}
