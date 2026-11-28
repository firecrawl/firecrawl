using System.Net;
using System.Text;
using System.Text.Json;
using Firecrawl.Exceptions;
using Xunit;

namespace Firecrawl.Tests;

public class ScrapeErrorTests
{
    private sealed class StubHandler : HttpMessageHandler
    {
        private readonly string _body;
        private readonly HttpStatusCode _status;

        public StubHandler(string body, HttpStatusCode status)
        {
            _body = body;
            _status = status;
        }

        protected override Task<HttpResponseMessage> SendAsync(HttpRequestMessage request, CancellationToken cancellationToken)
            => Task.FromResult(new HttpResponseMessage(_status)
            {
                Content = new StringContent(_body, Encoding.UTF8, "application/json"),
            });
    }

    private static FirecrawlClient ClientReturning(string body, HttpStatusCode status = HttpStatusCode.OK)
        => new(apiKey: "fc-test-key", apiUrl: "http://localhost", maxRetries: 0, httpClient: new HttpClient(new StubHandler(body, status)));

    [Fact]
    public async Task ScrapeAsync_ThrowsWithApiErrorOnSuccessFalse()
    {
        var client = ClientReturning(
            "{\"success\":false,\"code\":\"SCRAPE_DNS_RESOLUTION_ERROR\",\"error\":\"DNS resolution failed for hostname \\\"nonexistent.example\\\".\"}");

        var ex = await Assert.ThrowsAsync<FirecrawlException>(() => client.ScrapeAsync("https://nonexistent.example"));

        Assert.Equal(200, ex.StatusCode);
        Assert.Equal("SCRAPE_DNS_RESOLUTION_ERROR", ex.ErrorCode);
        Assert.Equal("DNS resolution failed for hostname \"nonexistent.example\".", ex.Message);
    }

    [Theory]
    [InlineData(HttpStatusCode.BadRequest, typeof(FirecrawlException))]
    [InlineData(HttpStatusCode.Unauthorized, typeof(AuthenticationException))]
    [InlineData(HttpStatusCode.TooManyRequests, typeof(RateLimitException))]
    [InlineData(HttpStatusCode.InternalServerError, typeof(FirecrawlException))]
    public async Task ScrapeAsync_PreservesDetailsOnHttpErrors(HttpStatusCode status, Type exceptionType)
    {
        var client = ClientReturning("""
            {"success":false,"code":"BAD_REQUEST","error":"Bad Request",
             "details":[{"code":"invalid_type","path":["formats",0],"message":"Invalid format"}]}
            """, status);

        var ex = await Assert.ThrowsAnyAsync<FirecrawlException>(() => client.ScrapeAsync("https://example.com"));

        Assert.IsType(exceptionType, ex);
        Assert.Equal((int)status, ex.StatusCode);
        Assert.Equal("BAD_REQUEST", ex.ErrorCode);
        Assert.Equal("Bad Request", ex.Message);
        var details = Assert.IsType<JsonElement>(ex.Details);
        Assert.Equal("formats", details[0].GetProperty("path")[0].GetString());
        Assert.Equal("Invalid format", details[0].GetProperty("message").GetString());
    }

    [Fact]
    public async Task ScrapeAsync_PreservesFallbackMessageWithStructuredError()
    {
        var client = ClientReturning("""
            {"error":{"reason":"invalid"},"message":"Validation failed","code":["BAD_REQUEST"],
             "details":{"field":"url"}}
            """, HttpStatusCode.BadRequest);

        var ex = await Assert.ThrowsAsync<FirecrawlException>(() => client.ScrapeAsync("https://example.com"));

        Assert.Equal("Validation failed", ex.Message);
        Assert.Null(ex.ErrorCode);
        Assert.Equal("url", Assert.IsType<JsonElement>(ex.Details).GetProperty("field").GetString());
    }

    [Fact]
    public async Task ScrapeAsync_PreservesHttpStatusWithNonJsonError()
    {
        var client = ClientReturning("Bad gateway", HttpStatusCode.BadGateway);

        var ex = await Assert.ThrowsAsync<FirecrawlException>(() => client.ScrapeAsync("https://example.com"));

        Assert.Equal(502, ex.StatusCode);
        Assert.Equal("HTTP 502 error", ex.Message);
        Assert.Null(ex.ErrorCode);
        Assert.Null(ex.Details);
    }

    [Fact]
    public async Task ScrapeAsync_ReturnsDocumentOnSuccess()
    {
        var client = ClientReturning("{\"success\":true,\"data\":{\"markdown\":\"# Hello\"}}");

        var doc = await client.ScrapeAsync("https://example.com");

        Assert.Equal("# Hello", doc.Markdown);
    }
}
