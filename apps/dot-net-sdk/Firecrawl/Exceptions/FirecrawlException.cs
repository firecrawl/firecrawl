namespace Firecrawl.Exceptions;

/// <summary>
/// Base exception for all Firecrawl SDK errors.
/// </summary>
public class FirecrawlException : Exception
{
    /// <summary>
    /// HTTP status code (0 if not an HTTP error).
    /// </summary>
    public int StatusCode { get; }

    /// <summary>
    /// Error code returned by the API, if any.
    /// </summary>
    public string? ErrorCode { get; }

    /// <summary>
    /// Additional error details from the API response.
    /// </summary>
    public object? Details { get; }

    public FirecrawlException(string message)
        : base(message)
    {
    }

    public FirecrawlException(string message, int statusCode)
        : base(message)
    {
        StatusCode = statusCode;
    }

    public FirecrawlException(string message, int statusCode, string? errorCode, object? details)
        : base(message)
    {
        StatusCode = statusCode;
        ErrorCode = errorCode;
        Details = details;
    }

    public FirecrawlException(string message, Exception innerException)
        : base(message, innerException)
    {
    }
}
