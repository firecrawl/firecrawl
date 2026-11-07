<?php

declare(strict_types=1);

namespace Firecrawl\Laravel\Tools;

use Firecrawl\Models\ScrapeOptions;
use Illuminate\Contracts\JsonSchema\JsonSchema;
use Laravel\Ai\Tools\Request;

class FirecrawlScrape extends FirecrawlTool
{
    public function name(): string
    {
        return 'firecrawl_scrape';
    }

    public function description(): string
    {
        return 'Scrape a single web page with Firecrawl and return its content as clean markdown. '
            . 'Use this when you already know the URL of the page you need to read. '
            . 'Handles JavaScript-rendered pages, PDFs, and pages behind anti-bot protection.';
    }

    public function handle(Request $request): string
    {
        return $this->guard(function () use ($request): string {
            $document = $this->client()->scrape(
                (string) $request->string('url'),
                ScrapeOptions::with(
                    formats: ['markdown'],
                    integration: self::INTEGRATION,
                ),
            );

            return $this->truncate($this->documentContent($document), 80000);
        });
    }

    /** @return array<string, \Illuminate\JsonSchema\Types\Type> */
    public function schema(JsonSchema $schema): array
    {
        return [
            'url' => $schema->string()
                ->description('The absolute URL of the page to scrape, including the scheme (e.g. https://example.com/pricing).')
                ->required(),
        ];
    }
}
