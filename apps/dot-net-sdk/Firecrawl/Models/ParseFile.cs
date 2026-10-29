namespace Firecrawl.Models;

/// <summary>
/// Uploaded file payload for the <c>/v2/parse</c> endpoint.
/// </summary>
public class ParseFile
{
    /// <summary>
    /// Filename used in the multipart upload (e.g. <c>upload.pdf</c>).
    /// </summary>
    public string Filename { get; set; }

    /// <summary>
    /// Raw bytes of the file to be parsed.
    /// </summary>
    public byte[] Content { get; set; }

    /// <summary>
    /// Optional MIME type hint (e.g. <c>application/pdf</c>).
    /// When null, the value is guessed from the filename extension,
    /// falling back to <c>application/octet-stream</c>.
    /// </summary>
    public string? ContentType { get; set; }

    public ParseFile(string filename, byte[] content, string? contentType = null)
    {
        Filename = filename;
        Content = content;
        ContentType = contentType;
    }

    /// <summary>
    /// Build a <see cref="ParseFile"/> from raw bytes.
    /// </summary>
    public static ParseFile FromBytes(string filename, byte[] content, string? contentType = null)
        => new(filename, content, contentType);

    /// <summary>
    /// Build a <see cref="ParseFile"/> by reading a file from disk.
    /// The filename is derived from the path unless overridden.
    /// </summary>
    public static ParseFile FromPath(string path, string? filename = null, string? contentType = null)
    {
        if (string.IsNullOrWhiteSpace(path))
            throw new ArgumentException("Path cannot be empty.", nameof(path));

        if (!File.Exists(path))
            throw new FileNotFoundException($"Parse file not found: {path}", path);

        var bytes = File.ReadAllBytes(path);
        var resolvedName = filename ?? Path.GetFileName(path);
        return new ParseFile(resolvedName, bytes, contentType);
    }

    internal string ResolveContentType()
    {
        if (!string.IsNullOrWhiteSpace(ContentType))
            return ContentType;

        var extension = Path.GetExtension(Filename).ToLowerInvariant();
        return extension switch
        {
            ".html" or ".htm" => "text/html",
            ".pdf" => "application/pdf",
            ".docx" => "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
            ".doc" => "application/msword",
            ".xlsx" => "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
            ".xls" => "application/vnd.ms-excel",
            ".pptx" => "application/vnd.openxmlformats-officedocument.presentationml.presentation",
            ".ppt" => "application/vnd.ms-powerpoint",
            ".txt" => "text/plain",
            ".md" => "text/markdown",
            ".csv" => "text/csv",
            ".json" => "application/json",
            ".xml" => "application/xml",
            ".rtf" => "application/rtf",
            _ => "application/octet-stream",
        };
    }
}
