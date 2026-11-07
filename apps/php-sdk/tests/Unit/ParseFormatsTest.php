<?php

declare(strict_types=1);

use Firecrawl\Exceptions\AuthenticationException;
use Firecrawl\Exceptions\FirecrawlException;
use Firecrawl\Models\ParseFormat;
use GuzzleHttp\Psr7\Response;

it('fetches parse formats from GET /v2/parse/formats', function (): void {
    $history = new ArrayObject();
    $client = fakeFirecrawlClient([
        new Response(200, [], json_encode([
            'success' => true,
            'data' => [
                'formats' => [
                    [
                        'format' => 'pdf',
                        'kind' => 'document',
                        'extensions' => ['.pdf'],
                        'mimeTypes' => ['application/pdf'],
                        'available' => true,
                    ],
                    [
                        'format' => 'png',
                        'kind' => 'image',
                        'extensions' => ['.png'],
                        'mimeTypes' => ['image/png'],
                        'available' => false,
                    ],
                ],
            ],
        ])),
    ], $history);

    $formats = $client->getParseFormats();

    $request = $history[0]['request'];
    expect($request->getMethod())->toBe('GET');
    expect($request->getUri()->getPath())->toBe('/v2/parse/formats');
    expect($request->getHeaderLine('Authorization'))->toBe('Bearer fc-test');

    expect($formats)->toHaveCount(2);
    expect($formats[0])->toBeInstanceOf(ParseFormat::class);
    expect($formats[0]->getFormat())->toBe('pdf');
    expect($formats[0]->getKind())->toBe(ParseFormat::KIND_DOCUMENT);
    expect($formats[0]->isDocument())->toBeTrue();
    expect($formats[0]->getExtensions())->toBe(['.pdf']);
    expect($formats[0]->getMimeTypes())->toBe(['application/pdf']);
    expect($formats[0]->isAvailable())->toBeTrue();

    expect($formats[1]->getFormat())->toBe('png');
    expect($formats[1]->getKind())->toBe(ParseFormat::KIND_IMAGE);
    expect($formats[1]->isImage())->toBeTrue();
    expect($formats[1]->getMimeTypes())->toBe(['image/png']);
    expect($formats[1]->isAvailable())->toBeFalse();
});

it('keeps unknown kinds and ignores unknown fields', function (): void {
    $client = fakeFirecrawlClient([
        new Response(200, [], json_encode([
            'success' => true,
            'data' => [
                'formats' => [
                    [
                        'format' => 'mp4',
                        'kind' => 'video',
                        'extensions' => ['.mp4'],
                        'mimeTypes' => ['video/mp4'],
                        'available' => true,
                        'maxSizeBytes' => 1024,
                    ],
                ],
            ],
        ])),
    ]);

    $formats = $client->getParseFormats();

    expect($formats)->toHaveCount(1);
    expect($formats[0]->getFormat())->toBe('mp4');
    expect($formats[0]->getKind())->toBe('video');
    expect($formats[0]->isDocument())->toBeFalse();
    expect($formats[0]->isImage())->toBeFalse();
    expect($formats[0]->getMimeTypes())->toBe(['video/mp4']);
});

it('throws AuthenticationException on 401', function (): void {
    $client = fakeFirecrawlClient([
        new Response(401, [], json_encode(['success' => false, 'error' => 'Unauthorized'])),
    ]);

    $client->getParseFormats();
})->throws(AuthenticationException::class, 'Unauthorized');

it('throws FirecrawlException when the endpoint is missing', function (): void {
    $client = fakeFirecrawlClient([
        new Response(404, [], json_encode(['success' => false, 'error' => 'Not found'])),
    ]);

    $client->getParseFormats();
})->throws(FirecrawlException::class, 'Not found');
