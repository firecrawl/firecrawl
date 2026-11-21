<?php

declare(strict_types=1);

use Firecrawl\Models\RedactPIIOptions;
use Firecrawl\Models\ScrapeOptions;
use GuzzleHttp\Psr7\Response;

it('serializes fastMode, useMock, onlyCleanContent and safeMode', function (): void {
    expect(ScrapeOptions::with(
        fastMode: true,
        useMock: 'example-fixture',
        onlyCleanContent: true,
        safeMode: false,
    )->toArray())->toBe([
        'fastMode' => true,
        'useMock' => 'example-fixture',
        'onlyCleanContent' => true,
        'safeMode' => false,
    ]);
});

it('omits the new v2 options when they are unset', function (): void {
    expect(ScrapeOptions::with(formats: ['markdown'])->toArray())
        ->toBe(['formats' => ['markdown']]);
});

it('serializes the object form of redactPII', function (): void {
    $options = ScrapeOptions::with(redactPII: RedactPIIOptions::with(
        mode: RedactPIIOptions::MODE_FAST,
        entities: [RedactPIIOptions::ENTITY_EMAIL, RedactPIIOptions::ENTITY_PHONE],
        replaceStyle: RedactPIIOptions::REPLACE_STYLE_MASK,
    ));

    expect($options->toArray()['redactPII'])->toBe([
        'mode' => 'fast',
        'entities' => ['EMAIL', 'PHONE'],
        'replaceStyle' => 'mask',
    ]);
    expect($options->getRedactPII())->toBeInstanceOf(RedactPIIOptions::class);
});

it('keeps the boolean form of redactPII', function (): void {
    expect(ScrapeOptions::with(redactPII: true)->toArray())
        ->toBe(['redactPII' => true]);
    expect(ScrapeOptions::with(redactPII: false)->toArray())
        ->toBe(['redactPII' => false]);
});

it('omits redactPII when it is unset', function (): void {
    expect(ScrapeOptions::with()->toArray())->not->toHaveKey('redactPII');
});

it('accepts the saveChanges flag in profile', function (): void {
    expect(ScrapeOptions::with(profile: ['name' => 'docs', 'saveChanges' => false])->toArray())
        ->toBe(['profile' => ['name' => 'docs', 'saveChanges' => false]]);
});

it('sends the new options on the scrape request', function (): void {    $history = new ArrayObject();
    $client = fakeFirecrawlClient([
        new Response(200, [], json_encode(['success' => true, 'data' => ['markdown' => '# Hi']])),
    ], $history);

    $client->scrape('https://example.com', ScrapeOptions::with(
        fastMode: true,
        safeMode: true,
        redactPII: RedactPIIOptions::with(mode: RedactPIIOptions::MODE_AGGRESSIVE),
    ));

    $body = json_decode((string) $history[0]['request']->getBody(), true);
    expect($body['fastMode'])->toBeTrue();
    expect($body['safeMode'])->toBeTrue();
    expect($body['redactPII'])->toBe(['mode' => 'aggressive']);
});

it('rejects unknown redactPII enum values', function (): void {
    expect(fn () => RedactPIIOptions::with(mode: 'precise'))->toThrow(InvalidArgumentException::class);
    expect(fn () => RedactPIIOptions::with(replaceStyle: 'redact'))->toThrow(InvalidArgumentException::class);
    expect(fn () => RedactPIIOptions::with(entities: ['NAME']))->toThrow(InvalidArgumentException::class);
});

it('accepts every documented redactPII enum value', function (): void {
    $options = RedactPIIOptions::with(
        mode: RedactPIIOptions::MODE_ACCURATE,
        replaceStyle: RedactPIIOptions::REPLACE_STYLE_REMOVE,
        entities: [
            RedactPIIOptions::ENTITY_PERSON,
            RedactPIIOptions::ENTITY_EMAIL,
            RedactPIIOptions::ENTITY_PHONE,
            RedactPIIOptions::ENTITY_LOCATION,
            RedactPIIOptions::ENTITY_FINANCIAL,
            RedactPIIOptions::ENTITY_SECRET,
        ],
    );

    expect($options->toArray()['entities'])->toHaveCount(6);
});
