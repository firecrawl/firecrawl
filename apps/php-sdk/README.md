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

## License

MIT
