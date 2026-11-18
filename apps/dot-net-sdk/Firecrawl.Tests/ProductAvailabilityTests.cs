using System.Net;
using System.Text;
using System.Text.Json;
using Firecrawl.Models;
using Xunit;

namespace Firecrawl.Tests;

public class ProductAvailabilityTests
{
    [Theory]
    [InlineData("{\"inStock\":true,\"text\":\"In stock\"}", true)]
    [InlineData("{\"inStock\":false,\"text\":\"Sold out\"}", false)]
    [InlineData("{\"inStock\":null}", null)]
    [InlineData("{\"text\":\"Call for availability\"}", null)]
    public void ProductInStock_ParsesTrueFalseNullAndMissing(string availability, bool? expected)
    {
        var json = "{\"product\":{\"title\":\"Widget\",\"url\":\"https://example.com/widget\","
            + "\"variants\":[{\"title\":\"Default\",\"availability\":" + availability + "}]}}";

        var doc = JsonSerializer.Deserialize<Document>(json, FirecrawlHttpClient.JsonOptions);

        Assert.Equal(expected, doc!.Product!.Variants![0].Availability!.InStock);
    }

    [Fact]
    public void ProductVariant_RoundTripsIdentifiersAndUnknownStock()
    {
        const string fixture = "{\"sku\":\"SKU-1\",\"gtin\":\"00012345678905\",\"mpn\":\"MPN-1\","
            + "\"condition\":\"refurbished\",\"availability\":{\"inStock\":null}}";

        var variant = JsonSerializer.Deserialize<ProductVariant>(fixture, FirecrawlHttpClient.JsonOptions)!;

        Assert.Equal("00012345678905", variant.Gtin);
        Assert.Equal("MPN-1", variant.Mpn);
        Assert.Equal("refurbished", variant.Condition);
        Assert.Null(variant.Availability.InStock);
        Assert.Equal(fixture, JsonSerializer.Serialize(variant, FirecrawlHttpClient.JsonOptions));
    }

    [Fact]
    public void ProductVariant_OmitsAbsentIdentifiersAndKeepsUnknownCondition()
    {
        var json = JsonSerializer.Serialize(new ProductVariant(), FirecrawlHttpClient.JsonOptions);
        using var doc = JsonDocument.Parse(json);
        foreach (var key in new[] { "gtin", "mpn", "condition" })
        {
            Assert.False(doc.RootElement.TryGetProperty(key, out _), key);
        }

        var unknown = JsonSerializer.Deserialize<ProductVariant>(
            "{\"condition\":\"open-box\",\"availability\":{\"inStock\":false}}", FirecrawlHttpClient.JsonOptions)!;
        Assert.Equal("open-box", unknown.Condition);
    }

    private sealed class RecordingHandler : HttpMessageHandler
    {
        public List<(string Path, string Body)> Requests { get; } = new();

        protected override async Task<HttpResponseMessage> SendAsync(HttpRequestMessage request, CancellationToken cancellationToken)
        {
            var body = request.Content is null ? "" : await request.Content.ReadAsStringAsync(cancellationToken);
            Requests.Add((request.RequestUri!.AbsolutePath, body));
            return new HttpResponseMessage(HttpStatusCode.OK)
            {
                Content = new StringContent(
                    "{\"success\":true,\"id\":\"job-1\",\"url\":\"http://localhost/v2/job-1\",\"data\":{}}",
                    Encoding.UTF8,
                    "application/json"),
            };
        }
    }

    [Fact]
    public async Task ProductCapableRequests_SendVersionedSdkOrigin()
    {
        var handler = new RecordingHandler();
        var client = new FirecrawlClient(apiKey: "fc-test-key", apiUrl: "http://localhost", maxRetries: 0, httpClient: new HttpClient(handler));
        var scrapeOptions = new ScrapeOptions { Formats = new List<object> { "product" } };

        await client.ScrapeAsync("https://example.com", scrapeOptions);
        await client.StartCrawlAsync("https://example.com", new CrawlOptions { ScrapeOptions = scrapeOptions });
        await client.StartBatchScrapeAsync(new List<string> { "https://example.com" }, new BatchScrapeOptions { Options = scrapeOptions });
        await client.SearchAsync("widgets", new SearchOptions { ScrapeOptions = scrapeOptions });

        var version = typeof(FirecrawlClient).Assembly.GetName().Version!;
        var expectedOrigin = $"dotnet-sdk@{version.Major}.{version.Minor}.{version.Build}";
        Assert.Equal(
            new[] { "/v2/scrape", "/v2/crawl", "/v2/batch/scrape", "/v2/search" },
            handler.Requests.Select(r => r.Path).ToArray());
        foreach (var (path, body) in handler.Requests)
        {
            using var json = JsonDocument.Parse(body);
            Assert.Equal(expectedOrigin, json.RootElement.GetProperty("origin").GetString());
        }
    }
}
