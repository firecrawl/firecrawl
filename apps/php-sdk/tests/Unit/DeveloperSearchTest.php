<?php

declare(strict_types=1);

use Firecrawl\Exceptions\FirecrawlException;
use Firecrawl\Models\DeveloperSearchOptions;
use Firecrawl\Version;
use GuzzleHttp\Psr7\Response;

it('posts the query, filters and origin to the developer index', function (): void {
    $history = new ArrayObject();
    $client = fakeFirecrawlClient([
        new Response(200, [], json_encode([
            'success' => true,
            'partial' => false,
            'results' => [
                [
                    'id' => 'issue:square/okhttp#1',
                    'url' => 'https://github.com/square/okhttp/issues/1',
                    'title' => 'retry',
                    'passages' => [['text' => 'use backoff', 'citation_url' => 'https://github.com/square/okhttp/issues/1#c1']],
                    'license' => ['state' => 'licensed', 'spdx_id' => 'Apache-2.0'],
                ],
                [
                    'id' => 'readme:square/okhttp',
                    'url' => 'https://github.com/square/okhttp',
                    'passages' => [],
                    'license' => 'Apache-2.0',
                ],
            ],
            'repos' => [[
                'repo' => 'square/okhttp',
                'indexed' => true,
                'types' => ['issue' => true, 'pullRequest' => true, 'readme' => false],
            ]],
        ])),
    ], $history);

    $response = $client->developerSearch('retry backoff', DeveloperSearchOptions::with(
        k: 5,
        types: ['issue'],
        repos: ['square/okhttp'],
        minStars: 100,
    ));

    $request = $history[0]['request'];
    expect($request->getMethod())->toBe('POST');
    expect($request->getUri()->getPath())->toBe('/v2/search/developer');

    $body = json_decode((string) $request->getBody(), true);
    expect($body)->toBe([
        'query' => 'retry backoff',
        'k' => 5,
        'types' => ['issue'],
        'repos' => ['square/okhttp'],
        'min_stars' => 100,
        'origin' => 'php-sdk@' . Version::SDK_VERSION,
    ]);

    expect($response->isSuccess())->toBeTrue();
    expect($response->isPartial())->toBeFalse();
    expect($response->getResults())->toHaveCount(2);

    $first = $response->getResults()[0];
    expect($first->getId())->toBe('issue:square/okhttp#1');
    expect($first->getTitle())->toBe('retry');
    expect($first->getPassages()[0]->getCitationUrl())->toBe('https://github.com/square/okhttp/issues/1#c1');
    expect($first->getLicense())->toBe(['state' => 'licensed', 'spdx_id' => 'Apache-2.0']);

    $second = $response->getResults()[1];
    expect($second->getTitle())->toBeNull();
    expect($second->getLicense())->toBe('Apache-2.0');

    $repo = $response->getRepos()[0];
    expect($repo->getRepo())->toBe('square/okhttp');
    expect($repo->isIndexed())->toBeTrue();
    expect($repo->getTypes()['pullRequest'])->toBeTrue();
    expect($repo->getTypes()['readme'])->toBeFalse();
    expect($response->getSources())->toBeNull();
});

it('sends only the query and origin when no options are given', function (): void {
    $history = new ArrayObject();
    $client = fakeFirecrawlClient([
        new Response(200, [], json_encode(['success' => true, 'results' => []])),
    ], $history);

    $response = $client->developerSearch('okhttp interceptor');

    $body = json_decode((string) $history[0]['request']->getBody(), true);
    expect(array_keys($body))->toBe(['query', 'origin']);
    expect($response->getResults())->toBe([]);
    expect($response->getRepos())->toBeNull();
});

it('rejects a blank query before sending a request', function (): void {
    $history = new ArrayObject();
    $client = fakeFirecrawlClient([], $history);

    expect(fn () => $client->developerSearch('   '))->toThrow(FirecrawlException::class, 'Query cannot be empty');
    expect($history)->toHaveCount(0);
});

it('serializes every developer search filter with the API field names', function (): void {
    $options = DeveloperSearchOptions::with(
        k: 10,
        passages: 2,
        types: ['doc'],
        repos: ['square/okhttp'],
        sources: ['okhttp-docs'],
        language: 'Kotlin',
        topic: ['http'],
        license: 'Apache-2.0',
        minStars: 10,
        maxStars: 1000,
        archived: false,
        fork: false,
        skills: 'only',
    );

    expect($options->toArray())->toBe([
        'k' => 10,
        'passages' => 2,
        'types' => ['doc'],
        'repos' => ['square/okhttp'],
        'sources' => ['okhttp-docs'],
        'language' => 'Kotlin',
        'topic' => ['http'],
        'license' => 'Apache-2.0',
        'min_stars' => 10,
        'max_stars' => 1000,
        'archived' => false,
        'fork' => false,
        'skills' => 'only',
    ]);
});
