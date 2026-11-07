using System.Text.Json;
using System.Text.Json.Serialization;

namespace Firecrawl.Models;

/// <summary>
/// Structured product information extracted via the <c>product</c> scrape format.
/// </summary>
public class ProductProfile
{
    [JsonPropertyName("title")]
    public string Title { get; set; } = string.Empty;

    [JsonPropertyName("brand")]
    [JsonIgnore(Condition = JsonIgnoreCondition.WhenWritingNull)]
    public string? Brand { get; set; }

    [JsonPropertyName("category")]
    [JsonIgnore(Condition = JsonIgnoreCondition.WhenWritingNull)]
    public string? Category { get; set; }

    [JsonPropertyName("url")]
    public string Url { get; set; } = string.Empty;

    [JsonPropertyName("description")]
    [JsonIgnore(Condition = JsonIgnoreCondition.WhenWritingNull)]
    public string? Description { get; set; }

    [JsonPropertyName("variants")]
    [JsonIgnore(Condition = JsonIgnoreCondition.WhenWritingNull)]
    public List<ProductVariant>? Variants { get; set; }
}

/// <summary>
/// An image associated with a product or product variant.
/// </summary>
public class ProductImage
{
    [JsonPropertyName("url")]
    public string Url { get; set; } = string.Empty;

    [JsonPropertyName("alt")]
    [JsonIgnore(Condition = JsonIgnoreCondition.WhenWritingNull)]
    public string? Alt { get; set; }
}

/// <summary>
/// A monetary price for a product or product variant.
/// </summary>
public class ProductPrice
{
    [JsonPropertyName("amount")]
    public double Amount { get; set; }

    [JsonPropertyName("currency")]
    [JsonIgnore(Condition = JsonIgnoreCondition.WhenWritingNull)]
    public string? Currency { get; set; }

    [JsonPropertyName("formatted")]
    [JsonIgnore(Condition = JsonIgnoreCondition.WhenWritingNull)]
    public string? Formatted { get; set; }
}

/// <summary>
/// Availability information for a product or product variant.
/// </summary>
public class ProductAvailability
{
    [JsonPropertyName("inStock")]
    public bool InStock { get; set; }

    [JsonPropertyName("text")]
    [JsonIgnore(Condition = JsonIgnoreCondition.WhenWritingNull)]
    public string? Text { get; set; }
}

/// <summary>
/// A purchasable variant of a product (e.g. a specific size/color combination).
/// </summary>
public class ProductVariant
{
    [JsonPropertyName("id")]
    [JsonIgnore(Condition = JsonIgnoreCondition.WhenWritingNull)]
    public string? Id { get; set; }

    [JsonPropertyName("sku")]
    [JsonIgnore(Condition = JsonIgnoreCondition.WhenWritingNull)]
    public string? Sku { get; set; }

    [JsonPropertyName("title")]
    [JsonIgnore(Condition = JsonIgnoreCondition.WhenWritingNull)]
    public string? Title { get; set; }

    [JsonPropertyName("values")]
    [JsonIgnore(Condition = JsonIgnoreCondition.WhenWritingNull)]
    public Dictionary<string, JsonElement>? Values { get; set; }

    [JsonPropertyName("price")]
    [JsonIgnore(Condition = JsonIgnoreCondition.WhenWritingNull)]
    public ProductPrice? Price { get; set; }

    [JsonPropertyName("sale")]
    [JsonIgnore(Condition = JsonIgnoreCondition.WhenWritingNull)]
    public ProductSale? Sale { get; set; }

    [JsonPropertyName("availability")]
    public ProductAvailability Availability { get; set; } = new();

    [JsonPropertyName("images")]
    [JsonIgnore(Condition = JsonIgnoreCondition.WhenWritingNull)]
    public List<ProductImage>? Images { get; set; }
}

/// <summary>
/// Sale information for a product variant (the price before the current sale).
/// </summary>
public class ProductSale
{
    [JsonPropertyName("originalPrice")]
    public ProductPrice OriginalPrice { get; set; } = new();
}
