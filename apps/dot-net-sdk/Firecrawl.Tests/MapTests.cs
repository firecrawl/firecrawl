using System.Net;
using System.Text;
using System.Text.Json;
using Firecrawl.Models;
using Xunit;

namespace Firecrawl.Tests;

public class MapTests
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

    [Fact]
    public async Task MapAsync_ReadsTopLevelLinkObjects()
    {
        var handler = new StubHandler(
            "{\"success\":true,\"links\":[{\"url\":\"https://example.com/pricing\",\"title\":\"Pricing\",\"description\":\"Plans\"},{\"url\":\"https://example.com/about\"}]}");
        var client = new FirecrawlClient(apiKey: "fc-test-key", apiUrl: "http://localhost", maxRetries: 0, httpClient: new HttpClient(handler));

        var data = await client.MapAsync("https://example.com", new MapOptions { Limit = 2 });

        Assert.NotNull(data.Links);
        Assert.Equal(2, data.Links!.Count);
        Assert.Equal("https://example.com/pricing", data.Links[0].Url);
        Assert.Equal("Pricing", data.Links[0].Title);
        Assert.Equal("Plans", data.Links[0].Description);
        Assert.Equal("https://example.com/about", data.Links[1].Url);
        Assert.Null(data.Links[1].Title);

        Assert.Equal("http://localhost/v2/map", handler.Request!.RequestUri!.ToString());
        using var body = JsonDocument.Parse(handler.RequestBody!);
        Assert.Equal("https://example.com", body.RootElement.GetProperty("url").GetString());
        Assert.Equal(2, body.RootElement.GetProperty("limit").GetInt32());
    }
}
