<?php

require 'vendor/autoload.php';

use Firecrawl\FirecrawlApp;

try {
    $firecrawl = new FirecrawlApp('test-api-key');

    // Scrape a URL
    $scrapedData = $firecrawl->scrapeUrl('https://example.com');
    echo "Scraped Data: \n";
    print_r($scrapedData);

    // Start a crawl job and monitor its progress
    $crawlData = $firecrawl->crawlUrl('https://example.com');
    echo "Crawl Data: \n";
    print_r($crawlData);

    // Check the status of a crawl
    $status = $firecrawl->checkCrawlStatus('crawl-job-id');
    echo "Crawl Status: \n";
    print_r($status);

} catch (Exception $e) {
    echo 'Error: ' . $e->getMessage();
}
