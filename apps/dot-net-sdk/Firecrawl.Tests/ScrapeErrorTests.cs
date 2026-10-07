using System.Net;
using System.Text;
using Firecrawl.Exceptions;
using Xunit;

namespace Firecrawl.Tests;

public class ScrapeErrorTests
{
    private sealed class StubHandler : HttpMessageHandler
    {
        private readonly string _body;

        public StubHandler(string body) => _body = body;

        protected override Task<HttpResponseMessage> SendAsync(HttpRequestMessage request, CancellationToken cancellationToken)
            => Task.FromResult(new HttpResponseMessage(HttpStatusCode.OK)
            {
                Content = new StringContent(_body, Encoding.UTF8, "application/json"),
            });
    }

    private static FirecrawlClient ClientReturning(string body)
        => new(apiKey: "fc-test-key", apiUrl: "http://localhost", maxRetries: 0, httpClient: new HttpClient(new StubHandler(body)));

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

    [Fact]
    public async Task ScrapeAsync_ReturnsDocumentOnSuccess()
    {
        var client = ClientReturning("{\"success\":true,\"data\":{\"markdown\":\"# Hello\"}}");

        var doc = await client.ScrapeAsync("https://example.com");

        Assert.Equal("# Hello", doc.Markdown);
    }
}
