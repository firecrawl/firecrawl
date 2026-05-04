<?php

declare(strict_types=1);

namespace Firecrawl\Client;

use Firecrawl\Exceptions\AuthenticationException;
use Firecrawl\Exceptions\FirecrawlException;
use Firecrawl\Exceptions\RateLimitException;
use Firecrawl\Version;
use GuzzleHttp\Client as GuzzleClient;
use GuzzleHttp\ClientInterface;
use GuzzleHttp\Exception\ConnectException;
use GuzzleHttp\Exception\RequestException;
use GuzzleHttp\RequestOptions;

/**
 * @internal
 */
final class FirecrawlHttpClient
{
    private readonly ClientInterface $httpClient;
    private readonly string $baseUrl;

    public function __construct(
        private readonly string $apiKey,
        string $baseUrl,
        float $timeoutSeconds,
        private readonly int $maxRetries,
        private readonly float $backoffFactor,
        ?ClientInterface $httpClient = null,
    ) {
        $this->baseUrl = rtrim($baseUrl, '/');

        $this->httpClient = $httpClient ?? new GuzzleClient([
            RequestOptions::TIMEOUT => $timeoutSeconds,
            RequestOptions::CONNECT_TIMEOUT => min($timeoutSeconds, 30),
            RequestOptions::HTTP_ERRORS => false,
        ]);
    }

    /**
     * @param array<string, mixed>  $body
     * @param array<string, string> $extraHeaders
     * @return array<string, mixed>
     */
    public function post(string $path, array $body, array $extraHeaders = []): array
    {
        return $this->request('POST', $this->baseUrl . $path, $body, $extraHeaders);
    }

    /** @return array<string, mixed> */
    public function get(string $path): array
    {
        return $this->request('GET', $this->baseUrl . $path);
    }

    /** @return array<string, mixed> */
    public function getAbsolute(string $absoluteUrl): array
    {
        return $this->request('GET', $absoluteUrl);
    }

    /** @return array<string, mixed> */
    public function delete(string $path): array
    {
        return $this->request('DELETE', $this->baseUrl . $path);
    }

    /**
     * @param array<string, mixed> $body
     * @return array<string, mixed>
     */
    public function patch(string $path, array $body): array
    {
        return $this->request('PATCH', $this->baseUrl . $path, $body);
    }

    /**
     * Send a POST request with a multipart/form-data body.
     *
     * @param array<string, string> $fields
     * @return array<string, mixed>
     */
    public function postMultipart(
        string $path,
        array $fields,
        string $fileField,
        string $fileName,
        string $fileContent,
        ?string $fileContentType = null,
    ): array {
        $multipart = [];
        foreach ($fields as $name => $value) {
            $multipart[] = [
                'name' => $name,
                'contents' => $value,
            ];
        }

        $filePart = [
            'name' => $fileField,
            'contents' => $fileContent,
            'filename' => $fileName,
        ];
        if ($fileContentType !== null && $fileContentType !== '') {
            $filePart['headers'] = ['Content-Type' => $fileContentType];
        }
        $multipart[] = $filePart;

        return $this->request(
            'POST',
            $this->baseUrl . $path,
            body: [],
            extraHeaders: [],
            multipart: $multipart,
        );
    }

    public function getBaseUrl(): string
    {
        return $this->baseUrl;
    }

    /**
     * @param array<string, mixed>                  $body
     * @param array<string, string>                 $extraHeaders
     * @param list<array<string, mixed>>|null       $multipart
     * @return array<string, mixed>
     */
    private function request(
        string $method,
        string $url,
        array $body = [],
        array $extraHeaders = [],
        ?array $multipart = null,
    ): array {
        $defaultHeaders = [
            'Authorization' => 'Bearer ' . $this->apiKey,
            'Accept' => 'application/json',
            'User-Agent' => 'firecrawl-php/' . Version::SDK_VERSION,
        ];

        if ($multipart === null) {
            $defaultHeaders['Content-Type'] = 'application/json';
        }

        $headers = array_merge($defaultHeaders, $extraHeaders);

        $options = [
            RequestOptions::HEADERS => $headers,
            RequestOptions::HTTP_ERRORS => false,
        ];

        if ($multipart !== null) {
            $options[RequestOptions::MULTIPART] = $multipart;
        } elseif (($method === 'POST' || $method === 'PATCH') && $body !== []) {
            $options[RequestOptions::JSON] = $body;
        }

        $attempt = 0;

        while (true) {
            try {
                $response = $this->httpClient->request($method, $url, $options);
                $statusCode = $response->getStatusCode();
                $responseBody = (string) $response->getBody();

                if ($statusCode >= 200 && $statusCode < 300) {
                    if ($responseBody === '' || $responseBody === '{}') {
                        return [];
                    }
                    /** @var array<string, mixed> */
                    return json_decode($responseBody, true, 512, JSON_THROW_ON_ERROR);
                }

                $errorMessage = $this->extractErrorMessage($responseBody, $statusCode);
                $errorCode = $this->extractErrorCode($responseBody);

                // Non-retryable client errors
                if ($statusCode === 401) {
                    throw new AuthenticationException($errorMessage, $errorCode);
                }

                if ($statusCode === 429) {
                    throw new RateLimitException($errorMessage, $errorCode);
                }

                if ($statusCode >= 400 && $statusCode < 500 && $statusCode !== 408 && $statusCode !== 409) {
                    throw new FirecrawlException($errorMessage, $statusCode, $errorCode);
                }

                // Retryable errors: 408, 409, 502, 5xx
                if ($attempt < $this->maxRetries) {
                    $attempt++;
                    $this->sleepWithBackoff($attempt);
                    continue;
                }

                throw new FirecrawlException($errorMessage, $statusCode, $errorCode);
            } catch (FirecrawlException $e) {
                throw $e;
            } catch (ConnectException $e) {
                if ($attempt < $this->maxRetries) {
                    $attempt++;
                    $this->sleepWithBackoff($attempt);
                    continue;
                }
                throw new FirecrawlException('Connection failed: ' . $e->getMessage(), previous: $e);
            } catch (RequestException $e) {
                if ($attempt < $this->maxRetries) {
                    $attempt++;
                    $this->sleepWithBackoff($attempt);
                    continue;
                }
                throw new FirecrawlException('Request failed: ' . $e->getMessage(), previous: $e);
            } catch (\JsonException $e) {
                throw new FirecrawlException('Failed to parse API response: ' . $e->getMessage(), previous: $e);
            }
        }
    }

    private function extractErrorMessage(string $body, int $statusCode): string
    {
        try {
            /** @var array<string, mixed> $parsed */
            $parsed = json_decode($body, true, 512, JSON_THROW_ON_ERROR);

            if (isset($parsed['error']) && is_string($parsed['error'])) {
                return $parsed['error'];
            }

            if (isset($parsed['message']) && is_string($parsed['message'])) {
                return $parsed['message'];
            }
        } catch (\JsonException) {
            // ignore
        }

        return "HTTP {$statusCode} error";
    }

    private function extractErrorCode(string $body): ?string
    {
        try {
            /** @var array<string, mixed> $parsed */
            $parsed = json_decode($body, true, 512, JSON_THROW_ON_ERROR);

            if (isset($parsed['code'])) {
                return (string) $parsed['code'];
            }
        } catch (\JsonException) {
            // ignore
        }

        return null;
    }

    private function sleepWithBackoff(int $attempt): void
    {
        $delayMs = (int) ($this->backoffFactor * 1000 * pow(2, $attempt - 1));
        usleep($delayMs * 1000);
    }
}
