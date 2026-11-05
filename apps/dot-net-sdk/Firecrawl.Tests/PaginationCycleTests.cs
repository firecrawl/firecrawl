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

    [Theory]
    [InlineData("crawl")]
    [InlineData("batch")]
    [InlineData("monitor")]
    public async Task ProgressingNextUrls_FetchEveryPageAndComplete(string kind)
    {
        var handler = new ProgressingPageHandler(kind);
        using var httpClient = new HttpClient(handler);
        var client = new FirecrawlClient(
            apiKey: "fc-test",
            apiUrl: "https://api.test",
            maxRetries: 0,
            httpClient: httpClient);

        if (kind == "crawl")
            Assert.Null((await client.CrawlAsync("https://example.com",
                pollIntervalSec: 0, timeoutSec: 5)).Next);
        else if (kind == "batch")
            Assert.Null((await client.BatchScrapeAsync(new List<string> { "https://example.com" },
                pollIntervalSec: 0, timeoutSec: 5)).Next);
        else
            Assert.Null((await client.GetMonitorCheckAsync("monitor", "check")).Next);

        Assert.Equal(2, handler.PageRequests);
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

    private sealed class ProgressingPageHandler(string kind) : HttpMessageHandler
    {
        public int PageRequests { get; private set; }

        protected override Task<HttpResponseMessage> SendAsync(
            HttpRequestMessage request, CancellationToken cancellationToken)
        {
            const string first = "https://api.test/next?cursor=first";
            const string second = "https://api.test/next?cursor=second";
            var url = request.RequestUri?.AbsoluteUri;
            if (url == first || url == second)
                PageRequests++;

            var next = url == first ? second : url == second ? null : first;
            var nextField = next == null ? "" : ",\"next\":\"" + next + "\"";
            string body;
            if (request.Method == HttpMethod.Post)
                body = "{\"success\":true,\"id\":\"job\"}";
            else if (kind == "monitor")
                body = "{\"success\":true,\"data\":{\"id\":\"check\",\"pages\":[]" + nextField + "}}";
            else
                body = "{\"status\":\"completed\",\"data\":[]" + nextField + "}";

            return Task.FromResult(new HttpResponseMessage(HttpStatusCode.OK)
            {
                Content = new StringContent(body, Encoding.UTF8, "application/json")
            });
        }
    }
}
