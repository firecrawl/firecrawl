<?php

namespace Firecrawl;

use Firecrawl\FirecrawlException;
use GuzzleHttp\Client;
use GuzzleHttp\Exception\RequestException;
use Psr\Log\LoggerInterface;

class FirecrawlApp {
    public const API_VERSION      = "v1";
    public const CRAWL_URL        = "/".self::API_VERSION."/crawl/";
    public const SCRAP_URL        = "/".self::API_VERSION."/scrape/";
    public const BATCH_SCRAPE_URL = "/".self::API_VERSION."/batch/scrape/";
    public const MAP_URL          = "/".self::API_VERSION."/map/";
    public const SEARCH_URL       = "/".self::API_VERSION."/search/";
    private $apiKey;
    private $apiUrl;
    public $client;
    private $logger;

    /**
     * FirecrawlApp constructor.
     *
     * @param string|null $apiKey Your Firecrawl API key.
     * @param string $apiUrl The base URL of the Firecrawl API.
     * @param LoggerInterface|null $logger PSR-4 compliant logger (optional).
     *
     * @throws FirecrawlException If no API key is provided.
     */
    public function __construct(
        string $apiKey = null,
        string $apiUrl = 'https://api.firecrawl.dev',
        LoggerInterface $logger = null
    ) {
        $this->apiKey = $apiKey ?: getenv('FIRECRAWL_API_KEY');
        $this->apiUrl = $apiUrl ?: getenv('FIRECRAWL_API_URL', 'https://api.firecrawl.dev');

        // If no logger is provided, use a default one (e.g., Monolog with StreamHandler)
        if (!$logger) {
            $logger = new \Monolog\Logger('firecrawl_default');
            $logger->pushHandler(new \Monolog\Handler\StreamHandler('php://stdout', \Monolog\Level::Debug));
        }

        $this->logger = $logger;

        if (!$this->apiKey) {
            $this->logger->error('No API key provided.');
            throw new FirecrawlException('No API key provided');
        }

        $this->client = new Client([
            'base_uri' => $this->apiUrl,
            'headers' => ['Authorization' => 'Bearer ' . $this->apiKey, 'Content-Type' => 'application/json']
        ]);
    }

    /**
     * Scrape a URL.
     *
     * @param string $url The URL to scrape.
     * @param array|null $params Additional parameters.
     * @return mixed Scraped data.
     *
     * @throws FirecrawlException If scraping fails.
     */
    public function scrapeUrl(string $url, ?array $params = []): mixed {
        $scrapeParams = array_merge(['url' => $url], $params);
        $this->logger->info("Starting scrape for URL: $url");

        try {
            $response = $this->client->post(self::SCRAP_URL, ['json' => $scrapeParams]);
            $data = json_decode($response->getBody(), true);

            if (!$data['success']) {
                $this->logger->error("Scrape failed for URL: $url with error: " . $data['error']);
                throw new FirecrawlException('Failed to scrape URL: ' . $data['error']);
            }

            $this->logger->info("Scrape successful for URL: $url");
            return $data['data'];
        } catch (RequestException $e) {
            $this->logger->error("HTTP error during scrape for URL: $url - " . $e->getMessage());
            throw new FirecrawlException('HTTP Error: ' . $e->getMessage());
        }
    }

    /**
     * Convenience wrapper for LLM extraction (formats=['json'] + jsonOptions)
     */
    public function extractUrl(string $url, array $jsonOptions, array $params = []): array
    {
        $params = array_merge($params, [
            'formats'    => ['json'],
            'jsonOptions' => $jsonOptions,
        ]);

        return $this->scrapeUrl($url, $params);
    }

    /**
     * Initiate a crawl for a URL.
     *
     * @param string $url The URL to crawl.
     * @param array|null $params Additional parameters.
     * @param int|null $pollInterval Time between status checks.
     * @return mixed Crawl results.
     *
     * @throws FirecrawlException If the crawl job initiation fails.
     */
    public function crawlUrl(
        string $url,
        ?array $params = [],
        ?int $pollInterval = 2
    ): mixed {
        $crawlParams = array_merge(['url' => $url], $params);
        $this->logger->info("Starting crawl for URL: $url");

        try {
            $response = $this->client->post(self::CRAWL_URL, ['json' => $crawlParams]);
            $data = json_decode($response->getBody(), true);

            if (!isset($data['id'])) {
                $this->logger->error("Failed to initiate crawl for URL: $url");
                throw new FirecrawlException('Crawl job initiation failed');
            }

            $this->logger->info("Crawl initiated successfully for URL: $url, Job ID: " . $data['id']);
            return $this->monitorJobStatus($data['id'], $pollInterval);
        } catch (RequestException $e) {
            $this->logger->error("HTTP error during crawl for URL: $url - " . $e->getMessage());
            throw new FirecrawlException('HTTP Error: ' . $e->getMessage());
        }
    }

    public function crawlUrlAsync(string $url, array $params = []): array
    {
        return $this->crawlUrl($url, $params, false);
    }

    public function checkCrawlStatus(string $jobId): array
    {
        return $this->get(self::CRAWL_URL . $jobId);
    }

    public function cancelCrawl(string $jobId): array
    {
        return $this->delete(self::CRAWL_URL . $jobId);
    }

    private function post(string $path, array $body): array
    {
        try {
            $res = $this->client->post($path, ['json' => $body]);
            return json_decode($res->getBody()->getContents(), true, 512, JSON_THROW_ON_ERROR);
        } catch (RequestException $e) {
            $this->logger->error($e->getMessage());
            throw new FirecrawlException($e->getMessage());
        }
    }

    private function get(string $path): array
    {
        try {
            $res = $this->client->get($path);
            return json_decode($res->getBody()->getContents(), true, 512, JSON_THROW_ON_ERROR);
        } catch (RequestException $e) {
            $this->logger->error($e->getMessage());
            throw new FirecrawlException($e->getMessage());
        }
    }

    private function delete(string $path): array
    {
        try {
            $res = $this->client->delete($path);
            return json_decode($res->getBody()->getContents(), true, 512, JSON_THROW_ON_ERROR);
        } catch (RequestException $e) {
            $this->logger->error($e->getMessage());
            throw new FirecrawlException($e->getMessage());
        }
    }

    public function batchScrape(
        array $urls,
        array $params        = [],
        bool  $waitUntilDone = true,
        int   $pollInterval  = 10
    ): array {
        $resp = $this->post(self::BATCH_SCRAPE_URL, array_merge(['urls' => $urls], $params));

        if (!$waitUntilDone) {
            return $resp;
        }

        if (!isset($resp['id'])) {
            throw new FirecrawlException('Batch scrape job initiation failed');
        }

        return $this->monitorJobStatus($resp['id'], $pollInterval, self::BATCH_SCRAPE_URL);
    }

    public function mapUrl(string $url, array $params = []): array
    {
        return $this->post(self::MAP_URL, array_merge(['url' => $url], $params));
    }

    public function search(string $query, array $params = []): array
    {
        return $this->post(self::SEARCH_URL, array_merge(['query' => $query], $params));
    }

    /**
     * Monitor the status of a crawl job until completion.
     *
     * @param int $jobId The job ID.
     * @param int $pollInterval Time between status checks.
     * @return mixed Crawl results.
     *
     * @throws FirecrawlException If the job fails.
     */
    public function monitorJobStatus(int $jobId, int $pollInterval): mixed {
        $this->logger->info("Monitoring crawl job: $jobId");

        while (true) {
            sleep($pollInterval);

            try {
                $response = $this->client->get(self::CRAWL_URL . $jobId);
                $data = json_decode($response->getBody(), true);

                if ($data['status'] === 'completed') {
                    $this->logger->info("Crawl job completed successfully: $jobId");
                    return $data['data'];
                } elseif (in_array($data['status'], ['failed', 'stopped'])) {
                    $this->logger->error("Crawl job $jobId failed with status: " . $data['status']);
                    throw new FirecrawlException('Crawl job failed with status: ' . $data['status']);
                }
            } catch (RequestException $e) {
                $this->logger->error("HTTP error while monitoring job: $jobId - " . $e->getMessage());
                throw new FirecrawlException('HTTP Error: ' . $e->getMessage());
            }
        }
    }

    /**
     * Check the status of a crawl job.
     *
     * @param int $jobId The job ID.
     * @return mixed Crawl job status.
     */
    public function checkCrawlStatus(int $jobId): mixed {
        $this->logger->info("Checking status for crawl job: $jobId");

        $response = $this->client->get(self::CRAWL_URL . $jobId);
        $responseBody = json_decode($response->getBody(), true);

        return $responseBody;
    }

    /**
     * Cancel a crawl job.
     *
     * @param int $jobId The job ID to cancel.
     * @return mixed API response.
     */
    public function cancelCrawl(int $jobId): mixed {
        $this->logger->info("Canceling crawl job: $jobId");

        $response = $this->client->delete(self::CRAWL_URL . $jobId);
        $responseBody = json_decode($response->getBody(), true);

        return $responseBody;
    }
}
