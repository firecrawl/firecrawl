using System.Net;
using System.Text;
using Firecrawl.Exceptions;
using Xunit;

namespace Firecrawl.Tests;

public class JobPollingTimeoutTests
{
    [Theory]
    [InlineData("crawl")]
    [InlineData("batch")]
    [InlineData("agent")]
    public async Task WaiterDoesNotSleepForTheFullPollInterval(string jobType)
    {
        using var handler = new JobHandler("scraping");
        using var http = new HttpClient(handler);
        using var testTimeout = new CancellationTokenSource(TimeSpan.FromSeconds(5));
        var client = new FirecrawlClient("fc-test", "https://api.test", httpClient: http);

        var error = await Assert.ThrowsAsync<JobTimeoutException>(
            () => StartAndWait(client, jobType, 1, testTimeout.Token));

        Assert.Equal("job-test", error.JobId);
        Assert.Equal(1, error.TimeoutSeconds);
        Assert.Equal(1, handler.StatusRequests);
    }

    [Theory]
    [InlineData("crawl")]
    [InlineData("batch")]
    [InlineData("agent")]
    public async Task WaiterReturnsACompletedJobBeforeThePollInterval(string jobType)
    {
        using var handler = new JobHandler("completed");
        using var http = new HttpClient(handler);
        var client = new FirecrawlClient("fc-test", "https://api.test", httpClient: http);

        await StartAndWait(client, jobType, 5, CancellationToken.None);

        Assert.Equal(1, handler.StatusRequests);
    }

    private static Task StartAndWait(
        FirecrawlClient client, string jobType, int timeoutSec, CancellationToken cancellationToken)
    {
        const int pollIntervalSec = 60;
        return jobType switch
        {
            "crawl" => client.CrawlAsync("https://example.com", pollIntervalSec: pollIntervalSec,
                timeoutSec: timeoutSec, cancellationToken: cancellationToken),
            "batch" => client.BatchScrapeAsync(new List<string> { "https://example.com" },
                pollIntervalSec: pollIntervalSec, timeoutSec: timeoutSec, cancellationToken: cancellationToken),
            "agent" => client.AgentAsync("Summarize the page", pollIntervalSec: pollIntervalSec,
                timeoutSec: timeoutSec, cancellationToken: cancellationToken),
            _ => throw new ArgumentOutOfRangeException(nameof(jobType))
        };
    }

    private sealed class JobHandler(string status) : HttpMessageHandler
    {
        public int StatusRequests { get; private set; }

        protected override Task<HttpResponseMessage> SendAsync(
            HttpRequestMessage request, CancellationToken cancellationToken)
        {
            string body;
            if (request.Method == HttpMethod.Post)
            {
                body = "{\"success\":true,\"id\":\"job-test\"}";
            }
            else
            {
                Assert.Equal(HttpMethod.Get, request.Method);
                StatusRequests++;
                body = $"{{\"success\":true,\"status\":\"{status}\"}}";
            }

            return Task.FromResult(new HttpResponseMessage(HttpStatusCode.OK)
            {
                Content = new StringContent(body, Encoding.UTF8, "application/json")
            });
        }
    }
}
