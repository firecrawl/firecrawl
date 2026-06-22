using System.Text.Json;
using System.Text.Json.Serialization;

namespace Firecrawl.Models;

/// <summary>
/// Structured menu information extracted via the <c>menu</c> scrape format.
/// </summary>
public class MenuProfile
{
    [JsonPropertyName("isMenu")]
    public bool IsMenu { get; set; }

    [JsonPropertyName("confidence")]
    public double Confidence { get; set; }

    [JsonPropertyName("merchant")]
    public MenuMerchant Merchant { get; set; } = new();

    [JsonPropertyName("currency")]
    [JsonIgnore(Condition = JsonIgnoreCondition.WhenWritingNull)]
    public string? Currency { get; set; }

    [JsonPropertyName("sections")]
    public List<MenuSection> Sections { get; set; } = new();

    [JsonPropertyName("sourceUrl")]
    public string SourceUrl { get; set; } = string.Empty;
}

/// <summary>
/// The merchant a menu belongs to.
/// </summary>
public class MenuMerchant
{
    [JsonPropertyName("name")]
    public string Name { get; set; } = string.Empty;

    [JsonPropertyName("type")]
    [JsonIgnore(Condition = JsonIgnoreCondition.WhenWritingNull)]
    public string? Type { get; set; }

    [JsonPropertyName("location")]
    [JsonIgnore(Condition = JsonIgnoreCondition.WhenWritingNull)]
    public JsonElement? Location { get; set; }
}

/// <summary>
/// An ordered section of a menu (e.g. "Appetizers"), holding items.
/// </summary>
public class MenuSection
{
    [JsonPropertyName("id")]
    public string Id { get; set; } = string.Empty;

    [JsonPropertyName("name")]
    public string Name { get; set; } = string.Empty;

    [JsonPropertyName("description")]
    [JsonIgnore(Condition = JsonIgnoreCondition.WhenWritingNull)]
    public string? Description { get; set; }

    [JsonPropertyName("items")]
    public List<MenuItem> Items { get; set; } = new();
}

/// <summary>
/// A single item on a menu, with its own pricing, availability, and images.
/// </summary>
public class MenuItem
{
    [JsonPropertyName("id")]
    public string Id { get; set; } = string.Empty;

    [JsonPropertyName("name")]
    public string Name { get; set; } = string.Empty;

    [JsonPropertyName("description")]
    [JsonIgnore(Condition = JsonIgnoreCondition.WhenWritingNull)]
    public string? Description { get; set; }

    [JsonPropertyName("images")]
    public List<MenuImage> Images { get; set; } = new();

    [JsonPropertyName("price")]
    [JsonIgnore(Condition = JsonIgnoreCondition.WhenWritingNull)]
    public MenuPrice? Price { get; set; }

    [JsonPropertyName("availability")]
    public MenuAvailability Availability { get; set; } = new();

    [JsonPropertyName("dietary")]
    public List<string> Dietary { get; set; } = new();

    [JsonPropertyName("calories")]
    [JsonIgnore(Condition = JsonIgnoreCondition.WhenWritingNull)]
    public double? Calories { get; set; }

    [JsonPropertyName("optionGroups")]
    public List<object> OptionGroups { get; set; } = new();

    [JsonPropertyName("identifiers")]
    public MenuItemIdentifiers Identifiers { get; set; } = new();

    [JsonPropertyName("url")]
    [JsonIgnore(Condition = JsonIgnoreCondition.WhenWritingNull)]
    public string? Url { get; set; }

    [JsonPropertyName("sourceUrl")]
    public string SourceUrl { get; set; } = string.Empty;
}

/// <summary>
/// An image associated with a menu item.
/// </summary>
public class MenuImage
{
    [JsonPropertyName("url")]
    public string Url { get; set; } = string.Empty;

    [JsonPropertyName("alt")]
    [JsonIgnore(Condition = JsonIgnoreCondition.WhenWritingNull)]
    public string? Alt { get; set; }
}

/// <summary>
/// A monetary price for a menu item.
/// </summary>
public class MenuPrice
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
/// Availability information for a menu item.
/// </summary>
public class MenuAvailability
{
    [JsonPropertyName("inStock")]
    public bool InStock { get; set; }

    [JsonPropertyName("text")]
    [JsonIgnore(Condition = JsonIgnoreCondition.WhenWritingNull)]
    public string? Text { get; set; }
}

/// <summary>
/// External identifiers for a menu item.
/// </summary>
public class MenuItemIdentifiers
{
    [JsonPropertyName("merchantItemId")]
    [JsonIgnore(Condition = JsonIgnoreCondition.WhenWritingNull)]
    public string? MerchantItemId { get; set; }
}
