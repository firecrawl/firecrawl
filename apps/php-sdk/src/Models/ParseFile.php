<?php

declare(strict_types=1);

namespace Firecrawl\Models;

use Firecrawl\Exceptions\FirecrawlException;

/**
 * Binary upload payload for the `/v2/parse` endpoint.
 *
 * Supported file extensions: .html, .htm, .pdf, .docx, .doc, .odt, .rtf, .xlsx, .xls
 */
final class ParseFile
{
    private const CONTENT_TYPE_BY_EXTENSION = [
        'pdf' => 'application/pdf',
        'html' => 'text/html',
        'htm' => 'text/html',
        'xhtml' => 'application/xhtml+xml',
        'docx' => 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
        'doc' => 'application/msword',
        'odt' => 'application/vnd.oasis.opendocument.text',
        'rtf' => 'application/rtf',
        'xlsx' => 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
        'xls' => 'application/vnd.ms-excel',
    ];

    private function __construct(
        private readonly string $filename,
        private readonly string $content,
        private readonly ?string $contentType,
    ) {}

    /**
     * Build a ParseFile from raw bytes.
     */
    public static function fromBytes(
        string $filename,
        string $content,
        ?string $contentType = null,
    ): self {
        $trimmed = trim($filename);
        if ($trimmed === '') {
            throw new FirecrawlException('filename is required');
        }
        if ($content === '') {
            throw new FirecrawlException('content is required');
        }

        return new self($trimmed, $content, $contentType);
    }

    /**
     * Build a ParseFile by reading a file from disk.
     */
    public static function fromPath(
        string $path,
        ?string $filename = null,
        ?string $contentType = null,
    ): self {
        if ($path === '') {
            throw new FirecrawlException('path is required');
        }
        if (!is_file($path) || !is_readable($path)) {
            throw new FirecrawlException('file path does not exist or is not readable: ' . $path);
        }

        $content = @file_get_contents($path);
        if ($content === false) {
            throw new FirecrawlException('failed to read parse file: ' . $path);
        }

        $resolvedFilename = $filename ?: basename($path);
        $resolvedContentType = $contentType ?: self::guessContentType($resolvedFilename);

        return self::fromBytes($resolvedFilename, $content, $resolvedContentType);
    }

    public function getFilename(): string
    {
        return $this->filename;
    }

    public function getContent(): string
    {
        return $this->content;
    }

    public function getContentType(): ?string
    {
        return $this->contentType;
    }

    private static function guessContentType(string $filename): ?string
    {
        $ext = strtolower(pathinfo($filename, PATHINFO_EXTENSION));
        return self::CONTENT_TYPE_BY_EXTENSION[$ext] ?? null;
    }
}
