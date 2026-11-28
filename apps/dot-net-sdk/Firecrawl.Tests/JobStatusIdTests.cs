using System.Net;
using System.Text;
using Xunit;

namespace Firecrawl.Tests;

public class JobStatusIdTests
{
    [Theory]
    [InlineData("crawl", false)]
    [InlineData("crawl", true)]
    [InlineData("batch", false)]
    [InlineData("batch", true)]
    public async Task StatusWithoutIdKeepsTheKnownJobId(string jobType, bool autoPoll)
    {
        using var handler = new StatusHandler("{\"success\":true,\"status\":\"completed\",\"data\":[]}");
        using var http = new HttpClient(handler);
        var client = new FirecrawlClient("fc-test", "https://api.test", httpClient: http);

        var id = await ReadJobId(client, jobType, autoPoll);

        Assert.Equal("job-started", id);
        Assert.Equal(jobType == "crawl" ? "/v2/crawl/job-started" : "/v2/batch/scrape/job-started",
            handler.StatusPath);
    }

    [Theory]
    [InlineData("crawl")]
    [InlineData("batch")]
    public async Task StatusWithEmptyIdKeepsTheKnownJobId(string jobType)
    {
        using var handler = new StatusHandler("""
            {"success":true,"id":"","status":"completed","data":[]}
            """);
        using var http = new HttpClient(handler);
        var client = new FirecrawlClient("fc-test", "https://api.test", httpClient: http);

        Assert.Equal("job-started", await ReadJobId(client, jobType, autoPoll: true));
    }

    [Theory]
    [InlineData("crawl")]
    [InlineData("batch")]
    public async Task StatusWithIdKeepsTheServerValue(string jobType)
    {
        using var handler = new StatusHandler("{\"success\":true,\"id\":\"job-echoed\",\"status\":\"completed\",\"data\":[]}");
        using var http = new HttpClient(handler);
        var client = new FirecrawlClient("fc-test", "https://api.test", httpClient: http);

        Assert.Equal("job-echoed", await ReadJobId(client, jobType, autoPoll: false));
    }

    private static async Task<string?> ReadJobId(FirecrawlClient client, string jobType, bool autoPoll)
    {
        if (jobType == "crawl")
        {
            var job = autoPoll
                ? await client.CrawlAsync("https://example.com")
                : await client.GetCrawlStatusAsync("job-started");
            return job.Id;
        }

        var batch = autoPoll
            ? await client.BatchScrapeAsync(new List<string> { "https://example.com" })
            : await client.GetBatchScrapeStatusAsync("job-started");
        return batch.Id;
    }

    private sealed class StatusHandler(string statusBody) : HttpMessageHandler
    {
        public string? StatusPath { get; private set; }

        protected override Task<HttpResponseMessage> SendAsync(
            HttpRequestMessage request, CancellationToken cancellationToken)
        {
            const string startBody = "{\"success\":true,\"id\":\"job-started\"}";
            if (request.Method == HttpMethod.Get)
                StatusPath = request.RequestUri?.AbsolutePath;

            return Task.FromResult(new HttpResponseMessage(HttpStatusCode.OK)
            {
                Content = new StringContent(request.Method == HttpMethod.Post ? startBody : statusBody,
                    Encoding.UTF8, "application/json")
            });
        }
    }
}
