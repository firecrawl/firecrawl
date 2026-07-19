using System.Text.Json;
using Firecrawl.Models;
using Xunit;

namespace Firecrawl.Tests;

public class ModelsTests
{
    private static readonly JsonSerializerOptions JsonOptions = FirecrawlHttpClient.JsonOptions;

    [Fact]
    public void ScrapeOptions_SerializesCorrectly()
    {
        var options = new ScrapeOptions
        {
            Formats = new List<object> { "markdown", "html" },
            OnlyMainContent = true,
            Timeout = 30000,
            Mobile = false,
            RedactPII = true
        };

        var json = JsonSerializer.Serialize(options, JsonOptions);
        Assert.Contains("\"formats\"", json);
        Assert.Contains("\"markdown\"", json);
        Assert.Contains("\"html\"", json);
        Assert.Contains("\"onlyMainContent\":true", json);
        Assert.Contains("\"timeout\":30000", json);
        Assert.Contains("\"mobile\":false", json);
        Assert.Contains("\"redactPII\":true", json);
    }

    [Fact]
    public void ScrapeOptions_OmitsNullProperties()
    {
        var options = new ScrapeOptions
        {
            Formats = new List<object> { "markdown" }
        };

        var json = JsonSerializer.Serialize(options, JsonOptions);
        Assert.Contains("\"formats\"", json);
        Assert.DoesNotContain("\"timeout\"", json);
        Assert.DoesNotContain("\"mobile\"", json);
        Assert.DoesNotContain("\"headers\"", json);
    }

    [Fact]
    public void CrawlOptions_SerializesCorrectly()
    {
        var options = new CrawlOptions
        {
            Limit = 100,
            MaxDiscoveryDepth = 3,
            Sitemap = "include",
            ExcludePaths = new List<string> { "/admin/*" }
        };

        var json = JsonSerializer.Serialize(options, JsonOptions);
        Assert.Contains("\"limit\":100", json);
        Assert.Contains("\"maxDiscoveryDepth\":3", json);
        Assert.Contains("\"sitemap\":\"include\"", json);
        Assert.Contains("\"/admin/*\"", json);
    }

    [Fact]
    public void MapOptions_SerializesCorrectly()
    {
        var options = new MapOptions
        {
            Search = "pricing",
            Limit = 10,
            IncludeSubdomains = true
        };

        var json = JsonSerializer.Serialize(options, JsonOptions);
        Assert.Contains("\"search\":\"pricing\"", json);
        Assert.Contains("\"limit\":10", json);
        Assert.Contains("\"includeSubdomains\":true", json);
    }

    [Fact]
    public void SearchOptions_SerializesCorrectly()
    {
        var options = new SearchOptions
        {
            Limit = 5,
            Location = "US",
            Tbs = "qdr:w",
            Highlights = false,
            IncludeDomains = new() { "firecrawl.dev" },
            ExcludeDomains = new() { "example.com" }
        };

        var json = JsonSerializer.Serialize(options, JsonOptions);
        Assert.Contains("\"limit\":5", json);
        Assert.Contains("\"location\":\"US\"", json);
        Assert.Contains("\"tbs\":\"qdr:w\"", json);
        Assert.Contains("\"highlights\":false", json);
        Assert.Contains("\"includeDomains\":[\"firecrawl.dev\"]", json);
        Assert.Contains("\"excludeDomains\":[\"example.com\"]", json);
    }

    [Fact]
    public void BatchScrapeOptions_IdempotencyKey_NotSerialized()
    {
        var options = new BatchScrapeOptions
        {
            IdempotencyKey = "my-key-123",
            IgnoreInvalidURLs = true
        };

        var json = JsonSerializer.Serialize(options, JsonOptions);
        Assert.DoesNotContain("idempotencyKey", json);
        Assert.DoesNotContain("my-key-123", json);
        Assert.Contains("\"ignoreInvalidURLs\":true", json);
    }

    [Fact]
    public void Document_DeserializesCorrectly()
    {
        var json = """
        {
            "markdown": "# Hello World",
            "html": "<h1>Hello World</h1>",
            "video": "https://storage.googleapis.com/firecrawl/video.mp4",
            "metadata": {
                "title": "Test",
                "sourceURL": "https://example.com"
            },
            "warning": null
        }
        """;

        var doc = JsonSerializer.Deserialize<Document>(json, JsonOptions);
        Assert.NotNull(doc);
        Assert.Equal("# Hello World", doc.Markdown);
        Assert.Equal("<h1>Hello World</h1>", doc.Html);
        Assert.Equal("https://storage.googleapis.com/firecrawl/video.mp4", doc.Video);
        Assert.NotNull(doc.Metadata);
        Assert.Null(doc.Warning);
    }

    [Fact]
    public void Document_DeserializesProductCorrectly()
    {
        var json = """
        {
            "markdown": "# Product",
            "product": {
                "title": "Test Sneaker",
                "brand": "Acme",
                "category": "Shoes",
                "url": "https://example.com/product/1",
                "description": "A great sneaker",
                "variants": [
                    {
                        "id": "v1",
                        "sku": "SKU-1",
                        "title": "Size 10",
                        "values": { "size": "10" },
                        "price": { "amount": 99.99, "currency": "USD", "formatted": "$99.99" },
                        "sale": { "originalPrice": { "amount": 129.99, "currency": "USD" } },
                        "availability": { "inStock": true, "text": "In stock" },
                        "images": [ { "url": "https://example.com/v1.jpg", "alt": "Front" } ]
                    }
                ]
            }
        }
        """;

        var doc = JsonSerializer.Deserialize<Document>(json, JsonOptions);
        Assert.NotNull(doc);
        Assert.NotNull(doc.Product);
        Assert.Equal("Test Sneaker", doc.Product.Title);
        Assert.Equal("Acme", doc.Product.Brand);
        Assert.Equal("https://example.com/product/1", doc.Product.Url);
        Assert.NotNull(doc.Product.Variants);
        Assert.Single(doc.Product.Variants);
        var variant = doc.Product.Variants[0];
        Assert.Equal("v1", variant.Id);
        Assert.Equal("SKU-1", variant.Sku);
        Assert.NotNull(variant.Values);
        Assert.Equal("10", variant.Values["size"].GetString());
        Assert.NotNull(variant.Price);
        Assert.Equal(99.99, variant.Price.Amount);
        Assert.Equal("USD", variant.Price.Currency);
        Assert.NotNull(variant.Sale);
        Assert.Equal(129.99, variant.Sale.OriginalPrice.Amount);
        Assert.NotNull(variant.Availability);
        Assert.True(variant.Availability.InStock);
        Assert.NotNull(variant.Images);
        Assert.Single(variant.Images);
        Assert.Equal("Front", variant.Images[0].Alt);
    }

    [Fact]
    public void Document_DeserializesMenuCorrectly()
    {
        var json = """
        {
            "markdown": "# Menu",
            "menu": {
                "isMenu": true,
                "confidence": 0.95,
                "merchant": { "name": "Acme Diner", "type": "restaurant" },
                "currency": "USD",
                "sourceUrl": "https://example.com/restaurant/1",
                "sections": [
                    {
                        "id": "s1",
                        "name": "Appetizers",
                        "description": "Starters",
                        "items": [
                            {
                                "id": "i1",
                                "name": "Garlic Bread",
                                "description": "Toasted",
                                "images": [ { "url": "https://example.com/i1.jpg", "alt": "Bread" } ],
                                "price": { "amount": 5.99, "currency": "USD", "formatted": "$5.99" },
                                "availability": { "inStock": true, "text": "Available" },
                                "dietary": [ "vegetarian" ],
                                "calories": 320,
                                "optionGroups": [],
                                "identifiers": { "merchantItemId": "MID-1" },
                                "url": "https://example.com/item/1",
                                "sourceUrl": "https://example.com/restaurant/1"
                            }
                        ]
                    }
                ]
            }
        }
        """;

        var doc = JsonSerializer.Deserialize<Document>(json, JsonOptions);
        Assert.NotNull(doc);
        Assert.NotNull(doc.Menu);
        Assert.True(doc.Menu.IsMenu);
        Assert.Equal(0.95, doc.Menu.Confidence);
        Assert.Equal("USD", doc.Menu.Currency);
        Assert.Equal("https://example.com/restaurant/1", doc.Menu.SourceUrl);
        Assert.NotNull(doc.Menu.Merchant);
        Assert.Equal("Acme Diner", doc.Menu.Merchant.Name);
        Assert.Equal("restaurant", doc.Menu.Merchant.Type);
        Assert.NotNull(doc.Menu.Sections);
        Assert.Single(doc.Menu.Sections);
        var section = doc.Menu.Sections[0];
        Assert.Equal("s1", section.Id);
        Assert.Equal("Appetizers", section.Name);
        Assert.Single(section.Items);
        var item = section.Items[0];
        Assert.Equal("i1", item.Id);
        Assert.Equal("Garlic Bread", item.Name);
        Assert.NotNull(item.Price);
        Assert.Equal(5.99, item.Price.Amount);
        Assert.Equal("USD", item.Price.Currency);
        Assert.NotNull(item.Availability);
        Assert.True(item.Availability.InStock);
        Assert.NotNull(item.Dietary);
        Assert.Contains("vegetarian", item.Dietary);
        Assert.Equal(320, item.Calories);
        Assert.NotNull(item.Identifiers);
        Assert.Equal("MID-1", item.Identifiers.MerchantItemId);
        Assert.NotNull(item.Images);
        Assert.Single(item.Images);
        Assert.Equal("Bread", item.Images[0].Alt);
        Assert.Equal("https://example.com/restaurant/1", item.SourceUrl);
    }

    [Fact]
    public void Document_IgnoresUnknownProperties()
    {
        var json = """
        {
            "markdown": "# Test",
            "futureField": "should be ignored",
            "anotherNewField": 42
        }
        """;

        var doc = JsonSerializer.Deserialize<Document>(json, JsonOptions);
        Assert.NotNull(doc);
        Assert.Equal("# Test", doc.Markdown);
    }

    [Fact]
    public void CrawlJob_IsDone_Completed()
    {
        var job = new CrawlJob { Status = "completed" };
        Assert.True(job.IsDone);
    }

    [Fact]
    public void CrawlJob_IsDone_Failed()
    {
        var job = new CrawlJob { Status = "failed" };
        Assert.True(job.IsDone);
    }

    [Fact]
    public void CrawlJob_IsDone_Cancelled()
    {
        var job = new CrawlJob { Status = "cancelled" };
        Assert.True(job.IsDone);
    }

    [Fact]
    public void CrawlJob_NotDone_Scraping()
    {
        var job = new CrawlJob { Status = "scraping" };
        Assert.False(job.IsDone);
    }

    [Fact]
    public void BatchScrapeJob_IsDone_Completed()
    {
        var job = new BatchScrapeJob { Status = "completed" };
        Assert.True(job.IsDone);
    }

    [Fact]
    public void BatchScrapeJob_NotDone_Scraping()
    {
        var job = new BatchScrapeJob { Status = "scraping" };
        Assert.False(job.IsDone);
    }

    [Fact]
    public void CrawlJob_DeserializesCorrectly()
    {
        var json = """
        {
            "id": "crawl-123",
            "status": "completed",
            "completed": 5,
            "total": 5,
            "creditsUsed": 5,
            "data": [
                { "markdown": "# Page 1" },
                { "markdown": "# Page 2" }
            ],
            "next": null
        }
        """;

        var job = JsonSerializer.Deserialize<CrawlJob>(json, JsonOptions);
        Assert.NotNull(job);
        Assert.Equal("crawl-123", job.Id);
        Assert.Equal("completed", job.Status);
        Assert.Equal(5, job.Completed);
        Assert.Equal(5, job.Total);
        Assert.True(job.IsDone);
        Assert.NotNull(job.Data);
        Assert.Equal(2, job.Data.Count);
    }

    [Fact]
    public void JsonFormat_HasCorrectType()
    {
        var format = new JsonFormat
        {
            Prompt = "Extract the main content",
            Schema = new Dictionary<string, object>
            {
                ["type"] = "object",
                ["properties"] = new Dictionary<string, object>
                {
                    ["title"] = new Dictionary<string, object> { ["type"] = "string" }
                }
            }
        };

        var json = JsonSerializer.Serialize(format, JsonOptions);
        Assert.Contains("\"type\":\"json\"", json);
        Assert.Contains("\"prompt\"", json);
        Assert.Contains("\"schema\"", json);
    }

    [Fact]
    public void QueryFormat_HasCorrectMode()
    {
        var format = new QueryFormat
        {
            Prompt = "What is Firecrawl?",
            Mode = QueryFormat.DirectQuoteMode
        };

        var json = JsonSerializer.Serialize(format, JsonOptions);
        Assert.Contains("\"type\":\"query\"", json);
        Assert.Contains("\"prompt\":\"What is Firecrawl?\"", json);
        Assert.Contains("\"mode\":\"directQuote\"", json);
    }

    [Fact]
    public void QuestionAndHighlightsFormats_SerializeCorrectly()
    {
        var question = new QuestionFormat
        {
            Question = "What is Firecrawl?"
        };
        var highlights = new HighlightsFormat
        {
            Query = "What is Firecrawl?"
        };

        var questionJson = JsonSerializer.Serialize(question, JsonOptions);
        Assert.Contains("\"type\":\"question\"", questionJson);
        Assert.Contains("\"question\":\"What is Firecrawl?\"", questionJson);

        var highlightsJson = JsonSerializer.Serialize(highlights, JsonOptions);
        Assert.Contains("\"type\":\"highlights\"", highlightsJson);
        Assert.Contains("\"query\":\"What is Firecrawl?\"", highlightsJson);
    }

    [Fact]
    public void WebhookConfig_SerializesCorrectly()
    {
        var config = new WebhookConfig
        {
            Url = "https://example.com/webhook",
            Events = new List<string> { "completed", "failed" }
        };

        var json = JsonSerializer.Serialize(config, JsonOptions);
        Assert.Contains("\"url\":\"https://example.com/webhook\"", json);
        Assert.Contains("\"completed\"", json);
        Assert.Contains("\"failed\"", json);
    }

    [Fact]
    public void LocationConfig_SerializesCorrectly()
    {
        var config = new LocationConfig
        {
            Country = "US",
            Languages = new List<string> { "en" }
        };

        var json = JsonSerializer.Serialize(config, JsonOptions);
        Assert.Contains("\"country\":\"US\"", json);
        Assert.Contains("\"en\"", json);
    }

    [Fact]
    public void CrawlResponse_DeserializesCorrectly()
    {
        var json = """
        {
            "success": true,
            "id": "crawl-abc",
            "url": "https://api.firecrawl.dev/v2/crawl/crawl-abc"
        }
        """;

        var response = JsonSerializer.Deserialize<CrawlResponse>(json, JsonOptions);
        Assert.NotNull(response);
        Assert.True(response.Success);
        Assert.Equal("crawl-abc", response.Id);
    }

    [Fact]
    public void BatchScrapeResponse_DeserializesCorrectly()
    {
        var json = """
        {
            "success": true,
            "id": "batch-abc",
            "invalidURLs": ["not-a-url"]
        }
        """;

        var response = JsonSerializer.Deserialize<BatchScrapeResponse>(json, JsonOptions);
        Assert.NotNull(response);
        Assert.True(response.Success);
        Assert.Equal("batch-abc", response.Id);
        Assert.NotNull(response.InvalidURLs);
        Assert.Single(response.InvalidURLs);
    }

    [Fact]
    public void MonitorSearchTarget_SerializesCorrectly()
    {
        var target = new MonitorSearchTarget
        {
            Queries = new List<string> { "firecrawl pricing", "firecrawl changelog" },
            SearchWindow = "24h",
            IncludeDomains = new List<string> { "firecrawl.dev" },
            ExcludeDomains = new List<string> { "example.com" },
            MaxResults = 10
        };

        var json = JsonSerializer.Serialize(target, JsonOptions);
        Assert.Contains("\"type\":\"search\"", json);
        Assert.Contains("\"queries\"", json);
        Assert.Contains("\"searchWindow\":\"24h\"", json);
        Assert.Contains("\"includeDomains\"", json);
        Assert.Contains("\"excludeDomains\"", json);
        Assert.Contains("\"maxResults\":10", json);
    }

    [Fact]
    public void MonitorSearchTargetResult_DeserializesCorrectly()
    {
        var json = """
        {
            "targetId": "tgt-1",
            "type": "search",
            "searchCompleted": true,
            "resultCount": 5,
            "matches": 2,
            "summary": "Two new results matched.",
            "judgeDegraded": false,
            "degradedReason": null,
            "searchCredits": 5,
            "judgeCredits": 1,
            "resultsJudged": 5
        }
        """;

        var result = JsonSerializer.Deserialize<MonitorSearchTargetResult>(json, JsonOptions);
        Assert.NotNull(result);
        Assert.Equal("tgt-1", result.TargetId);
        Assert.Equal("search", result.Type);
        Assert.True(result.SearchCompleted);
        Assert.Equal(5, result.ResultCount);
        Assert.Equal(2, result.Matches);
        Assert.Equal("Two new results matched.", result.Summary);
        Assert.False(result.JudgeDegraded);
        Assert.Null(result.DegradedReason);
        Assert.Equal(5, result.SearchCredits);
        Assert.Equal(1, result.JudgeCredits);
        Assert.Equal(5, result.ResultsJudged);
    }
}
