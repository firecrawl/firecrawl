using System.Text.Json.Serialization;

namespace Firecrawl.Models;

/// <summary>
/// Result of running code or a prompt in a scrape job's browser session.
/// </summary>
public class BrowserExecuteResponse
{
    [JsonPropertyName("success")]
    public bool Success { get; set; }

    /// <summary>
    /// Chrome DevTools Protocol URL for connecting to the browser session.
    /// </summary>
    [JsonPropertyName("cdpUrl")]
    public string? CdpUrl { get; set; }

    [JsonPropertyName("liveViewUrl")]
    public string? LiveViewUrl { get; set; }

    [JsonPropertyName("interactiveLiveViewUrl")]
    public string? InteractiveLiveViewUrl { get; set; }

    /// <summary>
    /// Agent output when a prompt was used.
    /// </summary>
    [JsonPropertyName("output")]
    public string? Output { get; set; }

    [JsonPropertyName("stdout")]
    public string? Stdout { get; set; }

    [JsonPropertyName("result")]
    public string? Result { get; set; }

    [JsonPropertyName("stderr")]
    public string? Stderr { get; set; }

    [JsonPropertyName("exitCode")]
    public int? ExitCode { get; set; }

    /// <summary>
    /// Whether execution was killed by the timeout or the system.
    /// </summary>
    [JsonPropertyName("killed")]
    public bool? Killed { get; set; }

    /// <summary>
    /// Whether the captured output was truncated.
    /// </summary>
    [JsonPropertyName("truncated")]
    public bool? Truncated { get; set; }

    [JsonPropertyName("error")]
    public string? Error { get; set; }
}

/// <summary>
/// Result of stopping a scrape job's browser session.
/// </summary>
public class BrowserDeleteResponse
{
    [JsonPropertyName("success")]
    public bool Success { get; set; }

    [JsonPropertyName("sessionDurationMs")]
    public long? SessionDurationMs { get; set; }

    [JsonPropertyName("creditsBilled")]
    public int? CreditsBilled { get; set; }

    [JsonPropertyName("error")]
    public string? Error { get; set; }
}
