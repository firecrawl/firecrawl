<?php

declare(strict_types=1);

use GuzzleHttp\Psr7\Response;

it('sends the browser location option in the request body', function (): void {
    $history = new ArrayObject();
    $client = fakeFirecrawlClient([
        new Response(200, [], json_encode(['success' => true, 'id' => 'session-1'])),
    ], $history);

    $client->browser(location: ['country' => 'GB']);

    $request = $history[0]['request'];
    expect($request->getUri()->getPath())->toBe('/v2/browser');
    expect(json_decode((string) $request->getBody(), true))->toBe(['location' => ['country' => 'GB']]);
});

it('omits the browser location option when it is unset', function (): void {
    $history = new ArrayObject();
    $client = fakeFirecrawlClient([
        new Response(200, [], json_encode(['success' => true, 'id' => 'session-1'])),
    ], $history);

    $client->browser(ttl: 60);

    expect(json_decode((string) $history[0]['request']->getBody(), true))->toBe(['ttl' => 60]);
});
