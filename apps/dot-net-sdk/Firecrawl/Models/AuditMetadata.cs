using System.Text.Json.Serialization;

namespace Firecrawl.Models;

public sealed class AuditMetadata
{
    [JsonPropertyName("username")]
    public required string Username { get; set; }
}
