<?php

declare(strict_types=1);

use Firecrawl\Laravel\Tools\FirecrawlCrawl;
use GuzzleHttp\Psr7\Response;
use Illuminate\JsonSchema\JsonSchemaTypeFactory;
use Laravel\Ai\ObjectSchema;
use Laravel\Ai\Tools\Request;

it('crawls a site and returns status and pages as JSON', function (): void {
    $history = new ArrayObject();
    $client = fakeFirecrawlClient([
        new Response(200, [], json_encode(['success' => true, 'id' => 'job-1'])),
        new Response(200, [], json_encode([
            'success' => true,
            'status' => 'completed',
            'total' => 1,
            'completed' => 1,
            'data' => [
                ['markdown' => '# Page 1', 'metadata' => ['sourceURL' => 'https://example.com/p1']],
            ],
        ])),
    ], $history);

    $result = (new FirecrawlCrawl($client))->handle(new Request(['url' => 'https://example.com']));

    expect(json_decode($result, true))->toBe([
        'status' => 'completed',
        'completed' => 1,
        'total' => 1,
        'pages' => [
            ['url' => 'https://example.com/p1', 'markdown' => '# Page 1'],
        ],
    ]);

    $body = json_decode((string) $history[0]['request']->getBody(), true);
    expect($body['url'])->toBe('https://example.com');
    expect($body['limit'])->toBe(5);
    expect($body['scrapeOptions']['formats'])->toBe(['markdown']);
    expect($body['integration'])->toBe('_laravel-ai');
    expect($history[0]['request']->getHeaderLine('x-idempotency-key'))
        ->toMatch('/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/');
});

it('clamps the page limit between 1 and 25', function (): void {
    $history = new ArrayObject();
    $client = fakeFirecrawlClient([
        new Response(200, [], json_encode(['success' => true, 'id' => 'job-1'])),
        new Response(200, [], json_encode([
            'success' => true, 'status' => 'completed', 'total' => 0, 'completed' => 0, 'data' => [],
        ])),
    ], $history);

    (new FirecrawlCrawl($client))->handle(new Request(['url' => 'https://example.com', 'limit' => 500]));

    $body = json_decode((string) $history[0]['request']->getBody(), true);
    expect($body['limit'])->toBe(25);
});

it('reuses the same idempotency key across HTTP retries of the start request', function (): void {
    $history = new ArrayObject();
    $client = fakeFirecrawlClient([
        new Response(502, [], json_encode(['error' => 'bad gateway'])),
        new Response(200, [], json_encode(['success' => true, 'id' => 'job-1'])),
        new Response(200, [], json_encode([
            'success' => true, 'status' => 'completed', 'total' => 0, 'completed' => 0, 'data' => [],
        ])),
    ], $history);

    (new FirecrawlCrawl($client))->handle(new Request(['url' => 'https://example.com']));

    $firstKey = $history[0]['request']->getHeaderLine('x-idempotency-key');
    $retryKey = $history[1]['request']->getHeaderLine('x-idempotency-key');
    expect($history[0]['request']->getMethod())->toBe('POST');
    expect($history[1]['request']->getMethod())->toBe('POST');
    expect($firstKey)->toMatch('/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/');
    expect($retryKey)->toBe($firstKey);
});

it('surfaces failed crawls with partial pages and does not follow pagination', function (): void {
    $history = new ArrayObject();
    $client = fakeFirecrawlClient([
        new Response(200, [], json_encode(['success' => true, 'id' => 'job-1'])),
        new Response(200, [], json_encode([
            'success' => true,
            'status' => 'failed',
            'total' => 5,
            'completed' => 2,
            'next' => 'https://api.firecrawl.dev/v2/crawl/job-1?skip=1',
            'data' => [
                ['markdown' => '# Partial page', 'metadata' => ['sourceURL' => 'https://example.com/p1']],
            ],
        ])),
    ], $history);

    $result = (new FirecrawlCrawl($client))->handle(new Request(['url' => 'https://example.com']));
    $decoded = json_decode($result, true);

    expect($decoded['status'])->toBe('failed');
    expect($decoded['pages'])->toHaveCount(1);
    expect($decoded['note'])->toContain('More pages exist');
    expect($history)->toHaveCount(2);
});

it('applies the whole-result budget across pages', function (): void {
    $client = fakeFirecrawlClient([
        new Response(200, [], json_encode(['success' => true, 'id' => 'job-1'])),
        new Response(200, [], json_encode([
            'success' => true,
            'status' => 'completed',
            'total' => 3,
            'completed' => 3,
            'data' => [
                ['markdown' => str_repeat('a', 40), 'metadata' => ['sourceURL' => 'https://example.com/1']],
                ['markdown' => str_repeat('b', 40), 'metadata' => ['sourceURL' => 'https://example.com/2']],
                ['markdown' => str_repeat('c', 40), 'metadata' => ['sourceURL' => 'https://example.com/3']],
            ],
        ])),
    ]);

    $tool = new class ($client) extends FirecrawlCrawl {
        protected int $outputCharacterBudget = 60;
    };

    $decoded = json_decode($tool->handle(new Request(['url' => 'https://example.com'])), true);

    expect($decoded['pages'])->toHaveCount(1);
    expect($decoded['omittedPages'])->toBe(2);
});

it('returns a timeout message when the crawl runs long', function (): void {
    $client = fakeFirecrawlClient([
        new Response(200, [], json_encode(['success' => true, 'id' => 'job-1'])),
        new Response(200, [], json_encode([
            'success' => true, 'status' => 'scraping', 'total' => 0, 'completed' => 0, 'data' => [],
        ])),
        new Response(200, [], json_encode([
            'success' => true, 'status' => 'scraping', 'total' => 0, 'completed' => 0, 'data' => [],
        ])),
    ]);

    $tool = new class ($client) extends FirecrawlCrawl {
        protected int $timeoutSeconds = 1;
        protected int $pollIntervalSeconds = 1;
    };

    $result = $tool->handle(new Request(['url' => 'https://example.com']));

    expect($result)->toContain('did not finish within 1 seconds');
    expect($result)->toContain('may still complete on the server');
});

it('returns API failures as readable strings instead of throwing', function (): void {
    $client = fakeFirecrawlClient([
        new Response(400, [], json_encode(['error' => 'Invalid URL'])),
    ]);

    $result = (new FirecrawlCrawl($client))->handle(new Request(['url' => 'not-a-url']));

    expect($result)->toStartWith('Firecrawl request failed:');
});

it('exposes name and a schema with required url and optional limit', function (): void {
    $tool = new FirecrawlCrawl(fakeFirecrawlClient([]));

    expect($tool->name())->toBe('firecrawl_crawl');

    $types = $tool->schema(new JsonSchemaTypeFactory());
    expect($types)->toHaveKeys(['url', 'limit']);

    $jsonSchema = (new ObjectSchema($types))->toSchema();
    expect($jsonSchema['required'])->toContain('url');
    expect($jsonSchema['required'])->not->toContain('limit');
});

it('bounds each HTTP request by the remaining deadline', function (): void {
    $history = new ArrayObject();
    $client = fakeFirecrawlClient([
        new Response(200, [], json_encode(['success' => true, 'id' => 'job-1'])),
        new Response(200, [], json_encode([
            'success' => true, 'status' => 'completed', 'total' => 0, 'completed' => 0, 'data' => [],
        ])),
    ], $history);

    (new FirecrawlCrawl($client))->handle(new Request(['url' => 'https://example.com']));

    foreach ([0, 1] as $i) {
        $timeout = $history[$i]['options'][GuzzleHttp\RequestOptions::TIMEOUT] ?? null;
        expect($timeout)->toBeFloat()->toBeGreaterThan(0)->toBeLessThanOrEqual(55.0);
    }
});
