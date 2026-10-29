<?php

declare(strict_types=1);

namespace Firecrawl\Laravel;

use Firecrawl\Client\FirecrawlClient;
use Illuminate\Support\ServiceProvider;

class FirecrawlServiceProvider extends ServiceProvider
{
    public function register(): void
    {
        $this->mergeConfigFrom(__DIR__ . '/../../config/firecrawl.php', 'firecrawl');

        $this->app->singleton(FirecrawlClient::class, function ($app): FirecrawlClient {
            /** @var array<string, mixed> $config */
            $config = $app['config']->get('firecrawl', []);

            $apiKey = isset($config['api_key']) && is_string($config['api_key'])
                ? trim($config['api_key'])
                : null;

            if ($apiKey === '') {
                $apiKey = null;
            }

            return FirecrawlClient::create(
                apiKey: $apiKey,
                apiUrl: isset($config['api_url']) && is_string($config['api_url']) ? $config['api_url'] : null,
                timeoutSeconds: (float) ($config['timeout'] ?? 300),
                maxRetries: (int) ($config['max_retries'] ?? 3),
                backoffFactor: (float) ($config['backoff_factor'] ?? 0.5),
            );
        });

        $this->app->alias(FirecrawlClient::class, 'firecrawl');
    }

    public function boot(): void
    {
        if ($this->app->runningInConsole()) {
            $this->publishes([
                __DIR__ . '/../../config/firecrawl.php' => $this->app->configPath('firecrawl.php'),
            ], 'firecrawl-config');
        }
    }

    /** @return list<string> */
    public function provides(): array
    {
        return [FirecrawlClient::class, 'firecrawl'];
    }
}
