using System.Text.Json.Serialization;

namespace Firecrawl.Models;

/// <summary>
/// Internal wrapper for API responses that contain a "data" field.
/// </summary>
internal class ApiResponse<T>
{
    [JsonPropertyName("success")]
    public bool Success { get; set; }

    [JsonPropertyName("data")]
    public T? Data { get; set; }

    [JsonPropertyName("error")]
    public string? Error { get; set; }

    [JsonPropertyName("code")]
    public string? Code { get; set; }

    [JsonPropertyName("details")]
    public object? Details { get; set; }
}
