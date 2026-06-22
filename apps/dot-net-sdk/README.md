# Firecrawl .NET SDK

.NET SDK for the [Firecrawl API](https://firecrawl.dev) — web scraping, crawling, and data extraction.

## Installation

```bash
dotnet add package firecrawl-sdk
```

## Quick Start

```csharp
using Firecrawl;
using Firecrawl.Models;

// Create a client
var client = new FirecrawlClient("fc-your-api-key");

// Scrape a single page
var doc = await client.ScrapeAsync("https://example.com",
    new ScrapeOptions { Formats = new List<object> { "markdown" } });

Console.WriteLine(doc.Markdown);
```

## Configuration

### API Key

The API key can be provided in two ways (in order of precedence):

1. Constructor parameter: `new FirecrawlClient("fc-your-api-key")`
2. Environment variable: `FIRECRAWL_API_KEY`

```csharp
// From environment variable
var client = new FirecrawlClient();

// Explicit API key
var client = new FirecrawlClient(apiKey: "fc-your-api-key");

// Custom API URL (for self-hosted instances)
var client = new FirecrawlClient(
    apiKey: "fc-your-api-key",
    apiUrl: "https://your-firecrawl-instance.com");

// Custom HttpClient
var httpClient = new HttpClient { Timeout = TimeSpan.FromSeconds(60) };
var client = new FirecrawlClient(
    apiKey: "fc-your-api-key",
    httpClient: httpClient);
```

## Usage

### Scrape

```csharp
// Basic scrape
var doc = await client.ScrapeAsync("https://example.com");

// Scrape with options
var doc = await client.ScrapeAsync("https://example.com",
    new ScrapeOptions
    {
        Formats = new List<object> { "markdown", "html" },
        OnlyMainContent = true,
        WaitFor = 5000
    });

Console.WriteLine(doc.Markdown);
Console.WriteLine(doc.Html);
```

### Video Extraction

Use the `video` format on supported video URLs, including YouTube and TikTok. The returned `Video` property is a signed URL to the extracted video file.

```csharp
var doc = await client.ScrapeAsync("https://www.youtube.com/watch?v=dQw4w9WgXcQ",
    new ScrapeOptions { Formats = new List<object> { "video" } });

Console.WriteLine(doc.Video);
```

### Product Extraction

Use the `product` format on product pages to get structured product extraction
(title, brand, and variants, each with their own price and availability) on the
document's `Product` property. It is the deterministic counterpart to the LLM-based
`json` format.

```csharp
var doc = await client.ScrapeAsync("https://example.com/product/123",
    new ScrapeOptions { Formats = new List<object> { "product" } });

Console.WriteLine(doc.Product);
```

### Menu Extraction

Use the `menu` format on restaurant/merchant pages to get structured menu
extraction (a merchant profile plus ordered sections, each holding items with
their own price, availability, and images) on the document's `Menu` property. It
is the deterministic counterpart to the LLM-based `json` format.

```csharp
var doc = await client.ScrapeAsync("https://example.com/restaurant/123",
    new ScrapeOptions { Formats = new List<object> { "menu" } });

Console.WriteLine(doc.Menu);
```

### Crawl

```csharp
// Crawl with auto-polling (waits for completion)
var job = await client.CrawlAsync("https://example.com",
    new CrawlOptions
    {
        Limit = 50,
        MaxDiscoveryDepth = 3,
        ExcludePaths = new List<string> { "/admin/*" }
    });

foreach (var page in job.Data!)
{
    Console.WriteLine(page.Markdown);
}

// Start crawl without waiting
var response = await client.StartCrawlAsync("https://example.com",
    new CrawlOptions { Limit = 100 });

// Check status later
var status = await client.GetCrawlStatusAsync(response.Id!);
Console.WriteLine($"Status: {status.Status}, Progress: {status.Completed}/{status.Total}");

// Cancel a crawl
await client.CancelCrawlAsync(response.Id!);
```

### Batch Scrape

```csharp
// Batch scrape with auto-polling
var urls = new List<string>
{
    "https://example.com/page1",
    "https://example.com/page2",
    "https://example.com/page3"
};

var job = await client.BatchScrapeAsync(urls,
    new BatchScrapeOptions
    {
        Options = new ScrapeOptions
        {
            Formats = new List<object> { "markdown" }
        }
    });

foreach (var doc in job.Data!)
{
    Console.WriteLine(doc.Markdown);
}
```

### Parse

Upload and parse a local file (HTML, PDF, DOCX, etc.) through the `/v2/parse`
endpoint. Parse does not support browser-rendering options like `actions`,
`waitFor`, `location`, `mobile`, or the `screenshot` / `branding` /
`changeTracking` / `audio` / `video` formats.

```csharp
using Firecrawl;
using Firecrawl.Models;

var client = new FirecrawlClient("fc-your-api-key");

// From a file on disk
var doc = await client.ParseAsync(
    ParseFile.FromPath("report.pdf"),
    new ParseOptions
    {
        Formats = new List<object> { "markdown" },
        OnlyMainContent = true,
    });

Console.WriteLine(doc.Markdown);

// From in-memory bytes
byte[] html = File.ReadAllBytes("snapshot.html");
var parsed = await client.ParseAsync(
    ParseFile.FromBytes("snapshot.html", html, "text/html"));
```

### Map (URL Discovery)

```csharp
// Discover URLs on a website
var data = await client.MapAsync("https://example.com",
    new MapOptions
    {
        Search = "pricing",
        Limit = 100
    });

foreach (var url in data.Links!)
{
    Console.WriteLine(url);
}
```

### Search

```csharp
// Web search
var results = await client.SearchAsync("firecrawl web scraping",
    new SearchOptions
    {
        Limit = 5,
        Location = "US"
    });
```

### Usage & Metrics

```csharp
// Check concurrency
var concurrency = await client.GetConcurrencyAsync();
Console.WriteLine($"Current: {concurrency.Current}, Max: {concurrency.MaxConcurrency}");

// Check credit usage
var usage = await client.GetCreditUsageAsync();
Console.WriteLine($"Remaining credits: {usage.RemainingCredits}");
```

## Error Handling

```csharp
using Firecrawl.Exceptions;

try
{
    var doc = await client.ScrapeAsync("https://example.com");
}
catch (AuthenticationException ex)
{
    // 401 - Invalid API key
    Console.WriteLine($"Auth error: {ex.Message}");
}
catch (RateLimitException ex)
{
    // 429 - Too many requests
    Console.WriteLine($"Rate limited: {ex.Message}");
}
catch (JobTimeoutException ex)
{
    // Async job timed out
    Console.WriteLine($"Job {ex.JobId} timed out after {ex.TimeoutSeconds}s");
}
catch (FirecrawlException ex)
{
    // General API error
    Console.WriteLine($"Error {ex.StatusCode}: {ex.Message}");
}
```

## Requirements

- .NET 8.0 or later

## Development

```bash
# Restore dependencies
dotnet restore

# Build
dotnet build

# Run tests
dotnet test
```

## License

MIT
