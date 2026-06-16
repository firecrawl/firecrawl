<?php

declare(strict_types=1);

use Firecrawl\Models\CreditUsage;
use Firecrawl\Models\Document;
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
        'videos' => [
            [
                'url' => 'https://cdn.example.com/product.mp4',
                'sourceURL' => 'https://example.com/product',
                'source' => 'script',
                'kind' => 'file',
                'provider' => 'cdn.example.com',
                'title' => 'Product video',
                'thumbnail' => 'https://cdn.example.com/poster.jpg',
                'description' => 'Product overview',
                'duration' => 'PT45S',
                'mimeType' => 'video/mp4',
                'width' => 1920,
                'height' => 1080,
                'metadata' => ['resourceType' => 'Media'],
            ],
        ],
    ]);

    expect($doc->getMarkdown())->toBe('# Video');
    expect($doc->getVideo())->toBe('https://storage.googleapis.com/firecrawl/video.mp4');
    expect($doc->getVideos())->toHaveCount(1);
    expect($doc->getVideos()[0]['sourceURL'])->toBe('https://example.com/product');
    expect($doc->getVideos()[0]['thumbnail'])->toBe('https://cdn.example.com/poster.jpg');
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
