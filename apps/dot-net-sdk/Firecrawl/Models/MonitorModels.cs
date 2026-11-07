using System.Text.Json.Serialization;

namespace Firecrawl.Models;

public class MonitorSchedule
{
    [JsonPropertyName("cron")]
    public string? Cron { get; set; }

    [JsonPropertyName("timezone")]
    public string? Timezone { get; set; }
}

public class CreateMonitorRequest
{
    [JsonPropertyName("name")]
    public string? Name { get; set; }

    [JsonPropertyName("schedule")]
    public MonitorSchedule? Schedule { get; set; }

    [JsonPropertyName("targets")]
    public List<Dictionary<string, object>>? Targets { get; set; }

    [JsonPropertyName("webhook")]
    public Dictionary<string, object>? Webhook { get; set; }

    [JsonPropertyName("notification")]
    public Dictionary<string, object>? Notification { get; set; }

    [JsonPropertyName("retentionDays")]
    public int? RetentionDays { get; set; }

    /// <summary>
    /// Optional natural-language description of what the monitor is
    /// watching for (max 2000 chars). When <see cref="Goal"/> is set
    /// and <see cref="JudgeEnabled"/> is left null, the API
    /// automatically enables judging for this monitor.
    /// </summary>
    [JsonPropertyName("goal")]
    public string? Goal { get; set; }

    [JsonPropertyName("judgeEnabled")]
    public bool? JudgeEnabled { get; set; }
}

public class UpdateMonitorRequest
{
    [JsonPropertyName("name")]
    public string? Name { get; set; }

    [JsonPropertyName("status")]
    public string? Status { get; set; }

    [JsonPropertyName("schedule")]
    public MonitorSchedule? Schedule { get; set; }

    [JsonPropertyName("targets")]
    public List<Dictionary<string, object>>? Targets { get; set; }

    [JsonPropertyName("webhook")]
    public Dictionary<string, object>? Webhook { get; set; }

    [JsonPropertyName("notification")]
    public Dictionary<string, object>? Notification { get; set; }

    [JsonPropertyName("retentionDays")]
    public int? RetentionDays { get; set; }

    /// <summary>
    /// Same semantics as on <see cref="CreateMonitorRequest"/>; leave
    /// null to keep the existing values.
    /// </summary>
    [JsonPropertyName("goal")]
    public string? Goal { get; set; }

    [JsonPropertyName("judgeEnabled")]
    public bool? JudgeEnabled { get; set; }
}

/// <summary>
/// Strongly-typed representation of a search target stored on a monitor
/// (<c>type</c> = <c>"search"</c>), alongside the scrape and crawl targets.
/// Monitor request/response models expose targets as untyped
/// <see cref="Dictionary{TKey, TValue}"/> entries; use this type to build a
/// search target and re-serialize it into that dictionary shape, or to
/// re-deserialize a target entry when its <c>type</c> is <c>"search"</c>.
/// </summary>
public class MonitorSearchTarget
{
    [JsonPropertyName("id")]
    public string? Id { get; set; }

    [JsonPropertyName("type")]
    public string Type { get; set; } = "search";

    [JsonPropertyName("queries")]
    public List<string> Queries { get; set; } = new();

    /// <summary>One of <c>5m</c>, <c>15m</c>, <c>1h</c>, <c>6h</c>, <c>24h</c>, <c>7d</c>.</summary>
    [JsonPropertyName("searchWindow")]
    public string? SearchWindow { get; set; }

    [JsonPropertyName("includeDomains")]
    public List<string>? IncludeDomains { get; set; }

    [JsonPropertyName("excludeDomains")]
    public List<string>? ExcludeDomains { get; set; }

    [JsonPropertyName("maxResults")]
    public int? MaxResults { get; set; }
}

/// <summary>
/// Strongly-typed per-target result for a search target (<c>type</c> =
/// <c>"search"</c>) on a monitor check, alongside the scrape and crawl
/// target results. Monitor checks expose <c>targetResults</c> as an
/// untyped <see cref="object"/>; re-deserialize an entry into this type
/// when its <c>type</c> is <c>"search"</c>.
/// </summary>
public class MonitorSearchTargetResult
{
    [JsonPropertyName("targetId")]
    public string? TargetId { get; set; }

    [JsonPropertyName("type")]
    public string Type { get; set; } = "search";

    [JsonPropertyName("searchCompleted")]
    public bool? SearchCompleted { get; set; }

    [JsonPropertyName("resultCount")]
    public int? ResultCount { get; set; }

    [JsonPropertyName("matches")]
    public int? Matches { get; set; }

    [JsonPropertyName("summary")]
    public string? Summary { get; set; }

    [JsonPropertyName("judgeDegraded")]
    public bool? JudgeDegraded { get; set; }

    [JsonPropertyName("degradedReason")]
    public string? DegradedReason { get; set; }

    [JsonPropertyName("searchCredits")]
    public double? SearchCredits { get; set; }

    [JsonPropertyName("judgeCredits")]
    public double? JudgeCredits { get; set; }

    [JsonPropertyName("resultsJudged")]
    public int? ResultsJudged { get; set; }
}

public class MonitorSummary
{
    [JsonPropertyName("totalPages")]
    public int TotalPages { get; set; }

    [JsonPropertyName("same")]
    public int Same { get; set; }

    [JsonPropertyName("changed")]
    public int Changed { get; set; }

    [JsonPropertyName("new")]
    public int New { get; set; }

    [JsonPropertyName("removed")]
    public int Removed { get; set; }

    [JsonPropertyName("error")]
    public int Error { get; set; }
}

public class Monitor
{
    [JsonPropertyName("id")]
    public string? Id { get; set; }

    [JsonPropertyName("name")]
    public string? Name { get; set; }

    [JsonPropertyName("status")]
    public string? Status { get; set; }

    [JsonPropertyName("schedule")]
    public MonitorSchedule? Schedule { get; set; }

    [JsonPropertyName("nextRunAt")]
    public string? NextRunAt { get; set; }

    [JsonPropertyName("lastRunAt")]
    public string? LastRunAt { get; set; }

    [JsonPropertyName("currentCheckId")]
    public string? CurrentCheckId { get; set; }

    [JsonPropertyName("targets")]
    public List<Dictionary<string, object>>? Targets { get; set; }

    [JsonPropertyName("webhook")]
    public Dictionary<string, object>? Webhook { get; set; }

    [JsonPropertyName("notification")]
    public Dictionary<string, object>? Notification { get; set; }

    [JsonPropertyName("retentionDays")]
    public int RetentionDays { get; set; }

    [JsonPropertyName("estimatedCreditsPerMonth")]
    public int? EstimatedCreditsPerMonth { get; set; }

    [JsonPropertyName("lastCheckSummary")]
    public MonitorSummary? LastCheckSummary { get; set; }

    [JsonPropertyName("goal")]
    public string? Goal { get; set; }

    [JsonPropertyName("judgeEnabled")]
    public bool JudgeEnabled { get; set; }

    [JsonPropertyName("createdAt")]
    public string? CreatedAt { get; set; }

    [JsonPropertyName("updatedAt")]
    public string? UpdatedAt { get; set; }
}

public class MonitorCheck
{
    [JsonPropertyName("id")]
    public string? Id { get; set; }

    [JsonPropertyName("monitorId")]
    public string? MonitorId { get; set; }

    [JsonPropertyName("status")]
    public string? Status { get; set; }

    [JsonPropertyName("trigger")]
    public string? Trigger { get; set; }

    [JsonPropertyName("scheduledFor")]
    public string? ScheduledFor { get; set; }

    [JsonPropertyName("startedAt")]
    public string? StartedAt { get; set; }

    [JsonPropertyName("finishedAt")]
    public string? FinishedAt { get; set; }

    [JsonPropertyName("estimatedCredits")]
    public int? EstimatedCredits { get; set; }

    [JsonPropertyName("reservedCredits")]
    public int? ReservedCredits { get; set; }

    [JsonPropertyName("actualCredits")]
    public int? ActualCredits { get; set; }

    [JsonPropertyName("billingStatus")]
    public string? BillingStatus { get; set; }

    [JsonPropertyName("summary")]
    public MonitorSummary? Summary { get; set; }

    [JsonPropertyName("targetResults")]
    public object? TargetResults { get; set; }

    [JsonPropertyName("notificationStatus")]
    public object? NotificationStatus { get; set; }

    [JsonPropertyName("error")]
    public string? Error { get; set; }

    [JsonPropertyName("createdAt")]
    public string? CreatedAt { get; set; }

    [JsonPropertyName("updatedAt")]
    public string? UpdatedAt { get; set; }
}

/// <summary>
/// Per-field diff entry returned for monitors that requested JSON
/// extraction. The keys on <see cref="MonitorPageDiff.Json"/> (when used
/// in JSON or mixed mode) are field paths in the extracted JSON; the
/// values describe what changed between the previous and current run.
/// </summary>
public class MonitorJsonFieldDiff
{
    [JsonPropertyName("previous")]
    public object? Previous { get; set; }

    [JsonPropertyName("current")]
    public object? Current { get; set; }
}

/// <summary>
/// Diff payload returned alongside a monitor page when its scrape
/// produced a change. The shape depends on what the monitor's formats
/// asked for:
/// <list type="bullet">
///   <item>Markdown-only monitors: <see cref="Text"/> holds the unified
///   diff and <see cref="Json"/> holds the parseDiff AST
///   (<c>{ "files": [...] }</c>).</item>
///   <item>JSON-extraction monitors: <see cref="Json"/> holds the
///   per-field <see cref="MonitorJsonFieldDiff"/> map and
///   <see cref="Text"/> is null.</item>
///   <item>Mixed (JSON + git-diff) monitors: both fields are populated:
///   <see cref="Json"/> is the per-field diff and <see cref="Text"/>
///   is the markdown sidecar.</item>
/// </list>
/// <see cref="Json"/> is exposed as <see cref="object"/> because its
/// concrete shape depends on the monitor mode; callers should
/// re-deserialize with <c>System.Text.Json</c> into either a
/// <c>Dictionary&lt;string, MonitorJsonFieldDiff&gt;</c> (JSON / mixed
/// mode) or a wrapper containing the <c>files</c> array (markdown mode).
/// </summary>
public class MonitorPageDiff
{
    [JsonPropertyName("text")]
    public string? Text { get; set; }

    [JsonPropertyName("json")]
    public object? Json { get; set; }
}

/// <summary>
/// Snapshot of the current JSON extraction at this run. Present on JSON
/// and mixed-mode monitors; absent for markdown-only monitors.
/// </summary>
public class MonitorPageSnapshot
{
    [JsonPropertyName("json")]
    public Dictionary<string, object>? Json { get; set; }
}

/// <summary>
/// Judge's verdict on whether a monitor page change is meaningful.
/// Populated on monitor check pages when the monitor has a
/// <c>goal</c> set and judging is enabled.
/// </summary>
public class MonitorPageJudgment
{
    [JsonPropertyName("meaningful")]
    public bool Meaningful { get; set; }

    /// <summary>One of <c>high</c>, <c>medium</c>, <c>low</c>.</summary>
    [JsonPropertyName("confidence")]
    public string? Confidence { get; set; }

    [JsonPropertyName("reason")]
    public string? Reason { get; set; }

    [JsonPropertyName("fields")]
    public List<string>? Fields { get; set; }
}

public class MonitorCheckPage
{
    [JsonPropertyName("id")]
    public string? Id { get; set; }

    [JsonPropertyName("targetId")]
    public string? TargetId { get; set; }

    [JsonPropertyName("url")]
    public string? Url { get; set; }

    [JsonPropertyName("status")]
    public string? Status { get; set; }

    [JsonPropertyName("previousScrapeId")]
    public string? PreviousScrapeId { get; set; }

    [JsonPropertyName("currentScrapeId")]
    public string? CurrentScrapeId { get; set; }

    [JsonPropertyName("statusCode")]
    public int? StatusCode { get; set; }

    [JsonPropertyName("error")]
    public string? Error { get; set; }

    [JsonPropertyName("metadata")]
    public object? Metadata { get; set; }

    [JsonPropertyName("diff")]
    public MonitorPageDiff? Diff { get; set; }

    [JsonPropertyName("snapshot")]
    public MonitorPageSnapshot? Snapshot { get; set; }

    [JsonPropertyName("judgment")]
    public MonitorPageJudgment? Judgment { get; set; }

    [JsonPropertyName("createdAt")]
    public string? CreatedAt { get; set; }
}

public class MonitorCheckDetail : MonitorCheck
{
    [JsonPropertyName("pages")]
    public List<MonitorCheckPage>? Pages { get; set; }

    [JsonPropertyName("next")]
    public string? Next { get; set; }
}
