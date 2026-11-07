<?php

declare(strict_types=1);

use Firecrawl\Models\BatchScrapeOptions;
use Firecrawl\Models\JsonFormat;
use Firecrawl\Models\ScrapeOptions;
use Firecrawl\Version;
use GuzzleHttp\Psr7\Response;

it('sends changeTracking as a format alongside markdown', function (): void {
    expect(ScrapeOptions::with(changeTracking: true)->toArray())
        ->toBe(['formats' => ['markdown', 'changeTracking']]);

    expect(ScrapeOptions::with(formats: ['html'], changeTracking: true)->toArray())
        ->toBe(['formats' => ['html', 'markdown', 'changeTracking']]);
});

it('keeps existing markdown and changeTracking formats', function (): void {
    $options = ScrapeOptions::with(
        formats: ['changeTracking', JsonFormat::with(prompt: 'title'), 'markdown'],
        changeTracking: true,
    );

    expect($options->toArray()['formats'])
        ->toBe(['changeTracking', ['type' => 'json', 'prompt' => 'title'], 'markdown']);
});

it('never sends a top-level changeTracking key', function (): void {
    expect(ScrapeOptions::with(formats: [JsonFormat::with(prompt: 'title')], changeTracking: true)->toArray())
        ->not->toHaveKey('changeTracking');
    expect(ScrapeOptions::with(formats: ['html'], changeTracking: false)->toArray())
        ->toBe(['formats' => ['html']]);
});

it('sends the SDK origin on crawl, batch scrape and map', function (): void {
    $history = new ArrayObject();
    $client = fakeFirecrawlClient([
        new Response(200, [], json_encode(['success' => true, 'id' => 'crawl-1', 'url' => 'https://api.firecrawl.dev/v2/crawl/crawl-1'])),
        new Response(200, [], json_encode(['success' => true, 'id' => 'batch-1', 'url' => 'https://api.firecrawl.dev/v2/batch/scrape/batch-1'])),
        new Response(200, [], json_encode(['success' => true, 'links' => []])),
    ], $history);

    $client->startCrawl('https://example.com');
    $client->startBatchScrape(['https://example.com'], BatchScrapeOptions::with(
        options: ScrapeOptions::with(changeTracking: true),
    ));
    $client->map('https://example.com');

    $bodies = array_map(
        fn (array $entry): array => json_decode((string) $entry['request']->getBody(), true),
        $history->getArrayCopy(),
    );
    foreach ($bodies as $body) {
        expect($body['origin'])->toBe('php-sdk@' . Version::SDK_VERSION);
    }
    expect($bodies[1]['formats'])->toBe(['markdown', 'changeTracking']);
    expect($bodies[1])->not->toHaveKey('changeTracking');
});
