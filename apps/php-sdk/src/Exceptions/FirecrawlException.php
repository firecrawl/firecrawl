<?php

declare(strict_types=1);

namespace Firecrawl\Exceptions;

use RuntimeException;
use Throwable;

class FirecrawlException extends RuntimeException
{
    public function __construct(
        string $message = '',
        private readonly int $statusCode = 0,
        private readonly ?string $errorCode = null,
        private readonly mixed $details = null,
        ?Throwable $previous = null,
    ) {
        parent::__construct($message, $statusCode, $previous);
    }

    public function getStatusCode(): int
    {
        return $this->statusCode;
    }

    public function getErrorCode(): ?string
    {
        return $this->errorCode;
    }

    public function getDetails(): mixed
    {
        return $this->details;
    }
}
