<?php

declare(strict_types=1);

use Firecrawl\Client\FirecrawlClient;
use GuzzleHttp\Client;
use GuzzleHttp\Handler\MockHandler;
use GuzzleHttp\HandlerStack;
use GuzzleHttp\Middleware;

uses()->group('unit')->in('Unit');

/**
 * Build a FirecrawlClient whose HTTP layer is a Guzzle MockHandler queue.
 * Pass an ArrayObject as $history to capture the requests that were sent.
 *
 * @param list<\GuzzleHttp\Psr7\Response> $responses
 */
function fakeFirecrawlClient(array $responses, ?ArrayObject $history = null): FirecrawlClient
{
    $stack = HandlerStack::create(new MockHandler($responses));

    if ($history !== null) {
        $stack->push(Middleware::history($history));
    }

    return FirecrawlClient::create(
        apiKey: 'fc-test',
        httpClient: new Client(['handler' => $stack, 'http_errors' => false]),
    );
}
