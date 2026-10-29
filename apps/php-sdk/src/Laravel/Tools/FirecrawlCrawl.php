<?php

declare(strict_types=1);

namespace Firecrawl\Laravel\Tools;

use Firecrawl\Exceptions\FirecrawlException;
use Firecrawl\Models\CrawlJob;
use Firecrawl\Models\CrawlOptions;
use Firecrawl\Models\ScrapeOptions;
use Illuminate\Contracts\JsonSchema\JsonSchema;
use Laravel\Ai\Tools\Request;

class FirecrawlCrawl extends FirecrawlTool
{
    /**
     * Wall-clock limit for the start request and polling, kept below typical
     * queue worker timeouts (Laravel defaults to 60 seconds).
     */
    protected int $timeoutSeconds = 55;

    protected int $pollIntervalSeconds = 2;

    /** Per-page output ceiling; override to change. */
    protected int $pageCharacterLimit = 15000;

    public function name(): string
    {
        return 'firecrawl_crawl';
    }

    public function description(): string
    {
        return 'Crawl a website with Firecrawl starting from a URL, following its links. Returns a '
            . 'JSON object with the crawl status and a pages array of {url, markdown} objects. This '
            . 'is a slower, multi-page operation. Prefer firecrawl_scrape when you only need one '
            . 'known page, and keep the page limit small. Waits up to about a minute.';
    }

    public function handle(Request $request): string
    {
        return $this->guard(function () use ($request): string {
            $limit = min(max($request->integer('limit') ?: 5, 1), 25);
            $deadline = time() + $this->timeoutSeconds;

            $start = $this->client()->startCrawl(
                (string) $request->string('url'),
                CrawlOptions::with(
                    limit: $limit,
                    scrapeOptions: ScrapeOptions::with(formats: ['markdown']),
                    integration: self::INTEGRATION,
                    idempotencyKey: $this->newIdempotencyKey(),
                ),
                requestTimeoutSeconds: $this->remainingSeconds($deadline),
            );

            $jobId = $start->getId();
            if ($jobId === null || $jobId === '') {
                throw new FirecrawlException('Crawl start did not return a job ID.');
            }

            $job = $this->client()->getCrawlStatus($jobId, $this->remainingSeconds($deadline));

            while (!$job->isDone()) {
                if (time() >= $deadline) {
                    return "The crawl did not finish within {$this->timeoutSeconds} seconds. It may still "
                        . 'complete on the server. Use a smaller limit, or scrape key pages individually '
                        . 'with firecrawl_scrape.';
                }

                sleep($this->pollIntervalSeconds);
                $job = $this->client()->getCrawlStatus($jobId, $this->remainingSeconds($deadline));
            }

            return $this->toJson($this->formatJob($job));
        });
    }

    private function remainingSeconds(int $deadline): float
    {
        return (float) max($deadline - time(), 1);
    }

    /**
     * The API only accepts UUID-formatted idempotency keys.
     */
    private function newIdempotencyKey(): string
    {
        $bytes = random_bytes(16);
        $bytes[6] = chr((ord($bytes[6]) & 0x0f) | 0x40);
        $bytes[8] = chr((ord($bytes[8]) & 0x3f) | 0x80);

        return vsprintf('%s%s-%s-%s-%s-%s%s%s', str_split(bin2hex($bytes), 4));
    }

    /**
     * Failed or cancelled crawls stay visible through the status field.
     * Pagination cursors are reported, not followed.
     *
     * @return array<string, mixed>
     */
    private function formatJob(CrawlJob $job): array
    {
        $pages = [];
        $used = 0;
        $omitted = 0;

        foreach ($job->getData() as $document) {
            $page = [
                'url' => $document->getMetadata()['sourceURL']
                    ?? $document->getMetadata()['url']
                    ?? null,
                'markdown' => $this->truncate($this->documentContent($document), $this->pageCharacterLimit),
            ];
            $length = mb_strlen($this->toJson($page));

            if ($pages !== [] && $used + $length > $this->outputCharacterBudget) {
                $omitted++;
                continue;
            }

            $used += $length;
            $pages[] = $page;
        }

        $result = [
            'status' => $job->getStatus(),
            'completed' => $job->getCompleted(),
            'total' => $job->getTotal(),
            'pages' => $pages,
        ];

        if ($omitted > 0) {
            $result['omittedPages'] = $omitted;
        }

        if ($job->getNext() !== null && $job->getNext() !== '') {
            $result['note'] = 'More pages exist on the server than fit in this response. '
                . 'Use a smaller limit or scrape specific pages with firecrawl_scrape.';
        }

        return $result;
    }

    /** @return array<string, \Illuminate\JsonSchema\Types\Type> */
    public function schema(JsonSchema $schema): array
    {
        return [
            'url' => $schema->string()
                ->description('The URL to start crawling from (e.g. https://example.com/docs).')
                ->required(),
            'limit' => $schema->integer()->min(1)->max(25)
                ->description('Maximum number of pages to crawl. Defaults to 5, capped at 25 to keep responses manageable.'),
        ];
    }
}
