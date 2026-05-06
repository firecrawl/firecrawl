<?php

declare(strict_types=1);

namespace Firecrawl\Client;

use Firecrawl\Exceptions\FirecrawlException;
use Firecrawl\Exceptions\JobTimeoutException;
use Firecrawl\Models\AgentOptions;
use Firecrawl\Models\AgentResponse;
use Firecrawl\Models\AgentStatusResponse;
use Firecrawl\Models\BatchScrapeJob;
use Firecrawl\Models\BatchScrapeOptions;
use Firecrawl\Models\BatchScrapeResponse;
use Firecrawl\Models\BrowserCreateResponse;
use Firecrawl\Models\BrowserDeleteResponse;
use Firecrawl\Models\BrowserExecuteResponse;
use Firecrawl\Models\BrowserListResponse;
use Firecrawl\Models\ConcurrencyCheck;
use Firecrawl\Models\CrawlJob;
use Firecrawl\Models\CrawlOptions;
use Firecrawl\Models\CrawlResponse;
use Firecrawl\Models\CreditUsage;
use Firecrawl\Models\Document;
use Firecrawl\Models\MapData;
use Firecrawl\Models\MapOptions;
use Firecrawl\Models\Monitor;
use Firecrawl\Models\MonitorCheck;
use Firecrawl\Models\MonitorCheckDetail;
use Firecrawl\Models\ParseFile;
use Firecrawl\Models\ParseOptions;
use Firecrawl\Models\ScrapeOptions;
use Firecrawl\Models\SearchData;
use Firecrawl\Models\SearchOptions;
use GuzzleHttp\ClientInterface;

final class FirecrawlClient
{
    private const DEFAULT_API_URL = 'https://api.firecrawl.dev';
    private const DEFAULT_TIMEOUT_SECONDS = 300;
    private const DEFAULT_MAX_RETRIES = 3;
    private const DEFAULT_BACKOFF_FACTOR = 0.5;
    private const DEFAULT_POLL_INTERVAL = 2;
    private const DEFAULT_JOB_TIMEOUT = 300;

    private readonly FirecrawlHttpClient $http;

    private function __construct(FirecrawlHttpClient $http)
    {
        $this->http = $http;
    }

    /**
     * Create a client with named parameters.
     *
     * Uses FIRECRAWL_API_KEY and FIRECRAWL_API_URL environment variables as fallbacks.
     */
    public static function create(
        ?string $apiKey = null,
        ?string $apiUrl = null,
        float $timeoutSeconds = self::DEFAULT_TIMEOUT_SECONDS,
        int $maxRetries = self::DEFAULT_MAX_RETRIES,
        float $backoffFactor = self::DEFAULT_BACKOFF_FACTOR,
        ?ClientInterface $httpClient = null,
    ): self {
        $resolvedKey = trim($apiKey ?: (getenv('FIRECRAWL_API_KEY') ?: ''));
        if ($resolvedKey === '') {
            throw new FirecrawlException(
                'API key is required. Pass it directly or set the FIRECRAWL_API_KEY environment variable.',
            );
        }

        $resolvedUrl = $apiUrl ?: (getenv('FIRECRAWL_API_URL') ?: self::DEFAULT_API_URL);

        if (!preg_match('#^https?://#i', $resolvedUrl)) {
            throw new FirecrawlException(
                'API URL must be a fully qualified URL including scheme (e.g. https://api.firecrawl.dev).',
            );
        }

        $http = new FirecrawlHttpClient(
            $resolvedKey,
            $resolvedUrl,
            $timeoutSeconds,
            $maxRetries,
            $backoffFactor,
            $httpClient,
        );

        return new self($http);
    }

    /**
     * Create a client from the FIRECRAWL_API_KEY environment variable.
     */
    public static function fromEnv(): self
    {
        return self::create();
    }

    // ================================================================
    // SCRAPE
    // ================================================================

    /**
     * Scrape a single URL and return the document.
     */
    public function scrape(string $url, ?ScrapeOptions $options = null): Document
    {
        $body = ['url' => $url];
        if ($options !== null) {
            $body = array_merge($body, $options->toArray());
        }

        $response = $this->http->post('/v2/scrape', $body);

        return Document::fromArray($response['data'] ?? $response);
    }

    /**
     * Interact with the scrape-bound browser session for a scrape job.
     */
    public function interact(
        string $jobId,
        string $code,
        string $language = 'node',
        ?int $timeout = null,
        ?string $origin = null,
        ?string $prompt = null,
    ): BrowserExecuteResponse {
        $body = [
            'code' => $code,
            'language' => $language,
        ];
        if ($timeout !== null) {
            $body['timeout'] = $timeout;
        }
        if ($origin !== null) {
            $body['origin'] = $origin;
        }
        if ($prompt !== null) {
            $body['prompt'] = $prompt;
        }

        return BrowserExecuteResponse::fromArray(
            $this->http->post("/v2/scrape/{$jobId}/interact", $body),
        );
    }

    /**
     * Stop the interactive browser session for a scrape job.
     */
    public function stopInteractiveBrowser(string $jobId): BrowserDeleteResponse
    {
        return BrowserDeleteResponse::fromArray(
            $this->http->delete("/v2/scrape/{$jobId}/interact"),
        );
    }

    // ================================================================
    // PARSE
    // ================================================================

    /**
     * Parse an uploaded file and return the extracted document.
     */
    public function parse(ParseFile $file, ?ParseOptions $options = null): Document
    {
        $optionsArray = $options?->toArray() ?? [];
        $response = $this->http->postMultipart(
            '/v2/parse',
            ['options' => json_encode($optionsArray, JSON_THROW_ON_ERROR)],
            'file',
            $file->getFilename(),
            $file->getContent(),
            $file->getContentType(),
        );

        return Document::fromArray($response['data'] ?? $response);
    }

    // ================================================================
    // CRAWL
    // ================================================================

    /**
     * Start an async crawl job and return immediately.
     */
    public function startCrawl(string $url, ?CrawlOptions $options = null): CrawlResponse
    {
        $body = ['url' => $url];
        if ($options !== null) {
            $body = array_merge($body, $options->toArray());
        }

        return CrawlResponse::fromArray($this->http->post('/v2/crawl', $body));
    }

    /**
     * Get the status and results of a crawl job.
     */
    public function getCrawlStatus(string $jobId): CrawlJob
    {
        return CrawlJob::fromArray($this->http->get("/v2/crawl/{$jobId}"));
    }

    /**
     * Crawl a website and wait for completion (auto-polling).
     */
    public function crawl(
        string $url,
        ?CrawlOptions $options = null,
        int $pollIntervalSec = self::DEFAULT_POLL_INTERVAL,
        int $timeoutSec = self::DEFAULT_JOB_TIMEOUT,
    ): CrawlJob {
        $start = $this->startCrawl($url, $options);

        return $this->pollCrawl($start->getId(), $pollIntervalSec, $timeoutSec);
    }

    /**
     * Cancel a running crawl job.
     *
     * @return array<string, mixed>
     */
    public function cancelCrawl(string $jobId): array
    {
        return $this->http->delete("/v2/crawl/{$jobId}");
    }

    /**
     * Get errors from a crawl job.
     *
     * @return array<string, mixed>
     */
    public function getCrawlErrors(string $jobId): array
    {
        return $this->http->get("/v2/crawl/{$jobId}/errors");
    }

    // ================================================================
    // BATCH SCRAPE
    // ================================================================

    /**
     * Start an async batch scrape job.
     *
     * @param list<string> $urls
     */
    public function startBatchScrape(array $urls, ?BatchScrapeOptions $options = null): BatchScrapeResponse
    {
        $body = ['urls' => $urls];
        $extraHeaders = [];

        if ($options !== null) {
            $idempotencyKey = $options->getIdempotencyKey();
            if ($idempotencyKey !== null && $idempotencyKey !== '') {
                $extraHeaders['x-idempotency-key'] = $idempotencyKey;
            }

            $body = array_merge($body, $options->toArray());
        }

        return BatchScrapeResponse::fromArray(
            $this->http->post('/v2/batch/scrape', $body, $extraHeaders),
        );
    }

    /**
     * Get the status and results of a batch scrape job.
     */
    public function getBatchScrapeStatus(string $jobId): BatchScrapeJob
    {
        return BatchScrapeJob::fromArray($this->http->get("/v2/batch/scrape/{$jobId}"));
    }

    /**
     * Batch-scrape URLs and wait for completion (auto-polling).
     *
     * @param list<string> $urls
     */
    public function batchScrape(
        array $urls,
        ?BatchScrapeOptions $options = null,
        int $pollIntervalSec = self::DEFAULT_POLL_INTERVAL,
        int $timeoutSec = self::DEFAULT_JOB_TIMEOUT,
    ): BatchScrapeJob {
        $start = $this->startBatchScrape($urls, $options);

        return $this->pollBatchScrape($start->getId(), $pollIntervalSec, $timeoutSec);
    }

    /**
     * Cancel a running batch scrape job.
     *
     * @return array<string, mixed>
     */
    public function cancelBatchScrape(string $jobId): array
    {
        return $this->http->delete("/v2/batch/scrape/{$jobId}");
    }

    // ================================================================
    // MAP
    // ================================================================

    /**
     * Discover URLs on a website.
     */
    public function map(string $url, ?MapOptions $options = null): MapData
    {
        $body = ['url' => $url];
        if ($options !== null) {
            $body = array_merge($body, $options->toArray());
        }

        $response = $this->http->post('/v2/map', $body);

        return MapData::fromArray($response['data'] ?? $response);
    }

    // ================================================================
    // MONITOR
    // ================================================================

    /**
     * Create a scheduled monitor.
     *
     * @param array<string, mixed>       $schedule
     * @param list<array<string, mixed>> $targets
     * @param array<string, mixed>|null  $webhook
     * @param array<string, mixed>|null  $notification
     */
    public function createMonitor(
        string $name,
        array $schedule,
        array $targets,
        ?array $webhook = null,
        ?array $notification = null,
        ?int $retentionDays = null,
    ): Monitor {
        $body = array_filter([
            'name' => $name,
            'schedule' => $schedule,
            'targets' => $targets,
            'webhook' => $webhook,
            'notification' => $notification,
            'retentionDays' => $retentionDays,
        ], static fn ($value) => $value !== null);

        $response = $this->http->post('/v2/monitor', $body);

        return Monitor::fromArray($response['data'] ?? $response);
    }

    /**
     * @return list<Monitor>
     */
    public function listMonitors(?int $limit = null, ?int $offset = null): array
    {
        $response = $this->http->get('/v2/monitor' . $this->query([
            'limit' => $limit,
            'offset' => $offset,
        ]));

        return array_map(
            static fn (array $item): Monitor => Monitor::fromArray($item),
            $response['data'] ?? [],
        );
    }

    public function getMonitor(string $monitorId): Monitor
    {
        $response = $this->http->get("/v2/monitor/{$monitorId}");

        return Monitor::fromArray($response['data'] ?? $response);
    }

    /**
     * @param array<string, mixed> $attributes
     */
    public function updateMonitor(string $monitorId, array $attributes): Monitor
    {
        $response = $this->http->patch("/v2/monitor/{$monitorId}", $attributes);

        return Monitor::fromArray($response['data'] ?? $response);
    }

    public function deleteMonitor(string $monitorId): bool
    {
        $response = $this->http->delete("/v2/monitor/{$monitorId}");

        return ($response['success'] ?? false) === true;
    }

    public function runMonitor(string $monitorId): MonitorCheck
    {
        $response = $this->http->post("/v2/monitor/{$monitorId}/run", []);

        return MonitorCheck::fromArray($response['data'] ?? $response);
    }

    /**
     * @return list<MonitorCheck>
     */
    public function listMonitorChecks(string $monitorId, ?int $limit = null, ?int $offset = null): array
    {
        $response = $this->http->get("/v2/monitor/{$monitorId}/checks" . $this->query([
            'limit' => $limit,
            'offset' => $offset,
        ]));

        return array_map(
            static fn (array $item): MonitorCheck => MonitorCheck::fromArray($item),
            $response['data'] ?? [],
        );
    }

    public function getMonitorCheck(
        string $monitorId,
        string $checkId,
        ?int $limit = null,
        ?int $skip = null,
        ?string $status = null,
        bool $autoPaginate = true,
    ): MonitorCheckDetail {
        $response = $this->http->get("/v2/monitor/{$monitorId}/checks/{$checkId}" . $this->query([
            'limit' => $limit,
            'skip' => $skip,
            'status' => $status,
        ]));

        $data = $response['data'] ?? $response;
        if (isset($response['next'])) {
            $data['next'] = $response['next'];
        }

        if (!$autoPaginate) {
            return MonitorCheckDetail::fromArray($data);
        }

        while (isset($data['next']) && is_string($data['next']) && $data['next'] !== '') {
            $this->assertSameOrigin($data['next']);
            $nextResponse = $this->http->getAbsolute($data['next']);
            $nextData = $nextResponse['data'] ?? $nextResponse;
            if (isset($nextResponse['next'])) {
                $nextData['next'] = $nextResponse['next'];
            }

            $data['pages'] = array_merge($data['pages'] ?? [], $nextData['pages'] ?? []);
            $data['next'] = $nextData['next'] ?? null;
        }

        $data['next'] = null;
        return MonitorCheckDetail::fromArray($data);
    }

    // ================================================================
    // SEARCH
    // ================================================================

    /**
     * Perform a web search.
     */
    public function search(string $query, ?SearchOptions $options = null): SearchData
    {
        $body = ['query' => $query];
        if ($options !== null) {
            $body = array_merge($body, $options->toArray());
        }

        $response = $this->http->post('/v2/search', $body);

        return SearchData::fromArray($response['data'] ?? $response);
    }

    // ================================================================
    // AGENT
    // ================================================================

    /**
     * Start an async agent task.
     */
    public function startAgent(AgentOptions $options): AgentResponse
    {
        return AgentResponse::fromArray(
            $this->http->post('/v2/agent', $options->toArray()),
        );
    }

    /**
     * Get the status of an agent task.
     */
    public function getAgentStatus(string $jobId): AgentStatusResponse
    {
        return AgentStatusResponse::fromArray(
            $this->http->get("/v2/agent/{$jobId}"),
        );
    }

    /**
     * Run an agent task and wait for completion (auto-polling).
     */
    public function agent(
        AgentOptions $options,
        int $pollIntervalSec = self::DEFAULT_POLL_INTERVAL,
        int $timeoutSec = self::DEFAULT_JOB_TIMEOUT,
    ): AgentStatusResponse {
        $start = $this->startAgent($options);

        if ($start->getId() === null) {
            throw new FirecrawlException('Agent start did not return a job ID');
        }

        $this->ensureValidPollInterval($pollIntervalSec);

        $deadline = time() + $timeoutSec;
        while (time() < $deadline) {
            $status = $this->getAgentStatus($start->getId());
            if ($status->isDone()) {
                return $status;
            }
            sleep($pollIntervalSec);
        }

        throw new JobTimeoutException($start->getId(), $timeoutSec, 'Agent');
    }

    /**
     * Cancel a running agent task.
     *
     * @return array<string, mixed>
     */
    public function cancelAgent(string $jobId): array
    {
        return $this->http->delete("/v2/agent/{$jobId}");
    }

    // ================================================================
    // BROWSER
    // ================================================================

    /**
     * Create a new browser session.
     *
     * @param array<string, string>|null $profile
     */
    public function browser(
        ?int $ttl = null,
        ?int $activityTtl = null,
        ?bool $streamWebView = null,
        ?array $profile = null,
    ): BrowserCreateResponse {
        $body = [];
        if ($ttl !== null) {
            $body['ttl'] = $ttl;
        }
        if ($activityTtl !== null) {
            $body['activityTtl'] = $activityTtl;
        }
        if ($streamWebView !== null) {
            $body['streamWebView'] = $streamWebView;
        }
        if ($profile !== null) {
            $body['profile'] = $profile;
        }

        return BrowserCreateResponse::fromArray($this->http->post('/v2/browser', $body));
    }

    /**
     * Execute code in a browser session.
     */
    public function browserExecute(
        string $sessionId,
        string $code,
        string $language = 'bash',
        ?int $timeout = null,
    ): BrowserExecuteResponse {
        $body = [
            'code' => $code,
            'language' => $language,
        ];
        if ($timeout !== null) {
            $body['timeout'] = $timeout;
        }

        return BrowserExecuteResponse::fromArray(
            $this->http->post("/v2/browser/{$sessionId}/execute", $body),
        );
    }

    /**
     * Delete a browser session.
     */
    public function deleteBrowser(string $sessionId): BrowserDeleteResponse
    {
        return BrowserDeleteResponse::fromArray(
            $this->http->delete("/v2/browser/{$sessionId}"),
        );
    }

    /**
     * List browser sessions.
     */
    public function listBrowsers(?string $status = null): BrowserListResponse
    {
        $endpoint = '/v2/browser';
        if ($status !== null && $status !== '') {
            $endpoint .= '?status=' . urlencode($status);
        }

        return BrowserListResponse::fromArray($this->http->get($endpoint));
    }

    // ================================================================
    // USAGE & METRICS
    // ================================================================

    /**
     * Get current concurrency usage.
     */
    public function getConcurrency(): ConcurrencyCheck
    {
        return ConcurrencyCheck::fromArray($this->http->get('/v2/concurrency-check'));
    }

    /**
     * Get current credit usage.
     */
    public function getCreditUsage(): CreditUsage
    {
        return CreditUsage::fromArray($this->http->get('/v2/team/credit-usage'));
    }

    // ================================================================
    // INTERNAL POLLING HELPERS
    // ================================================================

    private function ensureValidPollInterval(int $pollIntervalSec): void
    {
        if ($pollIntervalSec < 1) {
            throw new FirecrawlException('Poll interval must be at least 1 second, got ' . $pollIntervalSec);
        }
    }

    /**
     * @param array<string, scalar|null> $params
     */
    private function query(array $params): string
    {
        $params = array_filter($params, static fn ($value) => $value !== null && $value !== '');

        return $params === [] ? '' : '?' . http_build_query($params);
    }

    private function pollCrawl(
        ?string $jobId,
        int $pollIntervalSec,
        int $timeoutSec,
    ): CrawlJob {
        if ($jobId === null) {
            throw new FirecrawlException('Crawl start did not return a job ID');
        }

        $this->ensureValidPollInterval($pollIntervalSec);

        $deadline = time() + $timeoutSec;
        while (time() < $deadline) {
            $job = $this->getCrawlStatus($jobId);
            if ($job->isDone()) {
                return $this->paginateCrawl($job);
            }
            sleep($pollIntervalSec);
        }

        throw new JobTimeoutException($jobId, $timeoutSec, 'Crawl');
    }

    private function pollBatchScrape(
        ?string $jobId,
        int $pollIntervalSec,
        int $timeoutSec,
    ): BatchScrapeJob {
        if ($jobId === null) {
            throw new FirecrawlException('Batch scrape start did not return a job ID');
        }

        $this->ensureValidPollInterval($pollIntervalSec);

        $deadline = time() + $timeoutSec;
        while (time() < $deadline) {
            $job = $this->getBatchScrapeStatus($jobId);
            if ($job->isDone()) {
                return $this->paginateBatchScrape($job);
            }
            sleep($pollIntervalSec);
        }

        throw new JobTimeoutException($jobId, $timeoutSec, 'Batch scrape');
    }

    private function assertSameOrigin(string $url): void
    {
        $baseScheme = parse_url($this->http->getBaseUrl(), PHP_URL_SCHEME);
        $baseHost = parse_url($this->http->getBaseUrl(), PHP_URL_HOST);
        $basePort = parse_url($this->http->getBaseUrl(), PHP_URL_PORT);
        $nextScheme = parse_url($url, PHP_URL_SCHEME);
        $nextHost = parse_url($url, PHP_URL_HOST);
        $nextPort = parse_url($url, PHP_URL_PORT);

        $basePort ??= is_string($baseScheme) && strcasecmp($baseScheme, 'https') === 0
            ? 443
            : 80;
        $nextPort ??= is_string($nextScheme) && strcasecmp($nextScheme, 'https') === 0
            ? 443
            : 80;

        if (
            $baseScheme === null ||
            $nextScheme === null ||
            $baseHost === null ||
            $nextHost === null ||
            strcasecmp($baseScheme, $nextScheme) !== 0 ||
            strcasecmp($baseHost, $nextHost) !== 0 ||
            $basePort !== $nextPort
        ) {
            throw new FirecrawlException(
                'Pagination URL origin does not match the API base URL. Refusing to follow: ' . $url,
            );
        }
    }

    private function paginateCrawl(CrawlJob $job): CrawlJob
    {
        $current = $job;
        while ($current->getNext() !== null && $current->getNext() !== '') {
            $this->assertSameOrigin($current->getNext());
            $nextRaw = $this->http->getAbsolute($current->getNext());
            $nextPage = CrawlJob::fromArray($nextRaw);

            foreach ($nextPage->getData() as $doc) {
                $job->appendData($doc);
            }

            $current = $nextPage;
        }

        return $job;
    }

    private function paginateBatchScrape(BatchScrapeJob $job): BatchScrapeJob
    {
        $current = $job;
        while ($current->getNext() !== null && $current->getNext() !== '') {
            $this->assertSameOrigin($current->getNext());
            $nextRaw = $this->http->getAbsolute($current->getNext());
            $nextPage = BatchScrapeJob::fromArray($nextRaw);

            foreach ($nextPage->getData() as $doc) {
                $job->appendData($doc);
            }

            $current = $nextPage;
        }

        return $job;
    }
}
