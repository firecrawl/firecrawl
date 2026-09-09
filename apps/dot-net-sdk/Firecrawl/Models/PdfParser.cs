using System.Text.Json.Serialization;

namespace Firecrawl.Models;

/// <summary>
/// PDF parser configuration for use in <see cref="ScrapeOptions.Parsers"/> /
/// <see cref="ParseOptions.Parsers"/>.
/// </summary>
public class PdfParser
{
    [JsonPropertyName("type")]
    public string Type { get; } = "pdf";

    [JsonPropertyName("mode")]
    [JsonIgnore(Condition = JsonIgnoreCondition.WhenWritingNull)]
    public string? Mode { get; set; }

    [JsonPropertyName("maxPages")]
    [JsonIgnore(Condition = JsonIgnoreCondition.WhenWritingNull)]
    public int? MaxPages { get; set; }

    /// <summary>
    /// Include physical per-page markdown. Populates <c>document.pages</c>.
    /// </summary>
    [JsonPropertyName("pages")]
    [JsonIgnore(Condition = JsonIgnoreCondition.WhenWritingNull)]
    public bool? Pages { get; set; }

    /// <summary>
    /// Include per-page typed layout blocks. Populates <c>document.blocks</c>.
    /// </summary>
    [JsonPropertyName("blocks")]
    [JsonIgnore(Condition = JsonIgnoreCondition.WhenWritingNull)]
    public bool? Blocks { get; set; }

    /// <summary>
    /// Join PDF pages in <c>document.markdown</c> with
    /// <c>\n\n---\n\n&lt;!-- page N --&gt;\n\n</c>. Markers appear between
    /// pages only; numbering may skip pages merged by cross-page stitching —
    /// use <see cref="Pages"/> when every physical page is needed.
    /// </summary>
    [JsonPropertyName("pageMarkers")]
    [JsonIgnore(Condition = JsonIgnoreCondition.WhenWritingNull)]
    public bool? PageMarkers { get; set; }
}
