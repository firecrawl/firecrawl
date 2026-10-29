<?php

declare(strict_types=1);

use Firecrawl\Client\FirecrawlClient;
use Firecrawl\Laravel\Tools\FirecrawlScrape;
use GuzzleHttp\Psr7\Response;
use Illuminate\Container\Container;
use Illuminate\JsonSchema\JsonSchemaTypeFactory;
use Laravel\Ai\ObjectSchema;
use Laravel\Ai\Tools\Request;

it('scrapes a URL and returns markdown', function (): void {
    $history = new ArrayObject();
    $client = fakeFirecrawlClient([
        new Response(200, [], json_encode([
            'success' => true,
            'data' => [
                'markdown' => '# Example Page',
                'metadata' => ['title' => 'Example', 'sourceURL' => 'https://example.com'],
            ],
        ])),
    ], $history);

    $result = (new FirecrawlScrape($client))->handle(new Request(['url' => 'https://example.com']));

    expect($result)->toBe('# Example Page');

    $body = json_decode((string) $history[0]['request']->getBody(), true);
    expect($body['url'])->toBe('https://example.com');
    expect($body['formats'])->toBe(['markdown']);
    expect($body['integration'])->toBe('_laravel-ai');
});

it('prepends scrape warnings to the content', function (): void {
    $client = fakeFirecrawlClient([
        new Response(200, [], json_encode([
            'success' => true,
            'data' => ['markdown' => '# Partial', 'warning' => 'Page loaded partially'],
        ])),
    ]);

    $result = (new FirecrawlScrape($client))->handle(new Request(['url' => 'https://example.com']));

    expect($result)->toBe("Warning: Page loaded partially\n\n# Partial");
});

it('reports empty documents instead of returning an empty string', function (): void {
    $client = fakeFirecrawlClient([
        new Response(200, [], json_encode(['success' => true, 'data' => []])),
    ]);

    $result = (new FirecrawlScrape($client))->handle(new Request(['url' => 'https://example.com']));

    expect($result)->toBe('No content was returned for this page.');
});

it('returns API failures as readable strings instead of throwing', function (): void {
    $client = fakeFirecrawlClient([
        new Response(401, [], json_encode(['error' => 'Unauthorized: invalid token'])),
    ]);

    $result = (new FirecrawlScrape($client))->handle(new Request(['url' => 'https://example.com']));

    expect($result)->toStartWith('Firecrawl request failed:');
});

it('surfaces a success:false envelope as an error instead of empty content', function (): void {
    $client = fakeFirecrawlClient([
        new Response(200, [], json_encode([
            'success' => false,
            'error' => 'DNS resolution failed for host: nosuchdomain.example',
        ])),
    ]);

    $result = (new FirecrawlScrape($client))->handle(new Request(['url' => 'https://nosuchdomain.example']));

    expect($result)->toStartWith('Firecrawl request failed: DNS resolution failed');
});

it('truncates markdown longer than 80000 characters', function (): void {
    $prefix = str_repeat('a', 80000);
    $client = fakeFirecrawlClient([
        new Response(200, [], json_encode([
            'success' => true,
            'data' => ['markdown' => $prefix . str_repeat('b', 100)],
        ])),
    ]);

    $result = (new FirecrawlScrape($client))->handle(new Request(['url' => 'https://example.com']));

    expect(mb_strlen($result))->toBeLessThanOrEqual(80000);
    expect($result)->toStartWith(str_repeat('a', 1000));
    expect($result)->toEndWith('[Truncated: 80100 characters total.]');
});

it('resolves the client from the container when none is injected', function (): void {
    $container = new Container();
    $container->instance(FirecrawlClient::class, fakeFirecrawlClient([
        new Response(200, [], json_encode(['success' => true, 'data' => ['markdown' => '# Via Container']])),
    ]));
    Container::setInstance($container);

    try {
        $result = (new FirecrawlScrape())->handle(new Request(['url' => 'https://example.com']));
    } finally {
        Container::setInstance(null);
    }

    expect($result)->toBe('# Via Container');
});

it('converts non-SDK failures into readable strings instead of throwing', function (): void {
    Container::setInstance(new Container());

    try {
        $result = (new FirecrawlScrape())->handle(new Request(['url' => 'https://example.com']));
    } finally {
        Container::setInstance(null);
    }

    expect($result)->toStartWith('Tool execution failed:');
});

it('exposes name, description, and a required url parameter', function (): void {
    $tool = new FirecrawlScrape(fakeFirecrawlClient([]));

    expect($tool->name())->toBe('firecrawl_scrape');
    expect((string) $tool->description())->not->toBe('');

    $types = $tool->schema(new JsonSchemaTypeFactory());
    expect($types)->toHaveKey('url');

    $jsonSchema = (new ObjectSchema($types))->toSchema();
    expect($jsonSchema['required'])->toContain('url');
});
