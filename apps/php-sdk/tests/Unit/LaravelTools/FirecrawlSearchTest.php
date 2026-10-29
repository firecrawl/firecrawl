<?php

declare(strict_types=1);

use Firecrawl\Laravel\Tools\FirecrawlSearch;
use GuzzleHttp\Psr7\Response;
use Illuminate\JsonSchema\JsonSchemaTypeFactory;
use Laravel\Ai\ObjectSchema;
use Laravel\Ai\Tools\Request;

it('searches the web and returns JSON results', function (): void {
    $history = new ArrayObject();
    $client = fakeFirecrawlClient([
        new Response(200, [], json_encode([
            'success' => true,
            'data' => [
                'web' => [
                    ['title' => 'Firecrawl', 'url' => 'https://firecrawl.dev', 'description' => 'Web data API', 'position' => 1],
                ],
            ],
        ])),
    ], $history);

    $result = (new FirecrawlSearch($client))->handle(new Request(['query' => 'firecrawl']));

    expect(json_decode($result, true))->toBe([
        ['title' => 'Firecrawl', 'url' => 'https://firecrawl.dev', 'description' => 'Web data API'],
    ]);

    $body = json_decode((string) $history[0]['request']->getBody(), true);
    expect($body['query'])->toBe('firecrawl');
    expect($body['limit'])->toBe(5);
    expect($body['integration'])->toBe('_laravel-ai');
});

it('clamps the limit between 1 and 20', function (): void {
    $history = new ArrayObject();
    $client = fakeFirecrawlClient([
        new Response(200, [], json_encode(['success' => true, 'data' => ['web' => []]])),
    ], $history);

    (new FirecrawlSearch($client))->handle(new Request(['query' => 'x', 'limit' => 99]));

    $body = json_decode((string) $history[0]['request']->getBody(), true);
    expect($body['limit'])->toBe(20);
});

it('reports when no results were found', function (): void {
    $client = fakeFirecrawlClient([
        new Response(200, [], json_encode(['success' => true, 'data' => ['web' => []]])),
    ]);

    $result = (new FirecrawlSearch($client))->handle(new Request(['query' => 'x']));

    expect($result)->toBe('No results found.');
});

it('surfaces a success:false envelope as an error instead of empty results', function (): void {
    $client = fakeFirecrawlClient([
        new Response(200, [], json_encode([
            'success' => false,
            'error' => 'DNS resolution failed for host: nosuchdomain.example',
        ])),
    ]);

    $result = (new FirecrawlSearch($client))->handle(new Request(['query' => 'nosuchdomain.example']));

    expect($result)->toStartWith('Firecrawl request failed: DNS resolution failed');
});

it('exposes name and a schema with required query and optional limit', function (): void {
    $tool = new FirecrawlSearch(fakeFirecrawlClient([]));

    expect($tool->name())->toBe('firecrawl_search');

    $types = $tool->schema(new JsonSchemaTypeFactory());
    expect($types)->toHaveKeys(['query', 'limit']);

    $jsonSchema = (new ObjectSchema($types))->toSchema();
    expect($jsonSchema['required'])->toContain('query');
    expect($jsonSchema['required'])->not->toContain('limit');
});
