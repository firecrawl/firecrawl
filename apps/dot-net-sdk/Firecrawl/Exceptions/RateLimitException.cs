namespace Firecrawl.Exceptions;

/// <summary>
/// Thrown when the API returns a 429 Too Many Requests response.
/// </summary>
public class RateLimitException : FirecrawlException
{
    public RateLimitException(string message, string? errorCode = null, object? details = null)
        : base(message, 429, errorCode, details)
    {
    }
}
