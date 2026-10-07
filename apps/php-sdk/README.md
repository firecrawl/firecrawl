# Firecrawl PHP SDK

PHP SDK for the [Firecrawl](https://firecrawl.dev) v2 API with first-class Laravel support.

## Requirements

- PHP 8.1.0+
- Guzzle 7.9+

## Installation

```bash
composer require firecrawl/firecrawl-sdk
```

## Quick Start

```php
<?php

use Firecrawl\Client\FirecrawlClient;
use Firecrawl\Models\ScrapeOptions;

$client = FirecrawlClient::create(apiKey: 'fc-your-api-key');

// Scrape a single page
$doc = $client->scrape('https://example.com', ScrapeOptions::with(
    formats: ['markdown'],
    onlyMainContent: true,
));

echo $doc->getMarkdown();
```

### Environment Variables

The SDK reads the following environment variables as fallbacks:

| Variable | Description |
|---|---|
| `FIRECRAWL_API_KEY` | API key (required if not passed directly) |
| `FIRECRAWL_API_URL` | API base URL (defaults to `https://api.firecrawl.dev`) |

```php
// Uses FIRECRAWL_API_KEY from environment
$client = FirecrawlClient::fromEnv();
```

## Usage

### Scrape

```php
use Firecrawl\Models\ScrapeOptions;
use Firecrawl\Models\JsonFormat;

// Basic scrape
$doc = $client->scrape('https://example.com');
echo $doc->getMarkdown();

// With options
$doc = $client->scrape('https://example.com', ScrapeOptions::with(
    formats: ['markdown', 'html'],
    onlyMainContent: true,
    timeout: 30000,
    waitFor: 5000,
));

// JSON extraction
$doc = $client->scrape('https://example.com/product', ScrapeOptions::with(
    formats: [JsonFormat::with(
        prompt: 'Extract product name and price',
        schema: [
            'type' => 'object',
            'properties' => [
                'name' => ['type' => 'string'],
                'price' => ['type' => 'number'],
            ],
        ],
    )],
));

echo $doc->getJson(); // Structured data
```

### Product Extraction

Use the `product` format on product pages for structured product extraction
(title, brand, category, and per-variant price, availability, and images).
It is the deterministic counterpart to the LLM-based `json` format, returned
on the document's `getProduct()`.

```php
$doc = $client->scrape('https://example.com/product', ScrapeOptions::with(
    formats: ['product'],
));

echo $doc->getProduct(); // Structured product data
```

### Menu Extraction

Use the `menu` format on restaurant or merchant menu pages for structured menu
extraction (merchant profile plus ordered sections, each holding items with
per-item price, availability, dietary tags, and images). It is the
deterministic counterpart to the LLM-based `json` format, returned on the
document's `getMenu()`.

```php
$doc = $client->scrape('https://example.com/menu', ScrapeOptions::with(
    formats: ['menu'],
));

echo $doc->getMenu(); // Structured menu data
```

### Video Extraction

Use the `video` format on supported video URLs, including YouTube and TikTok. The returned `video` field is a signed URL to the extracted video file.

```php
$doc = $client->scrape('https://www.youtube.com/watch?v=dQw4w9WgXcQ', ScrapeOptions::with(
    formats: ['video'],
));

echo $doc->getVideo();
```

### Parse

Upload a local file (`html`, `pdf`, `docx`, etc.) via multipart form data and
parse it synchronously. Parse options intentionally exclude browser-only
features such as change tracking, screenshot, branding, product, menu, audio, video, actions,
waitFor, location, and mobile. The `proxy` option only accepts `"auto"` or `"basic"`.

```php
use Firecrawl\Models\ParseFile;
use Firecrawl\Models\ParseOptions;

// From disk
$file = ParseFile::fromPath('./document.pdf');

// Or from memory
$file = ParseFile::fromBytes(
    filename: 'upload.html',
    content: '<html>hi</html>',
    contentType: 'text/html',
);

$doc = $client->parse($file, ParseOptions::with(
    formats: ['markdown'],
));
echo $doc->getMarkdown();
```

List the file formats parse accepts on the deployment you are calling.
Image formats report `isAvailable() === false` when image OCR is disabled.

```php
foreach ($client->getParseFormats() as $format) {
    echo $format->getFormat() . ' (' . $format->getKind() . '): '
        . implode(', ', $format->getExtensions())
        . ($format->isAvailable() ? '' : ' [unavailable]') . "\n";
}
```

### Crawl

```php
use Firecrawl\Models\CrawlOptions;
use Firecrawl\Models\ScrapeOptions;

// Crawl with auto-polling (blocks until complete)
$job = $client->crawl('https://example.com', CrawlOptions::with(
    limit: 50,
    maxDiscoveryDepth: 3,
    scrapeOptions: ScrapeOptions::with(formats: ['markdown']),
));

foreach ($job->getData() as $doc) {
    echo $doc->getMetadata()['sourceURL'] . "\n";
}

// Async: start crawl and poll manually
$response = $client->startCrawl('https://example.com', CrawlOptions::with(limit: 10));
$jobId = $response->getId();

// Check status later
$job = $client->getCrawlStatus($jobId);
echo "Completed: {$job->getCompleted()}/{$job->getTotal()}\n";

// Cancel
$client->cancelCrawl($jobId);
```

### Batch Scrape

```php
use Firecrawl\Models\BatchScrapeOptions;
use Firecrawl\Models\ScrapeOptions;

$job = $client->batchScrape(
    ['https://example.com', 'https://example.org'],
    BatchScrapeOptions::with(
        options: ScrapeOptions::with(formats: ['markdown']),
        idempotencyKey: 'my-batch-123',
    ),
);

foreach ($job->getData() as $doc) {
    echo $doc->getMarkdown() . "\n";
}
```

### Map

```php
use Firecrawl\Models\MapOptions;

$result = $client->map('https://example.com', MapOptions::with(
    limit: 100,
    search: 'pricing',
));

foreach ($result->getLinks() as $link) {
    echo $link['url'] . "\n";
}
```

### Search

```php
use Firecrawl\Models\SearchOptions;

$result = $client->search('firecrawl web scraping', SearchOptions::with(
    limit: 5,
));

foreach ($result->getWeb() as $item) {
    echo $item['title'] . ': ' . $item['url'] . "\n";
}
```

### Agent

```php
use Firecrawl\Models\AgentOptions;

// Auto-polling (blocks until complete)
$result = $client->agent(AgentOptions::with(
    prompt: 'Find the pricing plans and compare them',
    maxCredits: 100,
));

echo $result->getData();
```

To let the agent use Exchange data providers connected to your team, pass
`exchange`. Omit `toolkits` to allow every provider the team can use.

```php
use Firecrawl\Models\AgentExchangeOptions;

$result = $client->agent(AgentOptions::with(
    prompt: 'Find the company behind example.com and its funding history',
    exchange: AgentExchangeOptions::with(
        enabled: true,
        toolkits: ['provider-slug'],
    ),
));
```

### Browser Sessions

```php
// Create a session
$session = $client->browser(ttl: 300);
$sessionId = $session->getId();

// Execute code
$result = $client->browserExecute($sessionId, 'agent-browser open https://example.com');
echo $result->getStdout();

// Execute JavaScript
$result = $client->browserExecute(
    $sessionId,
    'console.log(await page.title());',
    language: 'node',
    timeout: 30,
);

// Cleanup
$client->deleteBrowser($sessionId);

// List sessions
$sessions = $client->listBrowsers(status: 'active');
```

### Scrape-Bound Browser Interaction

```php
$doc = $client->scrape('https://example.com');
$scrapeId = $doc->getMetadata()['scrapeId'];

$result = $client->interact($scrapeId, 'await page.click("button");', language: 'node');
echo $result->getStdout();

$client->stopInteractiveBrowser($scrapeId);
```

### Usage & Metrics

```php
$concurrency = $client->getConcurrency();
echo "Current: {$concurrency->getConcurrency()}/{$concurrency->getMaxConcurrency()}\n";

$credits = $client->getCreditUsage();
echo "Remaining: {$credits->getRemainingCredits()}\n";
```

## Error Handling

```php
use Firecrawl\Exceptions\FirecrawlException;
use Firecrawl\Exceptions\AuthenticationException;
use Firecrawl\Exceptions\RateLimitException;
use Firecrawl\Exceptions\JobTimeoutException;

try {
    $doc = $client->scrape('https://example.com');
} catch (AuthenticationException $e) {
    echo "Invalid API key\n";
} catch (RateLimitException $e) {
    echo "Rate limited, back off\n";
} catch (JobTimeoutException $e) {
    echo "Job {$e->getJobId()} timed out after {$e->getTimeoutSeconds()}s\n";
} catch (FirecrawlException $e) {
    echo "Error ({$e->getStatusCode()}): {$e->getMessage()}\n";
}
```

## Advanced Configuration

```php
use GuzzleHttp\Client as GuzzleClient;

$client = FirecrawlClient::create(
    apiKey: 'fc-your-api-key',
    apiUrl: 'https://custom-api.example.com',
    timeoutSeconds: 120,
    maxRetries: 5,
    backoffFactor: 1.0,
    httpClient: new GuzzleClient([
        'proxy' => 'http://proxy.example.com:8080',
    ]),
);
```

## Laravel Integration

### Setup

The service provider is auto-discovered. Publish the config file:

```bash
php artisan vendor:publish --tag=firecrawl-config
```

Add your API key to `.env`:

```
FIRECRAWL_API_KEY=fc-your-api-key
```

### Configuration

The published `config/firecrawl.php` supports these environment variables:

| Variable | Default | Description |
|---|---|---|
| `FIRECRAWL_API_KEY` | — | API key (required) |
| `FIRECRAWL_API_URL` | `https://api.firecrawl.dev` | API base URL |
| `FIRECRAWL_TIMEOUT` | `300` | Request timeout in seconds |
| `FIRECRAWL_MAX_RETRIES` | `3` | Max retry attempts |
| `FIRECRAWL_BACKOFF_FACTOR` | `0.5` | Exponential backoff factor |

### Using the Facade

```php
use Firecrawl\Laravel\Facades\Firecrawl;
use Firecrawl\Models\ScrapeOptions;

$doc = Firecrawl::scrape('https://example.com', ScrapeOptions::with(
    formats: ['markdown'],
));
```

### Using Dependency Injection

```php
use Firecrawl\Client\FirecrawlClient;

class MyController
{
    public function __construct(
        private readonly FirecrawlClient $firecrawl,
    ) {}

    public function scrape(string $url)
    {
        return $this->firecrawl->scrape($url);
    }
}
```

### Laravel AI SDK Tools

The SDK ships native tool classes for the [Laravel AI SDK](https://laravel.com/docs/ai-sdk)
(`laravel/ai`, requires PHP 8.3+ and Laravel 12+):

```bash
composer require laravel/ai
```

Note for contributors: `laravel/ai` is also a dev dependency of this package,
so running the SDK's own test suite requires PHP 8.3+.

Add Firecrawl capabilities to any agent, no MCP server or manual HTTP calls needed.
The tools resolve the `FirecrawlClient` from the container, so your existing
`config/firecrawl.php` / `FIRECRAWL_API_KEY` setup is reused as-is:

```php
use Firecrawl\Laravel\Tools\FirecrawlScrape;
use Firecrawl\Laravel\Tools\FirecrawlSearch;
use Laravel\Ai\Contracts\Agent;
use Laravel\Ai\Contracts\HasTools;
use Laravel\Ai\Promptable;
use Stringable;

class ResearchAssistant implements Agent, HasTools
{
    use Promptable;

    public function instructions(): Stringable|string
    {
        return 'You are a research assistant. Use the Firecrawl tools to find and read web content.';
    }

    public function tools(): iterable
    {
        return [
            new FirecrawlScrape,
            new FirecrawlSearch,
        ];
    }
}

$response = ResearchAssistant::make()->prompt('What does firecrawl.dev do?');
```

Available tools:

| Class | Tool name | Wraps |
|---|---|---|
| `FirecrawlScrape` | `firecrawl_scrape` | Scrape one URL to markdown |
| `FirecrawlSearch` | `firecrawl_search` | Web search with JSON results |
| `FirecrawlMap` | `firecrawl_map` | Discover a site's URLs |
| `FirecrawlCrawl` | `firecrawl_crawl` | Crawl multiple pages to markdown |

Register all of them at once with the spread helper:

```php
use Firecrawl\Laravel\Tools\FirecrawlTools;

public function tools(): iterable
{
    return [...FirecrawlTools::all()];
}
```

Every tool also accepts an explicit client, for one-off credentials or use
outside the container:

```php
use Firecrawl\Client\FirecrawlClient;

new FirecrawlScrape(FirecrawlClient::create(apiKey: 'fc-other-key'));
```

Tool failures (rate limits, timeouts, invalid URLs) are returned to the model
as readable error strings rather than thrown, so agent runs degrade gracefully.

`firecrawl_crawl` waits up to 55 seconds for the crawl to finish and returns
a JSON object with the crawl status and pages, so failed or partial crawls
are visible to the model. If your agent runs inside a queued job, keep the
crawl limit small or raise the worker's job timeout; on timeout the model
receives a readable message and the crawl may still complete on the server.
Extend `FirecrawlCrawl` and override `$timeoutSeconds` to change how long it
waits.

## License

MIT
