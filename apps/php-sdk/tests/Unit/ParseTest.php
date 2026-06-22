<?php

declare(strict_types=1);

use Firecrawl\Exceptions\FirecrawlException;
use Firecrawl\Models\JsonFormat;
use Firecrawl\Models\ParseFile;
use Firecrawl\Models\ParseOptions;

it('builds a ParseFile from bytes', function (): void {
    $file = ParseFile::fromBytes('doc.pdf', 'hello');

    expect($file->getFilename())->toBe('doc.pdf');
    expect($file->getContent())->toBe('hello');
});

it('rejects empty filename', function (): void {
    ParseFile::fromBytes('  ', 'hello');
})->throws(FirecrawlException::class);

it('rejects empty content', function (): void {
    ParseFile::fromBytes('doc.pdf', '');
})->throws(FirecrawlException::class);

it('serializes ParseOptions with JSON format', function (): void {
    $options = ParseOptions::with(
        formats: ['markdown', JsonFormat::with(prompt: 'Extract')],
        onlyMainContent: true,
        redactPII: true,
    );

    $array = $options->toArray();

    expect($array['formats'][0])->toBe('markdown');
    expect($array['formats'][1])->toMatchArray(['type' => 'json', 'prompt' => 'Extract']);
    expect($array['onlyMainContent'])->toBeTrue();
    expect($array['redactPII'])->toBeTrue();
});

it('rejects unsupported parse formats', function (): void {
    ParseOptions::with(formats: ['screenshot']);
})->throws(FirecrawlException::class);

it('rejects video parse format', function (): void {
    ParseOptions::with(formats: ['video']);
})->throws(FirecrawlException::class);

it('rejects product parse format', function (): void {
    ParseOptions::with(formats: ['product']);
})->throws(FirecrawlException::class);

it('rejects menu parse format', function (): void {
    ParseOptions::with(formats: ['menu']);
})->throws(FirecrawlException::class);

it('rejects invalid proxy values', function (): void {
    ParseOptions::with(proxy: 'stealth');
})->throws(FirecrawlException::class);

it('rejects non-positive timeout', function (): void {
    ParseOptions::with(timeout: 0);
})->throws(FirecrawlException::class);
