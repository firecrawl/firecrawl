using System.Text.Json;
using System.Text.Json.Serialization;

namespace Firecrawl.Models;

/// <summary>
/// Options for the <c>/v2/parse</c> endpoint.
///
/// <para>
/// Parse does not support browser-rendering formats/options such as change
/// tracking, screenshot, branding, product, menu, actions, waitFor, location, or mobile.
/// These are rejected client-side in <see cref="Validate"/>.
/// </para>
/// </summary>
public class ParseOptions
{
    internal static readonly HashSet<string> UnsupportedFormats = new(StringComparer.OrdinalIgnoreCase)
    {
        "changeTracking",
        "change_tracking",
        "screenshot",
        "screenshot@fullPage",
        "branding",
        "product",
        "menu",
    };

    internal static readonly HashSet<string> SupportedProxies = new(StringComparer.OrdinalIgnoreCase)
    {
        "auto",
        "basic",
    };

    [JsonPropertyName("formats")]
    [JsonIgnore(Condition = JsonIgnoreCondition.WhenWritingNull)]
    public List<object>? Formats { get; set; }

    [JsonPropertyName("headers")]
    [JsonIgnore(Condition = JsonIgnoreCondition.WhenWritingNull)]
    public Dictionary<string, string>? Headers { get; set; }

    [JsonPropertyName("includeTags")]
    [JsonIgnore(Condition = JsonIgnoreCondition.WhenWritingNull)]
    public List<string>? IncludeTags { get; set; }

    [JsonPropertyName("excludeTags")]
    [JsonIgnore(Condition = JsonIgnoreCondition.WhenWritingNull)]
    public List<string>? ExcludeTags { get; set; }

    [JsonPropertyName("onlyMainContent")]
    [JsonIgnore(Condition = JsonIgnoreCondition.WhenWritingNull)]
    public bool? OnlyMainContent { get; set; }

    [JsonPropertyName("timeout")]
    [JsonIgnore(Condition = JsonIgnoreCondition.WhenWritingNull)]
    public int? Timeout { get; set; }

    [JsonPropertyName("parsers")]
    [JsonIgnore(Condition = JsonIgnoreCondition.WhenWritingNull)]
    public List<object>? Parsers { get; set; }

    [JsonPropertyName("skipTlsVerification")]
    [JsonIgnore(Condition = JsonIgnoreCondition.WhenWritingNull)]
    public bool? SkipTlsVerification { get; set; }

    [JsonPropertyName("removeBase64Images")]
    [JsonIgnore(Condition = JsonIgnoreCondition.WhenWritingNull)]
    public bool? RemoveBase64Images { get; set; }

    [JsonPropertyName("blockAds")]
    [JsonIgnore(Condition = JsonIgnoreCondition.WhenWritingNull)]
    public bool? BlockAds { get; set; }

    [JsonPropertyName("proxy")]
    [JsonIgnore(Condition = JsonIgnoreCondition.WhenWritingNull)]
    public string? Proxy { get; set; }

    [JsonPropertyName("integration")]
    [JsonIgnore(Condition = JsonIgnoreCondition.WhenWritingNull)]
    public string? Integration { get; set; }

    [JsonPropertyName("redactPII")]
    [JsonIgnore(Condition = JsonIgnoreCondition.WhenWritingNull)]
    public bool? RedactPII { get; set; }

    /// <summary>
    /// Validate the options against /v2/parse's supported surface.
    /// </summary>
    /// <exception cref="ArgumentException">Thrown when an unsupported format,
    /// proxy, or timeout value is set.</exception>
    public void Validate()
    {
        if (Timeout is not null and <= 0)
            throw new ArgumentException("timeout must be positive", nameof(Timeout));

        if (!string.IsNullOrWhiteSpace(Proxy) && !SupportedProxies.Contains(Proxy))
            throw new ArgumentException(
                "parse only supports proxy values 'basic' or 'auto'", nameof(Proxy));

        if (Formats is { Count: > 0 })
        {
            foreach (var fmt in Formats)
            {
                var type = ExtractFormatType(fmt);
                if (type is not null && UnsupportedFormats.Contains(type))
                    throw new ArgumentException($"parse does not support format: {type}", nameof(Formats));
            }
        }
    }

    private static string? ExtractFormatType(object? format)
    {
        if (format is null)
            return null;

        if (format is string s)
            return s;

        if (format is IDictionary<string, object?> dict &&
            dict.TryGetValue("type", out var typeObj) &&
            typeObj is string ts)
        {
            return ts;
        }

        if (format is JsonElement element)
        {
            if (element.ValueKind == JsonValueKind.String)
                return element.GetString();
            if (element.ValueKind == JsonValueKind.Object &&
                element.TryGetProperty("type", out var typeProp) &&
                typeProp.ValueKind == JsonValueKind.String)
            {
                return typeProp.GetString();
            }
        }

        return null;
    }
}
