namespace Firecrawl.Exceptions;

/// <summary>
/// Thrown when an async job (crawl, batch scrape, agent) does not complete within the specified timeout.
/// </summary>
public class JobTimeoutException : FirecrawlException
{
    /// <summary>
    /// The ID of the job that timed out.
    /// </summary>
    public string JobId { get; }

    /// <summary>
    /// The timeout in seconds that was exceeded.
    /// </summary>
    public int TimeoutSeconds { get; }

    public JobTimeoutException(string jobId, int timeoutSeconds, string jobType)
        : base($"{jobType} job {jobId} did not complete within {timeoutSeconds} seconds")
    {
        JobId = jobId;
        TimeoutSeconds = timeoutSeconds;
    }
}
