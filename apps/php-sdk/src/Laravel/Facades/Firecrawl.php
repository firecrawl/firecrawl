<?php

declare(strict_types=1);

namespace Firecrawl\Laravel\Facades;

use Firecrawl\Client\FirecrawlClient;
use Firecrawl\Models\AgentListResponse;
use Firecrawl\Models\AgentOptions;
use Firecrawl\Models\AgentStatusResponse;
use Firecrawl\Models\BatchScrapeJob;
use Firecrawl\Models\BatchScrapeOptions;
use Firecrawl\Models\BrowserCreateResponse;
use Firecrawl\Models\BrowserDeleteResponse;
use Firecrawl\Models\BrowserExecuteResponse;
use Firecrawl\Models\BrowserListResponse;
use Firecrawl\Models\ConcurrencyCheck;
use Firecrawl\Models\CrawlJob;
use Firecrawl\Models\CrawlOptions;
use Firecrawl\Models\CreditUsage;
use Firecrawl\Models\Document;
use Firecrawl\Models\MapData;
use Firecrawl\Models\MapOptions;
use Firecrawl\Models\ScrapeOptions;
use Firecrawl\Models\SearchData;
use Firecrawl\Models\SearchOptions;
use Illuminate\Support\Facades\Facade;

/**
 * @method static Document scrape(string $url, ?ScrapeOptions $options = null)
 * @method static BrowserExecuteResponse interact(string $jobId, string $code, string $language = 'node', ?int $timeout = null, ?string $origin = null)
 * @method static BrowserDeleteResponse stopInteractiveBrowser(string $jobId)
 * @method static CrawlJob crawl(string $url, ?CrawlOptions $options = null, int $pollIntervalSec = 2, int $timeoutSec = 300)
 * @method static CrawlJob getCrawlStatus(string $jobId)
 * @method static array<string, mixed> cancelCrawl(string $jobId)
 * @method static BatchScrapeJob batchScrape(list<string> $urls, ?BatchScrapeOptions $options = null, int $pollIntervalSec = 2, int $timeoutSec = 300)
 * @method static array<string, mixed> cancelBatchScrape(string $jobId)
 * @method static MapData map(string $url, ?MapOptions $options = null)
 * @method static SearchData search(string $query, ?SearchOptions $options = null)
 * @method static AgentStatusResponse agent(AgentOptions $options, int $pollIntervalSec = 2, int $timeoutSec = 300)
 * @method static array<string, mixed> cancelAgent(string $jobId)
 * @method static AgentListResponse listAgents(?int $before = null)
 * @method static BrowserCreateResponse browser(?int $ttl = null, ?int $activityTtl = null, ?bool $streamWebView = null)
 * @method static BrowserExecuteResponse browserExecute(string $sessionId, string $code, string $language = 'bash', ?int $timeout = null)
 * @method static BrowserDeleteResponse deleteBrowser(string $sessionId)
 * @method static BrowserListResponse listBrowsers(?string $status = null)
 * @method static ConcurrencyCheck getConcurrency()
 * @method static CreditUsage getCreditUsage()
 *
 * @see FirecrawlClient
 */
class Firecrawl extends Facade
{
    protected static function getFacadeAccessor(): string
    {
        return FirecrawlClient::class;
    }
}
