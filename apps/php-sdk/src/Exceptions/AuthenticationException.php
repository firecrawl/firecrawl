<?php

declare(strict_types=1);

namespace Firecrawl\Exceptions;

class AuthenticationException extends FirecrawlException
{
    public function __construct(
        string $message = 'Authentication failed. Check your API key.',
        ?string $errorCode = null,
        mixed $details = null,
    ) {
        parent::__construct($message, 401, $errorCode, $details);
    }
}
