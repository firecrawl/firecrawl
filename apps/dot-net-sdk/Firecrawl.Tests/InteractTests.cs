using System.Net;
using System.Text;
using System.Text.Json;
using Xunit;

namespace Firecrawl.Tests;

public class InteractTests
{
    private sealed class StubHandler : HttpMessageHandler
    {
        private readonly string _body;

        public StubHandler(string body) => _body = body;

        public HttpRequestMessage? Request { get; private set; }

        public string? RequestBody { get; private set; }

        protected override async Task<HttpResponseMessage> SendAsync(HttpRequestMessage request, CancellationToken cancellationToken)
        {
            Request = request;
            RequestBody = request.Content is null ? null : await request.Content.ReadAsStringAsync(cancellationToken);
            return new HttpResponseMessage(HttpStatusCode.OK)
            {
                Content = new StringContent(_body, Encoding.UTF8, "application/json"),
            };
        }
    }

    private static FirecrawlClient ClientFor(StubHandler handler) =>
        new(apiKey: "fc-test-key", apiUrl: "http://localhost", maxRetries: 0, httpClient: new HttpClient(handler));

    [Fact]
    public async Task InteractAsync_PostsCodeAndReadsOutput()
    {
        var handler = new StubHandler(
            "{\"success\":true,\"stdout\":\"Example Domain\\n\",\"result\":\"\",\"stderr\":\"\",\"exitCode\":0,\"killed\":false,\"truncated\":false,\"cdpUrl\":\"wss://browser.example/cdp\"}");
        var client = ClientFor(handler);

        var response = await client.InteractAsync("job-123", "console.log(await page.title())", timeout: 60);

        Assert.True(response.Success);
        Assert.Equal("Example Domain\n", response.Stdout);
        Assert.Equal(0, response.ExitCode);
        Assert.False(response.Killed);
        Assert.False(response.Truncated);
        Assert.Equal("wss://browser.example/cdp", response.CdpUrl);

        Assert.Equal(HttpMethod.Post, handler.Request!.Method);
        Assert.Equal("http://localhost/v2/scrape/job-123/interact", handler.Request.RequestUri!.ToString());
        using var body = JsonDocument.Parse(handler.RequestBody!);
        var root = body.RootElement;
        Assert.Equal("console.log(await page.title())", root.GetProperty("code").GetString());
        Assert.Equal("node", root.GetProperty("language").GetString());
        Assert.Equal(60, root.GetProperty("timeout").GetInt32());
        Assert.StartsWith("dotnet-sdk@", root.GetProperty("origin").GetString());
        Assert.False(root.TryGetProperty("prompt", out _));
    }

    [Fact]
    public async Task InteractAsync_SendsPromptWithoutCode()
    {
        var handler = new StubHandler("{\"success\":true,\"output\":\"Clicked the button\"}");
        var client = ClientFor(handler);

        var response = await client.InteractAsync("job-123", null, prompt: "Click the first button");

        Assert.Equal("Clicked the button", response.Output);
        using var body = JsonDocument.Parse(handler.RequestBody!);
        Assert.Equal("Click the first button", body.RootElement.GetProperty("prompt").GetString());
        Assert.False(body.RootElement.TryGetProperty("code", out _));
        Assert.False(body.RootElement.TryGetProperty("timeout", out _));
    }

    [Fact]
    public async Task InteractAsync_RequiresCodeOrPrompt()
    {
        var client = ClientFor(new StubHandler("{}"));

        await Assert.ThrowsAsync<ArgumentException>(() => client.InteractAsync("job-123", " "));
    }

    [Fact]
    public async Task StopInteractiveBrowserAsync_SendsDelete()
    {
        var handler = new StubHandler("{\"success\":true,\"sessionDurationMs\":4200,\"creditsBilled\":2}");
        var client = ClientFor(handler);

        var response = await client.StopInteractiveBrowserAsync("job-123");

        Assert.True(response.Success);
        Assert.Equal(4200, response.SessionDurationMs);
        Assert.Equal(2, response.CreditsBilled);
        Assert.Equal(HttpMethod.Delete, handler.Request!.Method);
        Assert.Equal("http://localhost/v2/scrape/job-123/interact", handler.Request.RequestUri!.ToString());
    }
}
