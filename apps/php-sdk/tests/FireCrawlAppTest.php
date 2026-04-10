<?php

use Firecrawl\FirecrawlApp;
use Firecrawl\FirecrawlException;
use GuzzleHttp\Client;
use GuzzleHttp\Psr7\Response;
use GuzzleHttp\Exception\RequestException;
use PHPUnit\Framework\TestCase;
use Psr\Log\LoggerInterface;

class FirecrawlAppTest extends TestCase
{
    private $clientMock;
    private $loggerMock;
    private $firecrawl;

    protected function setUp(): void
    {
        // Mocking the Guzzle Client
        $this->clientMock = $this->createMock(Client::class);

        // Mocking the Logger
        $this->loggerMock = $this->createMock(LoggerInterface::class);

        // Instantiating FirecrawlApp with mocks
        $this->firecrawl = new FirecrawlApp('fake-api-key', 'https://api.firecrawl.dev', $this->loggerMock);
        $this->firecrawl->client = $this->clientMock;  // Inject the mock Guzzle client
    }

    public function testConstructorWithNoApiKeyThrowsException(): void
    {
        $this->expectException(FirecrawlException::class);
        $this->expectExceptionMessage('No API key provided');

        // Create an instance without an API key, should throw exception
        new FirecrawlApp(null, 'https://api.firecrawl.dev', $this->loggerMock);
    }

    public function testScrapeUrlSuccess(): void
    {
        $url = 'https://example.com';
        $responseData = ['success' => true, 'data' => ['scrapedContent' => 'content']];
        $response = new Response(200, [], json_encode($responseData));

        // Mock Guzzle's post method
        $this->clientMock->method('post')
            ->with('/v1/scrape/', ['json' => ['url' => $url]])
            ->willReturn($response);

        $this->loggerMock->expects($this->once())
            ->method('info')
            ->with("Starting scrape for URL: $url");

        $result = $this->firecrawl->scrapeUrl($url);
        $this->assertEquals($responseData['data'], $result);
    }

    public function testScrapeUrlFailsWithError(): void
    {
        $url = 'https://example.com';
        $responseData = ['success' => false, 'error' => 'Invalid URL'];
        $response = new Response(200, [], json_encode($responseData));

        // Mock Guzzle's post method
        $this->clientMock->method('post')
            ->with('/v1/scrape/', ['json' => ['url' => $url]])
            ->willReturn($response);

        $this->loggerMock->expects($this->once())
            ->method('error')
            ->with("Scrape failed for URL: $url with error: Invalid URL");

        $this->expectException(FirecrawlException::class);
        $this->expectExceptionMessage('Failed to scrape URL: Invalid URL');

        $this->firecrawl->scrapeUrl($url);
    }

    public function testScrapeUrlRequestException(): void
    {
        $url = 'https://example.com';

        // Mock Guzzle's post method to throw RequestException
        $this->clientMock->method('post')
            ->willThrowException(new RequestException('HTTP Error', new \GuzzleHttp\Psr7\Request('POST', '/v1/scrape/')));

        $this->loggerMock->expects($this->once())
            ->method('error')
            ->with("HTTP error during scrape for URL: $url - HTTP Error");

        $this->expectException(FirecrawlException::class);
        $this->expectExceptionMessage('HTTP Error: HTTP Error');

        $this->firecrawl->scrapeUrl($url);
    }

    public function testCrawlUrlSuccess(): void
    {
        $url = 'https://example.com';
        $jobId = 123;
        $responseData = ['id' => $jobId];
        $response = new Response(200, [], json_encode($responseData));

        // Mock Guzzle's post method
        $this->clientMock->method('post')
            ->with('/v1/crawl/', ['json' => ['url' => $url]])
            ->willReturn($response);

        // Mock monitorJobStatus method (since it's private, we'll call it manually)
        $this->firecrawl = $this->getMockBuilder(FirecrawlApp::class)
            ->setConstructorArgs(['fake-api-key', 'https://api.firecrawl.dev', $this->loggerMock])
            ->onlyMethods(['monitorJobStatus'])
            ->getMock();

        // Expect the monitorJobStatus method to return some mock data
        $this->firecrawl->expects($this->once())
            ->method('monitorJobStatus')
            ->with($jobId, 2)
            ->willReturn(['crawlResult' => 'success']);

        $this->loggerMock->expects($this->once())
            ->method('info')
            ->with("Starting crawl for URL: $url");

        $result = $this->firecrawl->crawlUrl($url, [], 2);
        $this->assertEquals(['crawlResult' => 'success'], $result);
    }

    public function testCrawlUrlRequestException(): void
    {
        $url = 'https://example.com';

        // Mock Guzzle's post method to throw RequestException
        $this->clientMock->method('post')
            ->willThrowException(new RequestException('HTTP Error', new \GuzzleHttp\Psr7\Request('POST', '/v1/crawl/')));

        $this->loggerMock->expects($this->once())
            ->method('error')
            ->with("HTTP error during crawl for URL: $url - HTTP Error");

        $this->expectException(FirecrawlException::class);
        $this->expectExceptionMessage('HTTP Error: HTTP Error');

        $this->firecrawl->crawlUrl($url, [], 2);
    }
}
