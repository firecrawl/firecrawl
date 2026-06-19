using System.Net;
using System.Net.Http.Headers;
using System.Text;
using System.Text.Json;
using Firecrawl.Exceptions;
using Firecrawl.Models;
using Xunit;

namespace Firecrawl.Tests;

public class ParseTests
{
    [Fact]
    public void ParseFile_FromBytes_SetsProperties()
    {
        var bytes = Encoding.UTF8.GetBytes("<html><body>ok</body></html>");
        var file = ParseFile.FromBytes("upload.html", bytes, "text/html");

        Assert.Equal("upload.html", file.Filename);
        Assert.Equal(bytes, file.Content);
        Assert.Equal("text/html", file.ContentType);
    }

    [Fact]
    public void ParseFile_FromPath_LoadsFile()
    {
        var tempPath = Path.Combine(Path.GetTempPath(), $"parse-test-{Guid.NewGuid():N}.html");
        try
        {
            File.WriteAllText(tempPath, "<html>hi</html>", Encoding.UTF8);
            var file = ParseFile.FromPath(tempPath);

            Assert.Equal(Path.GetFileName(tempPath), file.Filename);
            Assert.NotEmpty(file.Content);
        }
        finally
        {
            if (File.Exists(tempPath))
                File.Delete(tempPath);
        }
    }

    [Fact]
    public void ParseFile_FromPath_ThrowsWhenMissing()
    {
        var bogusPath = Path.Combine(Path.GetTempPath(), $"missing-parse-{Guid.NewGuid():N}.html");
        Assert.Throws<FileNotFoundException>(() => ParseFile.FromPath(bogusPath));
    }

    [Fact]
    public void ParseOptions_Serializes_SupportedFields()
    {
        var options = new ParseOptions
        {
            Formats = new List<object> { "markdown" },
            OnlyMainContent = true,
            Timeout = 30000,
            Proxy = "auto",
            RedactPII = true,
        };

        var json = JsonSerializer.Serialize(options, FirecrawlHttpClient.JsonOptions);
        Assert.Contains("\"formats\"", json);
        Assert.Contains("\"onlyMainContent\":true", json);
        Assert.Contains("\"timeout\":30000", json);
        Assert.Contains("\"proxy\":\"auto\"", json);
        Assert.Contains("\"redactPII\":true", json);
    }

    [Fact]
    public void ParseOptions_Validate_RejectsUnsupportedFormats()
    {
        var options = new ParseOptions
        {
            Formats = new List<object> { "markdown", "screenshot" }
        };

        var ex = Assert.Throws<ArgumentException>(() => options.Validate());
        Assert.Contains("screenshot", ex.Message);
    }

    [Fact]
    public void ParseOptions_Validate_RejectsProductFormat()
    {
        var options = new ParseOptions
        {
            Formats = new List<object> { "markdown", "product" }
        };

        var ex = Assert.Throws<ArgumentException>(() => options.Validate());
        Assert.Contains("product", ex.Message);
    }

    [Fact]
    public void ParseOptions_Validate_RejectsMenuFormat()
    {
        var options = new ParseOptions
        {
            Formats = new List<object> { "markdown", "menu" }
        };

        var ex = Assert.Throws<ArgumentException>(() => options.Validate());
        Assert.Contains("menu", ex.Message);
    }

    [Fact]
    public void ParseOptions_Validate_RejectsUnsupportedProxy()
    {
        var options = new ParseOptions { Proxy = "stealth" };

        var ex = Assert.Throws<ArgumentException>(() => options.Validate());
        Assert.Contains("proxy", ex.Message);
    }

    [Fact]
    public void ParseOptions_Validate_RejectsNonPositiveTimeout()
    {
        var options = new ParseOptions { Timeout = 0 };

        Assert.Throws<ArgumentException>(() => options.Validate());
    }

    [Fact]
    public void ParseOptions_Validate_AllowsSupportedProxy()
    {
        var options = new ParseOptions { Proxy = "basic" };
        options.Validate();
    }

    [Fact]
    public async Task ParseAsync_RequiresFile()
    {
        var client = new FirecrawlClient(apiKey: "fc-test-key");
        await Assert.ThrowsAsync<ArgumentNullException>(() => client.ParseAsync(null!));
    }

    [Fact]
    public async Task ParseAsync_RejectsEmptyFilename()
    {
        var client = new FirecrawlClient(apiKey: "fc-test-key");
        var file = new ParseFile("", new byte[] { 1, 2, 3 });

        await Assert.ThrowsAsync<ArgumentException>(() => client.ParseAsync(file));
    }

    [Fact]
    public async Task ParseAsync_RejectsEmptyContent()
    {
        var client = new FirecrawlClient(apiKey: "fc-test-key");
        var file = new ParseFile("upload.html", Array.Empty<byte>());

        await Assert.ThrowsAsync<ArgumentException>(() => client.ParseAsync(file));
    }

    [Fact]
    public async Task ParseAsync_SendsMultipartRequest()
    {
        var handler = new CapturingHandler((req, ct) =>
        {
            var response = new HttpResponseMessage(HttpStatusCode.OK)
            {
                Content = new StringContent(
                    "{\"success\":true,\"data\":{\"markdown\":\"# Parsed\"}}",
                    Encoding.UTF8,
                    "application/json"),
            };
            return Task.FromResult(response);
        });

        var httpClient = new HttpClient(handler);
        var client = new FirecrawlClient(
            apiKey: "fc-test-key",
            apiUrl: "https://api.firecrawl.test",
            httpClient: httpClient);

        var file = ParseFile.FromBytes(
            "upload.html",
            Encoding.UTF8.GetBytes("<html>hi</html>"),
            "text/html");

        var doc = await client.ParseAsync(file,
            new ParseOptions { Formats = new List<object> { "markdown" } });

        Assert.NotNull(handler.LastRequest);
        Assert.Equal(HttpMethod.Post, handler.LastRequest!.Method);
        Assert.Equal("/v2/parse", handler.LastRequest.RequestUri!.AbsolutePath);

        var contentType = handler.LastRequest.Content!.Headers.ContentType!;
        Assert.Equal("multipart/form-data", contentType.MediaType);

        var rawBody = handler.LastRequestBody!;
        Assert.Matches("name=\"?options\"?", rawBody);
        Assert.Contains("\"markdown\"", rawBody);
        Assert.Matches("name=\"?file\"?", rawBody);
        Assert.Matches("filename=\"?upload\\.html\"?", rawBody);
        Assert.Contains("<html>hi</html>", rawBody);

        Assert.Equal("# Parsed", doc.Markdown);
    }

    [Fact]
    public async Task ParseAsync_PropagatesApiError()
    {
        var handler = new CapturingHandler((req, ct) =>
        {
            var response = new HttpResponseMessage(HttpStatusCode.BadRequest)
            {
                Content = new StringContent(
                    "{\"success\":false,\"error\":\"Unsupported upload type.\"}",
                    Encoding.UTF8,
                    "application/json"),
            };
            return Task.FromResult(response);
        });

        var httpClient = new HttpClient(handler);
        var client = new FirecrawlClient(
            apiKey: "fc-test-key",
            apiUrl: "https://api.firecrawl.test",
            httpClient: httpClient);

        var file = ParseFile.FromBytes("upload.xyz", new byte[] { 1, 2, 3 });

        var ex = await Assert.ThrowsAsync<FirecrawlException>(
            () => client.ParseAsync(file));
        Assert.Contains("Unsupported upload type", ex.Message);
    }

    private sealed class CapturingHandler : HttpMessageHandler
    {
        private readonly Func<HttpRequestMessage, CancellationToken, Task<HttpResponseMessage>> _responder;

        public HttpRequestMessage? LastRequest { get; private set; }

        public string? LastRequestBody { get; private set; }

        public CapturingHandler(Func<HttpRequestMessage, CancellationToken, Task<HttpResponseMessage>> responder)
        {
            _responder = responder;
        }

        protected override async Task<HttpResponseMessage> SendAsync(
            HttpRequestMessage request,
            CancellationToken cancellationToken)
        {
            // Read the request body eagerly because HttpClient disposes
            // request.Content after SendAsync returns.
            if (request.Content != null)
            {
                LastRequestBody = await request.Content.ReadAsStringAsync(cancellationToken);
            }

            LastRequest = request;
            return await _responder(request, cancellationToken);
        }
    }
}
