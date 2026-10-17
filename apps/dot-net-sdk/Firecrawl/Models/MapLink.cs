using System.Text.Json;
using System.Text.Json.Serialization;

namespace Firecrawl.Models;

/// <summary>A discovered URL and its optional page metadata.</summary>
[JsonConverter(typeof(MapLinkConverter))]
public class MapLink
{
    public string Url { get; set; } = string.Empty;
    public string? Title { get; set; }
    public string? Description { get; set; }
}

internal sealed class MapLinkConverter : JsonConverter<MapLink>
{
    public override MapLink Read(ref Utf8JsonReader reader, Type typeToConvert, JsonSerializerOptions options)
    {
        if (reader.TokenType == JsonTokenType.String)
            return new MapLink { Url = reader.GetString() ?? string.Empty };

        using var document = JsonDocument.ParseValue(ref reader);
        var item = document.RootElement;
        if (item.ValueKind != JsonValueKind.Object ||
            !item.TryGetProperty("url", out var url) ||
            url.ValueKind != JsonValueKind.String)
            throw new JsonException("Map link must contain a URL");

        return new MapLink
        {
            Url = url.GetString()!,
            Title = item.TryGetProperty("title", out var title) && title.ValueKind == JsonValueKind.String
                ? title.GetString() : null,
            Description = item.TryGetProperty("description", out var description) && description.ValueKind == JsonValueKind.String
                ? description.GetString() : null
        };
    }

    public override void Write(Utf8JsonWriter writer, MapLink value, JsonSerializerOptions options)
    {
        writer.WriteStartObject();
        writer.WriteString("url", value.Url);
        if (value.Title != null) writer.WriteString("title", value.Title);
        if (value.Description != null) writer.WriteString("description", value.Description);
        writer.WriteEndObject();
    }
}
