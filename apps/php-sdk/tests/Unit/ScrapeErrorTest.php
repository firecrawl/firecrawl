<?php

declare(strict_types=1);

use Firecrawl\Exceptions\FirecrawlException;
use GuzzleHttp\Psr7\Response;

it('throws with the API error code when scrape returns success false', function (): void {
    $client = fakeFirecrawlClient([
        new Response(200, [], json_encode([
            'success' => false,
            'code' => 'SCRAPE_DNS_RESOLUTION_ERROR',
            'error' => 'DNS resolution failed for hostname "nonexistent.example".',
        ])),
    ]);

    try {
        $client->scrape('https://nonexistent.example');
        $this->fail('Expected FirecrawlException');
    } catch (FirecrawlException $e) {
        expect($e->getStatusCode())->toBe(200);
        expect($e->getErrorCode())->toBe('SCRAPE_DNS_RESOLUTION_ERROR');
        expect($e->getMessage())->toBe('DNS resolution failed for hostname "nonexistent.example".');
    }
});
