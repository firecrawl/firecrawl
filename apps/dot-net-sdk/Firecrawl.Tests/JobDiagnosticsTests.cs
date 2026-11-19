using System.Net;
using System.Text;
using System.Text.Json;
using Xunit;

namespace Firecrawl.Tests;

public class JobDiagnosticsTests
{
    [Theory]
    [InlineData("crawl", "failed", "error", "Crawl could not be enqueued")]
    [InlineData("batch", "failed", "error", "Batch could not be enqueued")]
    [InlineData("crawl", "completed", "warning", "Some pages were blocked by robots.txt")]
    [InlineData("batch", "completed", "warning", "Some URLs were blocked by robots.txt")]
    public async Task CompletedWaitReturnsStatusDiagnostics(string jobType, string status, string field, string expected)
    {
        var statusBody = JsonSerializer.Serialize(new Dictionary<string, object>
        {
            ["success"] = status != "failed",
            ["status"] = status,
            [field] = expected,
            ["data"] = Array.Empty<object>()
        });
        using var handler = new JobHandler(statusBody);
        using var http = new HttpClient(handler);
        var client = new FirecrawlClient("fc-test", "https://api.test", httpClient: http);

        var job = jobType == "crawl"
            ? JsonSerializer.SerializeToElement(await client.CrawlAsync("https://example.com"))
            : JsonSerializer.SerializeToElement(await client.BatchScrapeAsync(new List<string> { "https://example.com" }));

        Assert.Equal(status, job.GetProperty("status").GetString());
        Assert.True(job.TryGetProperty(field, out var diagnostic));
        Assert.Equal(expected, diagnostic.GetString());
    }

    private sealed class JobHandler(string statusBody) : HttpMessageHandler
    {
        protected override Task<HttpResponseMessage> SendAsync(
            HttpRequestMessage request, CancellationToken cancellationToken)
        {
            const string startBody = "{\"success\":true,\"id\":\"job-started\"}";
            return Task.FromResult(new HttpResponseMessage(HttpStatusCode.OK)
            {
                Content = new StringContent(request.Method == HttpMethod.Post ? startBody : statusBody,
                    Encoding.UTF8, "application/json")
            });
        }
    }
}
