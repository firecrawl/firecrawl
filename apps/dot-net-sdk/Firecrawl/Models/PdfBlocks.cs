using System.Text.Json.Serialization;

namespace Firecrawl.Models;

/// <summary>
/// Physical markdown for a single PDF page.
/// </summary>
public class PdfPage
{
    [JsonPropertyName("pageNumber")]
    public int PageNumber { get; set; }

    [JsonPropertyName("markdown")]
    public string Markdown { get; set; } = "";
}

/// <summary>
/// Layout and OCR confidence scores for a PDF block.
/// </summary>
public class PdfBlockConfidence
{
    [JsonPropertyName("layout")]
    public double? Layout { get; set; }

    [JsonPropertyName("ocr")]
    public double? Ocr { get; set; }
}

/// <summary>
/// A typed PDF layout block (bounding box, type, reading order).
/// </summary>
public class PdfBlockItem
{
    [JsonPropertyName("id")]
    public string Id { get; set; } = "";

    [JsonPropertyName("type")]
    public string Type { get; set; } = "";

    [JsonPropertyName("label")]
    public string? Label { get; set; }

    [JsonPropertyName("bbox")]
    public List<double>? BBox { get; set; }

    [JsonPropertyName("content")]
    public string Content { get; set; } = "";

    [JsonPropertyName("markdownSpan")]
    public List<int>? MarkdownSpan { get; set; }

    [JsonPropertyName("readingOrder")]
    public int ReadingOrder { get; set; }

    [JsonPropertyName("source")]
    public string? Source { get; set; }

    [JsonPropertyName("confidence")]
    public PdfBlockConfidence? Confidence { get; set; }
}

/// <summary>
/// Typed layout blocks for a single PDF page.
/// </summary>
public class PdfPageBlocks
{
    [JsonPropertyName("pageNumber")]
    public int PageNumber { get; set; }

    [JsonPropertyName("width")]
    public double? Width { get; set; }

    [JsonPropertyName("height")]
    public double? Height { get; set; }

    [JsonPropertyName("status")]
    public string Status { get; set; } = "";

    [JsonPropertyName("items")]
    public List<PdfBlockItem> Items { get; set; } = [];
}
