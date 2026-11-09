<?php

declare(strict_types=1);

namespace Firecrawl\Laravel\Tools;

use Firecrawl\Client\FirecrawlClient;

final class FirecrawlTools
{
    private function __construct() {}

    /**
     * All core Firecrawl tools, ready to spread into an agent's tools() array.
     *
     * @return list<FirecrawlTool>
     */
    public static function all(?FirecrawlClient $client = null): array
    {
        return [
            new FirecrawlScrape($client),
            new FirecrawlSearch($client),
            new FirecrawlMap($client),
            new FirecrawlCrawl($client),
        ];
    }
}
