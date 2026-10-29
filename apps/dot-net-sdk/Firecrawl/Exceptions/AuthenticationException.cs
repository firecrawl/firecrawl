namespace Firecrawl.Exceptions;

/// <summary>
/// Thrown when the API returns a 401 Unauthorized response.
/// </summary>
public class AuthenticationException : FirecrawlException
{
    public AuthenticationException(string message, string? errorCode = null, object? details = null)
        : base(message, 401, errorCode, details)
    {
    }
}
