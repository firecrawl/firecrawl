using System.Text.Json.Serialization;

namespace Firecrawl.Models;

/// <summary>
/// Markdown extracted from a single PDF page.
/// </summary>
public class DocumentPage
{
    [JsonPropertyName("pageNumber")]
    public int PageNumber { get; set; }

    [JsonPropertyName("markdown")]
    public string Markdown { get; set; } = string.Empty;
}
