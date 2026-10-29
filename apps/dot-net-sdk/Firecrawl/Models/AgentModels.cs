using System.Text.Json.Serialization;

namespace Firecrawl.Models;

/// <summary>
/// Options for starting an agent job. The prompt is passed separately.
/// </summary>
public class AgentOptions
{
    [JsonPropertyName("urls")]
    [JsonIgnore(Condition = JsonIgnoreCondition.WhenWritingNull)]
    public List<string>? Urls { get; set; }

    /// <summary>
    /// JSON Schema describing the structured output to return.
    /// </summary>
    [JsonPropertyName("schema")]
    [JsonIgnore(Condition = JsonIgnoreCondition.WhenWritingNull)]
    public object? Schema { get; set; }

    [JsonPropertyName("integration")]
    [JsonIgnore(Condition = JsonIgnoreCondition.WhenWritingNull)]
    public string? Integration { get; set; }

    [JsonPropertyName("maxCredits")]
    [JsonIgnore(Condition = JsonIgnoreCondition.WhenWritingNull)]
    public int? MaxCredits { get; set; }

    [JsonPropertyName("strictConstrainToURLs")]
    [JsonIgnore(Condition = JsonIgnoreCondition.WhenWritingNull)]
    public bool? StrictConstrainToURLs { get; set; }

    /// <summary>
    /// Defaults to "spark-2". "spark-1-pro" and "spark-1-mini" are deprecated and run spark-2.
    /// </summary>
    [JsonPropertyName("model")]
    [JsonIgnore(Condition = JsonIgnoreCondition.WhenWritingNull)]
    public string? Model { get; set; }

    /// <summary>
    /// Reasoning effort: "low", "medium", or "high".
    /// </summary>
    [JsonPropertyName("effort")]
    [JsonIgnore(Condition = JsonIgnoreCondition.WhenWritingNull)]
    public string? Effort { get; set; }

    /// <summary>
    /// A webhook URL string or a <see cref="WebhookConfig"/>.
    /// </summary>
    [JsonPropertyName("webhook")]
    [JsonIgnore(Condition = JsonIgnoreCondition.WhenWritingNull)]
    public object? Webhook { get; set; }

    [JsonPropertyName("auditMetadata")]
    [JsonIgnore(Condition = JsonIgnoreCondition.WhenWritingNull)]
    public AuditMetadata? AuditMetadata { get; set; }

    /// <summary>
    /// Continues an existing thread. Omit to start a new one.
    /// </summary>
    [JsonPropertyName("threadId")]
    [JsonIgnore(Condition = JsonIgnoreCondition.WhenWritingNull)]
    public string? ThreadId { get; set; }

    /// <summary>
    /// "extract" or "chat".
    /// </summary>
    [JsonPropertyName("mode")]
    [JsonIgnore(Condition = JsonIgnoreCondition.WhenWritingNull)]
    public string? Mode { get; set; }

    [JsonPropertyName("location")]
    [JsonIgnore(Condition = JsonIgnoreCondition.WhenWritingNull)]
    public AgentLocation? Location { get; set; }

    /// <summary>
    /// Per-request threat protection override, sent as-is (for example <c>new { mode = "normal" }</c>).
    /// </summary>
    [JsonPropertyName("threatProtection")]
    [JsonIgnore(Condition = JsonIgnoreCondition.WhenWritingNull)]
    public object? ThreatProtection { get; set; }

    /// <summary>
    /// Exchange settings (toolkits, maxCalls, requireApproval, approve, decline, onTermsRequired), sent as-is.
    /// </summary>
    [JsonPropertyName("exchange")]
    [JsonIgnore(Condition = JsonIgnoreCondition.WhenWritingNull)]
    public object? Exchange { get; set; }
}

/// <summary>
/// Country for the whole agent run. Scrapes and browser sessions are proxied from it.
/// </summary>
public class AgentLocation
{
    /// <summary>
    /// ISO 3166-1 alpha-2 country code.
    /// </summary>
    [JsonPropertyName("country")]
    public required string Country { get; set; }
}

/// <summary>
/// Response from starting an agent job.
/// </summary>
public class AgentResponse
{
    [JsonPropertyName("success")]
    public bool Success { get; set; }

    [JsonPropertyName("id")]
    public string? Id { get; set; }

    [JsonPropertyName("error")]
    public string? Error { get; set; }

    [JsonPropertyName("threadId")]
    public string? ThreadId { get; set; }

    [JsonPropertyName("threadTurn")]
    public int? ThreadTurn { get; set; }
}

/// <summary>
/// Status and result of an agent job.
/// </summary>
public class AgentStatusResponse
{
    [JsonPropertyName("success")]
    public bool Success { get; set; }

    [JsonPropertyName("status")]
    public string? Status { get; set; }

    [JsonPropertyName("error")]
    public string? Error { get; set; }

    /// <summary>
    /// The result; only set once the job has completed.
    /// </summary>
    [JsonPropertyName("data")]
    public object? Data { get; set; }

    /// <summary>
    /// Best-effort result of a failed job.
    /// </summary>
    [JsonPropertyName("partial")]
    public object? Partial { get; set; }

    [JsonPropertyName("partialSchemaValid")]
    public bool? PartialSchemaValid { get; set; }

    [JsonPropertyName("stopReason")]
    public string? StopReason { get; set; }

    [JsonPropertyName("model")]
    public string? Model { get; set; }

    [JsonPropertyName("effort")]
    public string? Effort { get; set; }

    [JsonPropertyName("expiresAt")]
    public string? ExpiresAt { get; set; }

    [JsonPropertyName("creditsUsed")]
    public int? CreditsUsed { get; set; }

    [JsonPropertyName("threadId")]
    public string? ThreadId { get; set; }

    [JsonPropertyName("threadTurn")]
    public int? ThreadTurn { get; set; }

    [JsonPropertyName("mode")]
    public string? Mode { get; set; }

    /// <summary>
    /// Assistant text reply. Chat-mode runs answer here instead of in <see cref="Data"/>.
    /// </summary>
    [JsonPropertyName("message")]
    public string? Message { get; set; }

    [JsonPropertyName("suggestions")]
    public object? Suggestions { get; set; }

    /// <summary>
    /// Set while the job waits for an approval; it stays "processing" until approved or declined.
    /// </summary>
    [JsonPropertyName("pendingApproval")]
    public object? PendingApproval { get; set; }

    [JsonPropertyName("exchange")]
    public object? Exchange { get; set; }

    /// <summary>
    /// Returns true if the agent job has reached a terminal state.
    /// </summary>
    public bool IsDone =>
        Status == "completed" || Status == "failed" || Status == "cancelled";
}
