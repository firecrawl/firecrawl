package com.firecrawl.errors;

/**
 * Base exception for all Firecrawl SDK errors.
 */
public class FirecrawlException extends RuntimeException {

    private final int statusCode;
    private final String errorCode;
    private final Object details;

    public FirecrawlException(String message) {
        this(message, 0, null, null);
    }

    public FirecrawlException(String message, int statusCode) {
        this(message, statusCode, null, null);
    }

    public FirecrawlException(String message, int statusCode, String errorCode, Object details) {
        super(message);
        this.statusCode = statusCode;
        this.errorCode = errorCode;
        this.details = details;
    }

    public FirecrawlException(String message, Throwable cause) {
        super(message, cause);
        this.statusCode = 0;
        this.errorCode = null;
        this.details = null;
    }

    /** HTTP status code (0 if not an HTTP error). */
    public int getStatusCode() { return statusCode; }

    /** Error code from the API response, if any. */
    public String getErrorCode() { return errorCode; }

    /** Additional error details from the API response, if any. */
    public Object getDetails() { return details; }
}
