using System.Net;
using System.Text;
using Firecrawl.Exceptions;
using Xunit;

namespace Firecrawl.Tests;

public class RetrySafetyTests
{
    [Theory]
    [InlineData("post")]
    [InlineData("multipart")]
    [InlineData("patch")]
    [InlineData("delete")]
    public async Task AmbiguousGatewayFailure_DoesNotReplayWrite(string method)
    {
        var handler = new ScriptedHandler((attempt, _) =>
            JsonResponse(attempt == 1 ? HttpStatusCode.BadGateway : HttpStatusCode.OK));
        var client = Client(handler);

        await Assert.ThrowsAsync<FirecrawlException>(() => SendWrite(client, method));
        Assert.Equal(1, handler.SendCount);
    }

    [Theory]
    [InlineData("post")]
    [InlineData("multipart")]
    [InlineData("patch")]
    [InlineData("delete")]
    public async Task TransportFailure_DoesNotReplayWrite(string method)
    {
        var handler = new ScriptedHandler((attempt, _) =>
            attempt == 1
                ? throw new HttpRequestException("Connection reset after send")
                : JsonResponse(HttpStatusCode.OK));
        var client = Client(handler);

        await Assert.ThrowsAsync<FirecrawlException>(() => SendWrite(client, method));
        Assert.Equal(1, handler.SendCount);
    }

    [Fact]
    public async Task GatewayFailure_StillRetriesRead()
    {
        var handler = new ScriptedHandler((attempt, _) =>
            JsonResponse(attempt == 1 ? HttpStatusCode.BadGateway : HttpStatusCode.OK));
        var client = Client(handler);

        await client.GetAsync<Dictionary<string, object>>("/v2/crawl/job");
        Assert.Equal(2, handler.SendCount);
    }

    private static FirecrawlHttpClient Client(ScriptedHandler handler) =>
        new("fc-test", "https://api.test", TimeSpan.FromSeconds(5),
            maxRetries: 1, backoffFactor: 0, httpClient: new HttpClient(handler));

    private static Task<Dictionary<string, object>> SendWrite(
        FirecrawlHttpClient client, string method) => method switch
        {
            "post" => client.PostAsync<Dictionary<string, object>>("/v2/crawl", new { url = "https://example.com" }),
            "multipart" => client.PostMultipartAsync<Dictionary<string, object>>(
                "/v2/parse", new Dictionary<string, string>(), "file", "page.html",
                "text/html", Encoding.UTF8.GetBytes("<html></html>")),
            "patch" => client.PatchAsync<Dictionary<string, object>>("/v2/monitor/id", new { enabled = true }),
            "delete" => client.DeleteAsync<Dictionary<string, object>>("/v2/monitor/id"),
            _ => throw new ArgumentOutOfRangeException(nameof(method))
        };

    private static HttpResponseMessage JsonResponse(HttpStatusCode status) =>
        new(status)
        {
            Content = new StringContent(
                status == HttpStatusCode.OK ? "{}" : "{\"error\":\"upstream failure\"}",
                Encoding.UTF8, "application/json")
        };

    private sealed class ScriptedHandler(
        Func<int, HttpRequestMessage, HttpResponseMessage> respond) : HttpMessageHandler
    {
        public int SendCount { get; private set; }

        protected override Task<HttpResponseMessage> SendAsync(
            HttpRequestMessage request, CancellationToken cancellationToken) =>
            Task.FromResult(respond(++SendCount, request));
    }
}
