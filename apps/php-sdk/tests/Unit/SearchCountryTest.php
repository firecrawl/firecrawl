<?php

declare(strict_types=1);

use Firecrawl\Models\SearchOptions;
use GuzzleHttp\Psr7\Response;

it('sends the search country option in the request body', function (): void {
    $history = new ArrayObject();
    $client = fakeFirecrawlClient([
        new Response(200, [], json_encode(['success' => true, 'data' => ['web' => []]])),
    ], $history);

    $client->search('firecrawl', SearchOptions::with(country: 'de'));

    $body = json_decode((string) $history[0]['request']->getBody(), true);
    expect($body['query'])->toBe('firecrawl');
    expect($body['country'])->toBe('de');
});

it('omits the search country option when it is unset', function (): void {
    $history = new ArrayObject();
    $client = fakeFirecrawlClient([
        new Response(200, [], json_encode(['success' => true, 'data' => ['web' => []]])),
    ], $history);

    $client->search('firecrawl', SearchOptions::with(limit: 5));

    $body = json_decode((string) $history[0]['request']->getBody(), true);
    expect($body['limit'])->toBe(5);
    expect(array_key_exists('country', $body))->toBeFalse();
});

it('serializes the search country option', function (): void {
    $options = SearchOptions::with(country: 'de');

    expect($options->toArray())->toBe(['country' => 'de']);
});
