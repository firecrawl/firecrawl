using System.Text.Json.Serialization;

namespace Firecrawl.Models;

/// <summary>
/// Response from listing agent runs.
/// </summary>
public class AgentListResponse
{
    [JsonPropertyName("success")]
    public bool Success { get; set; }

    [JsonPropertyName("agents")]
    public List<AgentListItem>? Agents { get; set; }

    /// <summary>
    /// Absolute URL of the next page; only present when more pages exist.
    /// </summary>
    [JsonPropertyName("next")]
    public string? Next { get; set; }

    [JsonPropertyName("error")]
    public string? Error { get; set; }
}

/// <summary>
/// A single agent run as returned by the agent list endpoint.
/// </summary>
public class AgentListItem
{
    [JsonPropertyName("id")]
    public string? Id { get; set; }

    [JsonPropertyName("createdAt")]
    public string? CreatedAt { get; set; }

    [JsonPropertyName("targetHint")]
    public string? TargetHint { get; set; }

    [JsonPropertyName("origin")]
    public string? Origin { get; set; }

    [JsonPropertyName("integration")]
    public string? Integration { get; set; }

    [JsonPropertyName("settings")]
    public AgentListItemSettings? Settings { get; set; }

    [JsonPropertyName("status")]
    public string? Status { get; set; }

    [JsonPropertyName("options")]
    public AgentListItemOptions? Options { get; set; }
}

/// <summary>
/// Per-session settings attached to an agent run.
/// </summary>
public class AgentListItemSettings
{
    [JsonPropertyName("hidden")]
    public bool Hidden { get; set; }

    [JsonPropertyName("starred")]
    public bool Starred { get; set; }

    [JsonPropertyName("label")]
    public string? Label { get; set; }
}

/// <summary>
/// Options an agent run was started with.
/// </summary>
public class AgentListItemOptions
{
    [JsonPropertyName("urls")]
    public List<string>? Urls { get; set; }

    [JsonPropertyName("prompt")]
    public string? Prompt { get; set; }

    [JsonPropertyName("schema")]
    public object? Schema { get; set; }

    [JsonPropertyName("model")]
    public string? Model { get; set; }

    /// <summary>
    /// The effort the run used; only present for runs that specified one.
    /// </summary>
    [JsonPropertyName("effort")]
    public string? Effort { get; set; }
}
