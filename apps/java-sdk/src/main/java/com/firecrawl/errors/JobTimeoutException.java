package com.firecrawl.errors;

/**
 * Thrown when an async job (crawl, batch, agent) does not complete within the specified timeout.
 */
public class JobTimeoutException extends FirecrawlException {

    private final String jobId;
    private final int timeoutSeconds;

    public JobTimeoutException(String jobId, int timeoutSeconds, String jobType) {
        super(jobType + " job " + jobId + " did not complete within " + timeoutSeconds + " seconds");
        this.jobId = jobId;
        this.timeoutSeconds = timeoutSeconds;
    }

    /** The ID of the timed-out job. */
    public String getJobId() { return jobId; }

    /** The timeout in seconds that was exceeded. */
    public int getTimeoutSeconds() { return timeoutSeconds; }
}
