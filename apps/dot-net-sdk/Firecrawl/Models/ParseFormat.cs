using System.Text.Json.Serialization;

namespace Firecrawl.Models;

/// <summary>
/// Known categories of formats accepted by <c>/v2/parse</c>.
/// </summary>
public enum ParseFormatKind
{
    Unknown,
    Document,
    Image,
}

/// <summary>
/// A file format accepted by the <c>/v2/parse</c> endpoint.
/// </summary>
public class ParseFormat
{
    [JsonPropertyName("format")]
    public string Format { get; set; } = "";

    /// <summary>
    /// Raw kind reported by the API (e.g. <c>document</c> or <c>image</c>).
    /// Kept as a string so new kinds do not break deserialization; see <see cref="KindValue"/>.
    /// </summary>
    [JsonPropertyName("kind")]
    public string Kind { get; set; } = "";

    [JsonPropertyName("extensions")]
    public List<string> Extensions { get; set; } = new();

    [JsonPropertyName("mimeTypes")]
    public List<string> MimeTypes { get; set; } = new();

    /// <summary>
    /// Whether the deployment can currently parse this format.
    /// </summary>
    [JsonPropertyName("available")]
    public bool Available { get; set; }

    /// <summary>
    /// <see cref="Kind"/> as an enum, or <see cref="ParseFormatKind.Unknown"/> for unrecognized values.
    /// </summary>
    [JsonIgnore]
    public ParseFormatKind KindValue => Kind switch
    {
        "document" => ParseFormatKind.Document,
        "image" => ParseFormatKind.Image,
        _ => ParseFormatKind.Unknown,
    };
}

internal class ParseFormatsData
{
    [JsonPropertyName("formats")]
    public List<ParseFormat>? Formats { get; set; }
}
