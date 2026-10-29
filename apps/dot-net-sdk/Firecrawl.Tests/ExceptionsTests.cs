using Firecrawl.Exceptions;
using Xunit;

namespace Firecrawl.Tests;

public class ExceptionsTests
{
    [Fact]
    public void FirecrawlException_HasMessage()
    {
        var ex = new FirecrawlException("test error");
        Assert.Equal("test error", ex.Message);
    }

    [Fact]
    public void FirecrawlException_HasStatusCode()
    {
        var ex = new FirecrawlException("test error", 500);
        Assert.Equal(500, ex.StatusCode);
    }

    [Fact]
    public void FirecrawlException_HasErrorCode()
    {
        var ex = new FirecrawlException("test error", 400, "INVALID_REQUEST", null);
        Assert.Equal(400, ex.StatusCode);
        Assert.Equal("INVALID_REQUEST", ex.ErrorCode);
    }

    [Fact]
    public void FirecrawlException_HasInnerException()
    {
        var inner = new InvalidOperationException("inner");
        var ex = new FirecrawlException("wrapper", inner);
        Assert.Equal("wrapper", ex.Message);
        Assert.Same(inner, ex.InnerException);
    }

    [Fact]
    public void AuthenticationException_Has401StatusCode()
    {
        var ex = new AuthenticationException("Unauthorized");
        Assert.Equal(401, ex.StatusCode);
    }

    [Fact]
    public void AuthenticationException_HasErrorCode()
    {
        var ex = new AuthenticationException("Unauthorized", "AUTH_FAILED");
        Assert.Equal("AUTH_FAILED", ex.ErrorCode);
    }

    [Fact]
    public void RateLimitException_Has429StatusCode()
    {
        var ex = new RateLimitException("Too many requests");
        Assert.Equal(429, ex.StatusCode);
    }

    [Fact]
    public void JobTimeoutException_HasJobIdAndTimeout()
    {
        var ex = new JobTimeoutException("job-123", 300, "Crawl");
        Assert.Equal("job-123", ex.JobId);
        Assert.Equal(300, ex.TimeoutSeconds);
        Assert.Contains("job-123", ex.Message);
        Assert.Contains("300", ex.Message);
        Assert.Contains("Crawl", ex.Message);
    }
}
