<?php

declare(strict_types=1);

namespace Firecrawl\Models;

final class BrowserExecuteResponse
{
    public function __construct(
        private readonly bool $success = false,
        private readonly ?string $stdout = null,
        private readonly ?string $result = null,
        private readonly ?string $stderr = null,
        private readonly ?int $exitCode = null,
        private readonly ?bool $killed = null,
        private readonly ?string $error = null,
    ) {}

    /** @param array<string, mixed> $data */
    public static function fromArray(array $data): self
    {
        return new self(
            success: (bool) ($data['success'] ?? false),
            stdout: $data['stdout'] ?? null,
            result: $data['result'] ?? null,
            stderr: $data['stderr'] ?? null,
            exitCode: isset($data['exitCode']) ? (int) $data['exitCode'] : null,
            killed: $data['killed'] ?? null,
            error: $data['error'] ?? null,
        );
    }

    public function isSuccess(): bool
    {
        return $this->success;
    }

    public function getStdout(): ?string
    {
        return $this->stdout;
    }

    public function getResult(): ?string
    {
        return $this->result;
    }

    public function getStderr(): ?string
    {
        return $this->stderr;
    }

    public function getExitCode(): ?int
    {
        return $this->exitCode;
    }

    public function isKilled(): ?bool
    {
        return $this->killed;
    }

    public function getError(): ?string
    {
        return $this->error;
    }
}
