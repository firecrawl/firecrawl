<?php

declare(strict_types=1);

namespace Firecrawl\Exceptions;

class RateLimitException extends FirecrawlException
{
    public function __construct(
        string $message = 'Rate limit exceeded.',
        ?string $errorCode = null,
        mixed $details = null,
    ) {
        parent::__construct($message, 429, $errorCode, $details);
    }
}
