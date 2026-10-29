<?php

declare(strict_types=1);

return [
    /*
    |--------------------------------------------------------------------------
    | Firecrawl API Key
    |--------------------------------------------------------------------------
    |
    | Your Firecrawl API key. Get one at https://firecrawl.dev.
    | Falls back to the FIRECRAWL_API_KEY environment variable.
    |
    */
    'api_key' => env('FIRECRAWL_API_KEY'),

    /*
    |--------------------------------------------------------------------------
    | Firecrawl API URL
    |--------------------------------------------------------------------------
    |
    | The base URL for the Firecrawl API.
    | Falls back to the FIRECRAWL_API_URL environment variable or the default.
    |
    */
    'api_url' => env('FIRECRAWL_API_URL', 'https://api.firecrawl.dev'),

    /*
    |--------------------------------------------------------------------------
    | Request Timeout
    |--------------------------------------------------------------------------
    |
    | The timeout in seconds for HTTP requests to the Firecrawl API.
    |
    */
    'timeout' => (float) env('FIRECRAWL_TIMEOUT', 300),

    /*
    |--------------------------------------------------------------------------
    | Max Retries
    |--------------------------------------------------------------------------
    |
    | The maximum number of times to retry a failed request.
    | Retryable errors: 408, 409, 502, 5xx, and connection failures.
    |
    */
    'max_retries' => (int) env('FIRECRAWL_MAX_RETRIES', 3),

    /*
    |--------------------------------------------------------------------------
    | Backoff Factor
    |--------------------------------------------------------------------------
    |
    | The exponential backoff factor in seconds for retries.
    | Delay = backoff_factor * 2^(attempt - 1)
    |
    */
    'backoff_factor' => (float) env('FIRECRAWL_BACKOFF_FACTOR', 0.5),
];
