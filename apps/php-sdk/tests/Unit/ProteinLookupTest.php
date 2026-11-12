<?php

declare(strict_types=1);

use Firecrawl\Version;
use GuzzleHttp\Psr7\Response;

it('sends the protein, the organism when set and the origin as query parameters', function (): void {
    $history = new ArrayObject();
    $client = fakeFirecrawlClient([
        new Response(200, [], json_encode(['success' => true, 'match' => 'found'])),
        new Response(200, [], json_encode(['success' => true, 'match' => 'found'])),
    ], $history);

    $client->lookupProtein('TP53', ['organism' => 'human']);
    $client->lookupProtein('P04637');

    $origin = 'php-sdk@' . Version::SDK_VERSION;

    $withOrganism = $history[0]['request']->getUri();
    expect($withOrganism->getPath())->toBe('/v2/search/research/proteins');
    parse_str($withOrganism->getQuery(), $query);
    expect($query)->toEqual(['protein' => 'TP53', 'organism' => 'human', 'origin' => $origin]);

    $withoutOrganism = $history[1]['request']->getUri();
    expect($withoutOrganism->getPath())->toBe('/v2/search/research/proteins');
    parse_str($withoutOrganism->getQuery(), $query);
    expect($query)->toEqual(['protein' => 'P04637', 'origin' => $origin]);
});
