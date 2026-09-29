using System.Net;
using System.Text;
using Firecrawl.Exceptions;
using Xunit;

namespace Firecrawl.Tests;

public class PaginationCycleTests
{
    [Theory]
    [InlineData("crawl")]
    [InlineData("batch")]
    [InlineData("monitor")]
    public async Task RepeatedNextUrl_StopsBeforeRefetchingPage(string kind)
    {
        var handler = new RepeatedPageHandler(kind);
        using var httpClient = new HttpClient(handler);
        var client = new FirecrawlClient(
            apiKey: "fc-test",
            apiUrl: "https://api.test",
            maxRetries: 0,
            httpClient: httpClient);

        async Task Run()
        {
            if (kind == "crawl")
                await client.CrawlAsync("https://example.com", pollIntervalSec: 0, timeoutSec: 5);
            else if (kind == "batch")
                await client.BatchScrapeAsync(new List<string> { "https://example.com" },
                    pollIntervalSec: 0, timeoutSec: 5);
            else
                await client.GetMonitorCheckAsync("monitor", "check");
        }

        var error = await Assert.ThrowsAsync<FirecrawlException>(Run);
        Assert.Contains("repeated pagination URL", error.Message);
        Assert.Equal(1, handler.PageRequests);
    }

    private sealed class RepeatedPageHandler(string kind) : HttpMessageHandler
    {
        public int PageRequests { get; private set; }

        protected override Task<HttpResponseMessage> SendAsync(
            HttpRequestMessage request, CancellationToken cancellationToken)
        {
            const string next = "https://api.test/next?cursor=repeat";
            var isPage = request.RequestUri?.AbsoluteUri == next;
            if (isPage && ++PageRequests > 1)
                throw new InvalidOperationException("Repeated cursor was fetched again");

            string body;
            if (request.Method == HttpMethod.Post)
                body = "{\"success\":true,\"id\":\"job\"}";
            else if (kind == "monitor")
                body = "{\"success\":true,\"data\":{\"id\":\"check\",\"next\":\"" + next + "\",\"pages\":[]}}";
            else
                body = "{\"status\":\"completed\",\"next\":\"" + next + "\",\"data\":[]}";

            return Task.FromResult(new HttpResponseMessage(HttpStatusCode.OK)
            {
                Content = new StringContent(body, Encoding.UTF8, "application/json")
            });
        }
    }
}
