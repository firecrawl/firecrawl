<?php

declare(strict_types=1);

namespace Firecrawl\Exceptions;

class JobTimeoutException extends FirecrawlException
{
    public function __construct(
        private readonly string $jobId,
        private readonly int $timeoutSeconds,
        string $jobType = 'Job',
    ) {
        parent::__construct(
            "{$jobType} {$jobId} timed out after {$timeoutSeconds} seconds",
            statusCode: 408,
        );
    }

    public function getJobId(): string
    {
        return $this->jobId;
    }

    public function getTimeoutSeconds(): int
    {
        return $this->timeoutSeconds;
    }
}
