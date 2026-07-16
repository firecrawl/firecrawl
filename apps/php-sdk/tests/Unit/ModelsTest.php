<?php

declare(strict_types=1);

use Firecrawl\Models\CreditUsage;
use Firecrawl\Models\Document;
use Firecrawl\Models\Product;
use Firecrawl\Models\Menu;
use Firecrawl\Models\MapData;
use Firecrawl\Models\BatchScrapeJob;
use Firecrawl\Models\CrawlJob;
use Firecrawl\Models\HighlightsFormat;
use Firecrawl\Models\QueryFormat;
use Firecrawl\Models\QuestionFormat;
use Firecrawl\Models\ScrapeOptions;
use Firecrawl\Models\SearchOptions;
use Firecrawl\Models\Monitor;
use Firecrawl\Models\MonitorCheck;

it('hydrates CreditUsage from nested data key', function (): void {
    $response = [
        'success' => true,
        'data' => [
            'remainingCredits' => 500,
            'planCredits' => 1000,
            'billingPeriodStart' => '2025-01-01',
            'billingPeriodEnd' => '2025-02-01',
        ],
    ];

    $usage = CreditUsage::fromArray($response);

    expect($usage->getRemainingCredits())->toBe(500);
    expect($usage->getPlanCredits())->toBe(1000);
    expect($usage->getBillingPeriodStart())->toBe('2025-01-01');
    expect($usage->getBillingPeriodEnd())->toBe('2025-02-01');
});

it('hydrates CreditUsage from flat data', function (): void {
    $response = [
        'remainingCredits' => 250,
        'planCredits' => 500,
    ];

    $usage = CreditUsage::fromArray($response);

    expect($usage->getRemainingCredits())->toBe(250);
    expect($usage->getPlanCredits())->toBe(500);
});

it('guards MapData links against non-array input', function (): void {
    $data = ['links' => 'not-an-array'];

    $map = MapData::fromArray($data);

    expect($map->getLinks())->toBe([]);
});

it('normalizes MapData string links', function (): void {
    $data = [
        'links' => [
            'https://example.com',
            ['url' => 'https://example.com/about', 'title' => 'About'],
        ],
    ];

    $map = MapData::fromArray($data);

    expect($map->getLinks())->toHaveCount(2);
    expect($map->getLinks()[0])->toBe(['url' => 'https://example.com']);
    expect($map->getLinks()[1])->toBe(['url' => 'https://example.com/about', 'title' => 'About']);
});

it('casts creditsUsed to int in BatchScrapeJob', function (): void {
    $raw = [
        'id' => 'batch-123',
        'status' => 'completed',
        'completed' => 5,
        'total' => 5,
        'creditsUsed' => '42',
        'data' => [],
    ];

    $job = BatchScrapeJob::fromArray($raw);

    expect($job->getCreditsUsed())->toBe(42);
    expect($job->getCreditsUsed())->toBeInt();
});

it('preserves null creditsUsed in CrawlJob', function (): void {
    $raw = [
        'id' => 'crawl-123',
        'status' => 'scraping',
        'data' => [],
    ];

    $job = CrawlJob::fromArray($raw);

    expect($job->getCreditsUsed())->toBeNull();
});

it('hydrates video URL in Document', function (): void {
    $doc = Document::fromArray([
        'markdown' => '# Video',
        'video' => 'https://storage.googleapis.com/firecrawl/video.mp4',
    ]);

    expect($doc->getMarkdown())->toBe('# Video');
    expect($doc->getVideo())->toBe('https://storage.googleapis.com/firecrawl/video.mp4');
});

it('hydrates product into Product model in Document', function (): void {
    $doc = Document::fromArray([
        'markdown' => '# Product',
        'product' => [
            'title' => 'Running Shoe',
            'brand' => 'Acme',
            'category' => 'Footwear',
            'url' => 'https://example.com/shoe',
            'description' => 'A fast running shoe.',
            'variants' => [
                [
                    'id' => 'v1',
                    'sku' => 'SHOE-RED-42',
                    'title' => 'Red / 42',
                    'values' => ['color' => 'red', 'size' => '42'],
                    'price' => ['amount' => 99.99, 'currency' => 'USD', 'formatted' => '$99.99'],
                    'sale' => ['originalPrice' => ['amount' => 129.99, 'currency' => 'USD']],
                    'availability' => ['inStock' => false, 'text' => 'Sold out'],
                    'images' => [['url' => 'https://example.com/shoe-red.jpg']],
                ],
                [
                    'id' => 'v2',
                    'title' => 'Blue / 42',
                    'values' => ['color' => 'blue', 'size' => '42', 'limited' => true],
                ],
            ],
        ],
    ]);

    $product = $doc->getProduct();

    expect($product)->toBeInstanceOf(Product::class);
    expect($product->getTitle())->toBe('Running Shoe');
    expect($product->getBrand())->toBe('Acme');
    expect($product->getCategory())->toBe('Footwear');
    expect($product->getUrl())->toBe('https://example.com/shoe');
    expect($product->getDescription())->toBe('A fast running shoe.');
    expect($product->getVariants())->toHaveCount(2);

    $v1 = $product->getVariants()[0];
    expect($v1['id'])->toBe('v1');
    expect($v1['values'])->toBe(['color' => 'red', 'size' => '42']);
    expect($v1['price'])->toBe(['amount' => 99.99, 'currency' => 'USD', 'formatted' => '$99.99']);
    expect($v1['sale'])->toBe(['originalPrice' => ['amount' => 129.99, 'currency' => 'USD']]);
    expect($v1['availability'])->toBe(['inStock' => false, 'text' => 'Sold out']);
    expect($v1['images'])->toBe([['url' => 'https://example.com/shoe-red.jpg']]);

    // Availability is always present, even when omitted from the payload.
    $v2 = $product->getVariants()[1];
    expect($v2['values'])->toBe(['color' => 'blue', 'size' => '42', 'limited' => true]);
    expect($v2['availability'])->toBe(['inStock' => false]);
    expect(array_key_exists('sale', $v2))->toBeFalse();
    expect(array_key_exists('price', $v2))->toBeFalse();
});

it('returns null product when absent in Document', function (): void {
    $doc = Document::fromArray(['markdown' => '# No product']);

    expect($doc->getProduct())->toBeNull();
});

it('hydrates menu into Menu model in Document', function (): void {
    $doc = Document::fromArray([
        'markdown' => '# Menu',
        'menu' => [
            'isMenu' => true,
            'confidence' => 0.95,
            'currency' => 'USD',
            'sourceUrl' => 'https://example.com/menu',
            'merchant' => [
                'name' => 'Cafe Acme',
                'type' => 'restaurant',
                'location' => ['city' => 'Springfield'],
            ],
            'sections' => [
                [
                    'id' => 's1',
                    'name' => 'Drinks',
                    'description' => 'Hot and cold beverages.',
                    'items' => [
                        [
                            'id' => 'i1',
                            'name' => 'Latte',
                            'description' => 'Espresso with steamed milk.',
                            'url' => 'https://example.com/menu/latte',
                            'sourceUrl' => 'https://example.com/menu',
                            'images' => [['url' => 'https://example.com/latte.jpg']],
                            'price' => ['amount' => 4.5, 'currency' => 'USD', 'formatted' => '$4.50'],
                            'availability' => ['inStock' => true, 'text' => 'Available'],
                            'dietary' => ['vegetarian'],
                            'calories' => 120,
                            'optionGroups' => [['name' => 'Size', 'options' => ['S', 'M', 'L']]],
                            'identifiers' => ['merchantItemId' => 'LATTE-1'],
                        ],
                        [
                            'id' => 'i2',
                            'name' => 'Water',
                            'sourceUrl' => 'https://example.com/menu',
                        ],
                    ],
                ],
            ],
        ],
    ]);

    $menu = $doc->getMenu();

    expect($menu)->toBeInstanceOf(Menu::class);
    expect($menu->getIsMenu())->toBeTrue();
    expect($menu->getConfidence())->toBe(0.95);
    expect($menu->getCurrency())->toBe('USD');
    expect($menu->getSourceUrl())->toBe('https://example.com/menu');
    expect($menu->getMerchant())->toBe([
        'name' => 'Cafe Acme',
        'type' => 'restaurant',
        'location' => ['city' => 'Springfield'],
    ]);
    expect($menu->getSections())->toHaveCount(1);

    $section = $menu->getSections()[0];
    expect($section['id'])->toBe('s1');
    expect($section['name'])->toBe('Drinks');
    expect($section['description'])->toBe('Hot and cold beverages.');
    expect($section['items'])->toHaveCount(2);

    $i1 = $section['items'][0];
    expect($i1['id'])->toBe('i1');
    expect($i1['name'])->toBe('Latte');
    expect($i1['sourceUrl'])->toBe('https://example.com/menu');
    expect($i1['images'])->toBe([['url' => 'https://example.com/latte.jpg']]);
    expect($i1['price'])->toBe(['amount' => 4.5, 'currency' => 'USD', 'formatted' => '$4.50']);
    expect($i1['availability'])->toBe(['inStock' => true, 'text' => 'Available']);
    expect($i1['dietary'])->toBe(['vegetarian']);
    expect($i1['calories'])->toBe(120.0);
    expect($i1['optionGroups'])->toBe([['name' => 'Size', 'options' => ['S', 'M', 'L']]]);
    expect($i1['identifiers'])->toBe(['merchantItemId' => 'LATTE-1']);

    // Availability is always present, even when omitted from the payload.
    $i2 = $section['items'][1];
    expect($i2['name'])->toBe('Water');
    expect($i2['availability'])->toBe(['inStock' => false]);
    expect(array_key_exists('price', $i2))->toBeFalse();
    expect(array_key_exists('calories', $i2))->toBeFalse();
});

it('returns null menu when absent in Document', function (): void {
    $doc = Document::fromArray(['markdown' => '# No menu']);

    expect($doc->getMenu())->toBeNull();
});

it('serializes the search highlights option', function (): void {
    $options = SearchOptions::with(highlights: false);

    expect($options->toArray())->toBe(['highlights' => false]);
});

it('coerces non-string scalar identity fields without a TypeError under strict_types', function (): void {
    // Defensive: upstream data could carry a non-string scalar (e.g. a numeric
    // brand). Under declare(strict_types=1) these must be cast, not passed raw.
    $product = Product::fromArray([
        'title' => 'Widget',
        'url' => 'https://example.com/widget',
        'brand' => 1234,
        'category' => 56.7,
        'description' => true,
        'variants' => [],
    ]);

    expect($product->getBrand())->toBe('1234');
    expect($product->getCategory())->toBe('56.7');
    expect($product->getDescription())->toBe('1');
    expect($product->getVariants())->toBe([]);
});

it('preserves positional integration in ScrapeOptions::with', function (): void {
    $options = ScrapeOptions::with(
        null,
        null,
        null,
        null,
        null,
        null,
        null,
        null,
        null,
        null,
        null,
        null,
        null,
        null,
        null,
        null,
        false,
        'php-sdk',
    );

    expect($options->getStoreInCache())->toBeFalse();
    expect($options->getIntegration())->toBe('php-sdk');
    expect($options->getLockdown())->toBeNull();
    expect($options->toArray())->toMatchArray([
        'storeInCache' => false,
        'integration' => 'php-sdk',
    ]);
});

it('serializes lockdown in ScrapeOptions', function (): void {
    $options = ScrapeOptions::with(
        lockdown: true,
        integration: 'php-sdk',
    );

    expect($options->getLockdown())->toBeTrue();
    expect($options->toArray())->toMatchArray([
        'lockdown' => true,
        'integration' => 'php-sdk',
    ]);
});

it('serializes redactPII in ScrapeOptions', function (): void {
    $options = ScrapeOptions::with(
        redactPII: true,
    );

    expect($options->getRedactPII())->toBeTrue();
    expect($options->toArray())->toMatchArray([
        'redactPII' => true,
    ]);
    expect(array_key_exists('formats', $options->toArray()))->toBeFalse();
});

it('serializes query format mode in ScrapeOptions', function (): void {
    $options = ScrapeOptions::with(
        formats: [QueryFormat::with('What is Firecrawl?', QueryFormat::MODE_DIRECT_QUOTE)],
    );

    expect($options->toArray()['formats'][0])->toMatchArray([
        'type' => 'query',
        'prompt' => 'What is Firecrawl?',
        'mode' => 'directQuote',
    ]);
});

it('serializes question and highlights formats in ScrapeOptions', function (): void {
    $options = ScrapeOptions::with(
        formats: [
            QuestionFormat::with('What is Firecrawl?'),
            HighlightsFormat::with('What is Firecrawl?'),
        ],
    );

    expect($options->toArray()['formats'])->toMatchArray([
        [
            'type' => 'question',
            'question' => 'What is Firecrawl?',
        ],
        [
            'type' => 'highlights',
            'query' => 'What is Firecrawl?',
        ],
    ]);
});

it('rejects invalid query format mode', function (): void {
    QueryFormat::with('What is Firecrawl?', 'quoted');
})->throws(InvalidArgumentException::class, "query mode must be 'freeform' or 'directQuote'");

it('hydrates a search target and goal/judgeEnabled in Monitor', function (): void {
    $monitor = Monitor::fromArray([
        'id' => 'mon-1',
        'name' => 'AI news',
        'status' => 'active',
        'goal' => 'Track new AI launches',
        'judgeEnabled' => true,
        'targets' => [
            [
                'id' => 'tgt-1',
                'type' => 'search',
                'queries' => ['firecrawl release', 'firecrawl changelog'],
                'searchWindow' => '24h',
                'includeDomains' => ['firecrawl.dev'],
                'excludeDomains' => ['spam.example'],
                'maxResults' => 10,
            ],
        ],
    ]);

    expect($monitor->getGoal())->toBe('Track new AI launches');
    expect($monitor->getJudgeEnabled())->toBeTrue();
    expect($monitor->getTargets())->toHaveCount(1);

    $target = $monitor->getTargets()[0];
    expect($target['type'])->toBe('search');
    expect($target['queries'])->toBe(['firecrawl release', 'firecrawl changelog']);
    expect($target['searchWindow'])->toBe('24h');
    expect($target['includeDomains'])->toBe(['firecrawl.dev']);
    expect($target['excludeDomains'])->toBe(['spam.example']);
    expect($target['maxResults'])->toBe(10);
});

it('passes through a search target result on MonitorCheck', function (): void {
    $check = MonitorCheck::fromArray([
        'id' => 'chk-1',
        'monitorId' => 'mon-1',
        'status' => 'completed',
        'targetResults' => [
            [
                'targetId' => 'tgt-1',
                'type' => 'search',
                'searchCompleted' => true,
                'resultCount' => 7,
                'matches' => 2,
                'summary' => 'Two new launches detected.',
                'judgeDegraded' => false,
                'degradedReason' => null,
                'searchCredits' => 7,
                'judgeCredits' => 2,
                'resultsJudged' => 7,
            ],
        ],
    ]);

    $results = $check->getTargetResults();
    expect($results)->toBeArray();
    expect($results[0]['type'])->toBe('search');
    expect($results[0]['searchCompleted'])->toBeTrue();
    expect($results[0]['resultCount'])->toBe(7);
    expect($results[0]['matches'])->toBe(2);
    expect($results[0]['summary'])->toBe('Two new launches detected.');
    expect($results[0]['judgeDegraded'])->toBeFalse();
    expect($results[0]['degradedReason'])->toBeNull();
    expect($results[0]['searchCredits'])->toBe(7);
    expect($results[0]['judgeCredits'])->toBe(2);
    expect($results[0]['resultsJudged'])->toBe(7);
});
