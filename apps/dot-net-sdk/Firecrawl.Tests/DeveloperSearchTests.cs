using System.Net;
using System.Text;
using System.Text.Json;
using Firecrawl.Models;
using Xunit;

namespace Firecrawl.Tests;

public class DeveloperSearchTests
{
    private const string ResponseBody =
        "{\"success\":true,\"partial\":false,\"results\":["
        + "{\"id\":\"r1\",\"url\":\"https://github.com/square/okhttp/issues/1\",\"title\":\"retry\","
        + "\"passages\":[{\"text\":\"use backoff\",\"citation_url\":\"https://github.com/square/okhttp/issues/1#c1\"}],"
        + "\"license\":{\"state\":\"licensed\",\"spdx_id\":\"Apache-2.0\"}},"
        + "{\"id\":\"r2\",\"url\":\"https://github.com/square/okhttp\",\"passages\":[],\"license\":\"Apache-2.0\"}],"
        + "\"repos\":[{\"repo\":\"square/okhttp\",\"indexed\":true,"
        + "\"types\":{\"issue\":true,\"pullRequest\":true,\"readme\":false}}]}";

    private sealed class StubHandler : HttpMessageHandler
    {
        public HttpRequestMessage? Request { get; private set; }

        public string? RequestBody { get; private set; }

        protected override async Task<HttpResponseMessage> SendAsync(HttpRequestMessage request, CancellationToken cancellationToken)
        {
            Request = request;
            RequestBody = request.Content is null ? null : await request.Content.ReadAsStringAsync(cancellationToken);
            return new HttpResponseMessage(HttpStatusCode.OK)
            {
                Content = new StringContent(ResponseBody, Encoding.UTF8, "application/json"),
            };
        }
    }

    private static FirecrawlClient NewClient(StubHandler handler) =>
        new(apiKey: "fc-test-key", apiUrl: "http://localhost", maxRetries: 0, httpClient: new HttpClient(handler));

    [Fact]
    public async Task DeveloperSearchAsync_PostsQueryAndOptions()
    {
        var handler = new StubHandler();
        var client = NewClient(handler);

        var response = await client.DeveloperSearchAsync("retry backoff", new DeveloperSearchOptions
        {
            K = 5,
            Types = new List<string> { "issue" },
            Repos = new List<string> { "square/okhttp" },
            MinStars = 100,
        });

        Assert.Equal(HttpMethod.Post, handler.Request!.Method);
        Assert.Equal("http://localhost/v2/search/developer", handler.Request.RequestUri!.ToString());
        using var body = JsonDocument.Parse(handler.RequestBody!);
        var root = body.RootElement;
        Assert.Equal("retry backoff", root.GetProperty("query").GetString());
        Assert.Equal(5, root.GetProperty("k").GetInt32());
        Assert.Equal("issue", root.GetProperty("types")[0].GetString());
        Assert.Equal("square/okhttp", root.GetProperty("repos")[0].GetString());
        Assert.Equal(100, root.GetProperty("min_stars").GetInt64());
        Assert.StartsWith("dotnet-sdk@", root.GetProperty("origin").GetString());
        Assert.False(root.TryGetProperty("max_stars", out _));
        Assert.False(root.TryGetProperty("language", out _));

        Assert.True(response.Success);
        Assert.False(response.Partial);
        Assert.Equal(2, response.Results!.Count);
        Assert.Equal("https://github.com/square/okhttp/issues/1#c1", response.Results[0].Passages![0].CitationUrl);
        Assert.Equal("Apache-2.0", response.Results[0].License!.Value.GetProperty("spdx_id").GetString());
        Assert.Equal("Apache-2.0", response.Results[1].License!.Value.GetString());
        Assert.True(response.Repos![0].Indexed);
        Assert.True(response.Repos[0].Types!.PullRequest);
        Assert.Null(response.Sources);
    }

    [Theory]
    [InlineData("")]
    [InlineData("   ")]
    public async Task DeveloperSearchAsync_RejectsBlankQueryBeforeRequest(string query)
    {
        var handler = new StubHandler();
        var client = NewClient(handler);

        await Assert.ThrowsAsync<ArgumentException>(() => client.DeveloperSearchAsync(query));
        Assert.Null(handler.Request);
    }
}
