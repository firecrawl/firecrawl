<?php

declare(strict_types=1);

use Firecrawl\Models\CreditUsage;
use Firecrawl\Models\Document;
use Firecrawl\Models\Product;
use Firecrawl\Models\MapData;
use Firecrawl\Models\BatchScrapeJob;
use Firecrawl\Models\CrawlJob;
use Firecrawl\Models\HighlightsFormat;
use Firecrawl\Models\QueryFormat;
use Firecrawl\Models\QuestionFormat;
use Firecrawl\Models\ScrapeOptions;

it('hydrates CreditUsage from nested data key', function (): void {
    $response = [
        'success' => true,
        'data' => [
            'remainingCredits' => 500,
            'planCredits' => 1000,
            'billingPeriodStart' => '2025-01-01',
            'billingPeriodEnd' => '2025-02-01',
        ],
    ];

    $usage = CreditUsage::fromArray($response);

    expect($usage->getRemainingCredits())->toBe(500);
    expect($usage->getPlanCredits())->toBe(1000);
    expect($usage->getBillingPeriodStart())->toBe('2025-01-01');
    expect($usage->getBillingPeriodEnd())->toBe('2025-02-01');
});

it('hydrates CreditUsage from flat data', function (): void {
    $response = [
        'remainingCredits' => 250,
        'planCredits' => 500,
    ];

    $usage = CreditUsage::fromArray($response);

    expect($usage->getRemainingCredits())->toBe(250);
    expect($usage->getPlanCredits())->toBe(500);
});

it('guards MapData links against non-array input', function (): void {
    $data = ['links' => 'not-an-array'];

    $map = MapData::fromArray($data);

    expect($map->getLinks())->toBe([]);
});

it('normalizes MapData string links', function (): void {
    $data = [
        'links' => [
            'https://example.com',
            ['url' => 'https://example.com/about', 'title' => 'About'],
        ],
    ];

    $map = MapData::fromArray($data);

    expect($map->getLinks())->toHaveCount(2);
    expect($map->getLinks()[0])->toBe(['url' => 'https://example.com']);
    expect($map->getLinks()[1])->toBe(['url' => 'https://example.com/about', 'title' => 'About']);
});

it('casts creditsUsed to int in BatchScrapeJob', function (): void {
    $raw = [
        'id' => 'batch-123',
        'status' => 'completed',
        'completed' => 5,
        'total' => 5,
        'creditsUsed' => '42',
        'data' => [],
    ];

    $job = BatchScrapeJob::fromArray($raw);

    expect($job->getCreditsUsed())->toBe(42);
    expect($job->getCreditsUsed())->toBeInt();
});

it('preserves null creditsUsed in CrawlJob', function (): void {
    $raw = [
        'id' => 'crawl-123',
        'status' => 'scraping',
        'data' => [],
    ];

    $job = CrawlJob::fromArray($raw);

    expect($job->getCreditsUsed())->toBeNull();
});

it('hydrates video URL in Document', function (): void {
    $doc = Document::fromArray([
        'markdown' => '# Video',
        'video' => 'https://storage.googleapis.com/firecrawl/video.mp4',
    ]);

    expect($doc->getMarkdown())->toBe('# Video');
    expect($doc->getVideo())->toBe('https://storage.googleapis.com/firecrawl/video.mp4');
});

it('hydrates product into Product model in Document', function (): void {
    $doc = Document::fromArray([
        'markdown' => '# Product',
        'product' => [
            'title' => 'Running Shoe',
            'brand' => 'Acme',
            'category' => 'Footwear',
            'url' => 'https://example.com/shoe',
            'description' => 'A fast running shoe.',
            'images' => [
                ['url' => 'https://example.com/shoe.jpg', 'alt' => 'Side view'],
                ['url' => 'https://example.com/shoe-2.jpg'],
            ],
            'price' => ['amount' => 99.99, 'currency' => 'USD', 'formatted' => '$99.99'],
            'originalPrice' => ['amount' => 129.99, 'currency' => 'USD'],
            'availability' => ['inStock' => true, 'text' => 'In stock'],
            'variants' => [
                [
                    'id' => 'v1',
                    'sku' => 'SHOE-RED-42',
                    'title' => 'Red / 42',
                    'values' => ['color' => 'red', 'size' => '42'],
                    'price' => ['amount' => 99.99],
                    'availability' => ['inStock' => false],
                    'images' => [['url' => 'https://example.com/shoe-red.jpg']],
                ],
            ],
        ],
    ]);

    $product = $doc->getProduct();

    expect($product)->toBeInstanceOf(Product::class);
    expect($product->getTitle())->toBe('Running Shoe');
    expect($product->getBrand())->toBe('Acme');
    expect($product->getCategory())->toBe('Footwear');
    expect($product->getUrl())->toBe('https://example.com/shoe');
    expect($product->getDescription())->toBe('A fast running shoe.');
    expect($product->getImages())->toHaveCount(2);
    expect($product->getImages()[0])->toBe(['url' => 'https://example.com/shoe.jpg', 'alt' => 'Side view']);
    expect($product->getImages()[1])->toBe(['url' => 'https://example.com/shoe-2.jpg']);
    expect($product->getPrice())->toBe(['amount' => 99.99, 'currency' => 'USD', 'formatted' => '$99.99']);
    expect($product->getOriginalPrice())->toBe(['amount' => 129.99, 'currency' => 'USD']);
    expect($product->getAvailability())->toBe(['inStock' => true, 'text' => 'In stock']);
    expect($product->getVariants())->toHaveCount(1);
    expect($product->getVariants()[0]['id'])->toBe('v1');
    expect($product->getVariants()[0]['values'])->toBe(['color' => 'red', 'size' => '42']);
    expect($product->getVariants()[0]['availability'])->toBe(['inStock' => false]);
});

it('returns null product when absent in Document', function (): void {
    $doc = Document::fromArray(['markdown' => '# No product']);

    expect($doc->getProduct())->toBeNull();
});

it('preserves positional integration in ScrapeOptions::with', function (): void {
    $options = ScrapeOptions::with(
        null,
        null,
        null,
        null,
        null,
        null,
        null,
        null,
        null,
        null,
        null,
        null,
        null,
        null,
        null,
        null,
        false,
        'php-sdk',
    );

    expect($options->getStoreInCache())->toBeFalse();
    expect($options->getIntegration())->toBe('php-sdk');
    expect($options->getLockdown())->toBeNull();
    expect($options->toArray())->toMatchArray([
        'storeInCache' => false,
        'integration' => 'php-sdk',
    ]);
});

it('serializes lockdown in ScrapeOptions', function (): void {
    $options = ScrapeOptions::with(
        lockdown: true,
        integration: 'php-sdk',
    );

    expect($options->getLockdown())->toBeTrue();
    expect($options->toArray())->toMatchArray([
        'lockdown' => true,
        'integration' => 'php-sdk',
    ]);
});

it('serializes redactPII in ScrapeOptions', function (): void {
    $options = ScrapeOptions::with(
        redactPII: true,
    );

    expect($options->getRedactPII())->toBeTrue();
    expect($options->toArray())->toMatchArray([
        'redactPII' => true,
    ]);
    expect(array_key_exists('formats', $options->toArray()))->toBeFalse();
});

it('serializes query format mode in ScrapeOptions', function (): void {
    $options = ScrapeOptions::with(
        formats: [QueryFormat::with('What is Firecrawl?', QueryFormat::MODE_DIRECT_QUOTE)],
    );

    expect($options->toArray()['formats'][0])->toMatchArray([
        'type' => 'query',
        'prompt' => 'What is Firecrawl?',
        'mode' => 'directQuote',
    ]);
});

it('serializes question and highlights formats in ScrapeOptions', function (): void {
    $options = ScrapeOptions::with(
        formats: [
            QuestionFormat::with('What is Firecrawl?'),
            HighlightsFormat::with('What is Firecrawl?'),
        ],
    );

    expect($options->toArray()['formats'])->toMatchArray([
        [
            'type' => 'question',
            'question' => 'What is Firecrawl?',
        ],
        [
            'type' => 'highlights',
            'query' => 'What is Firecrawl?',
        ],
    ]);
});

it('rejects invalid query format mode', function (): void {
    QueryFormat::with('What is Firecrawl?', 'quoted');
})->throws(InvalidArgumentException::class, "query mode must be 'freeform' or 'directQuote'");
