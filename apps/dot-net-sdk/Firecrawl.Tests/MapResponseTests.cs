using System.Net;
using System.Text;
using System.Text.Json;
using Firecrawl.Exceptions;
using Firecrawl.Models;
using Xunit;

namespace Firecrawl.Tests;

public class MapResponseTests
{
    private const string ObjectResponse = """
        {"success":true,"id":"map-job","warning":"Only one result found","links":[{"url":"https://example.com","title":"Home","description":"Start here"}]}
        """;

    [Fact]
    public void MapData_AcceptsObjectAndLegacyStringLinks()
    {
        var response = JsonSerializer.Deserialize<MapData>(
            """{"success":true,"links":["https://example.com/a",{"url":"https://example.com/b","title":"Page B"}]}""",
            FirecrawlHttpClient.JsonOptions);

        Assert.NotNull(response);
        Assert.Equal(new[] { "https://example.com/a", "https://example.com/b" }, response.Links);
        Assert.Equal("Page B", response.LinkDetails![1].Title);
    }

    [Fact]
    public async Task MapAsync_ReadsTopLevelApiResponseAndLinkMetadata()
    {
        using var http = new HttpClient(new StubHandler(ObjectResponse));
        var client = new FirecrawlClient(apiKey: "test-key", apiUrl: "https://api.example.com", httpClient: http);

        var result = await client.MapAsync("https://example.com");

        Assert.Equal("map-job", result.Id);
        Assert.Equal("Only one result found", result.Warning);
        Assert.Equal(new[] { "https://example.com" }, result.Links);
        Assert.Equal("Home", result.LinkDetails![0].Title);
        Assert.Equal("Start here", result.LinkDetails[0].Description);
    }

    [Fact]
    public async Task MapAsync_RejectsUnsuccessfulResponse()
    {
        using var http = new HttpClient(new StubHandler("""{"success":false,"error":"bad request"}"""));
        var client = new FirecrawlClient(apiKey: "test-key", apiUrl: "https://api.example.com", httpClient: http);

        await Assert.ThrowsAsync<FirecrawlException>(() => client.MapAsync("https://example.com"));
    }

    private sealed class StubHandler : HttpMessageHandler
    {
        private readonly string _responseBody;

        public StubHandler(string responseBody)
        {
            _responseBody = responseBody;
        }

        protected override Task<HttpResponseMessage> SendAsync(
            HttpRequestMessage request,
            CancellationToken cancellationToken)
        {
            Assert.Equal(HttpMethod.Post, request.Method);
            Assert.Equal("/v2/map", request.RequestUri!.AbsolutePath);
            return Task.FromResult(new HttpResponseMessage(HttpStatusCode.OK)
            {
                Content = new StringContent(_responseBody, Encoding.UTF8, "application/json")
            });
        }
    }
}
