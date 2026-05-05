using System.Text.Json;
using Firecrawl.Exceptions;
using Firecrawl.Models;
using MonitorModel = Firecrawl.Models.Monitor;

namespace Firecrawl;

/// <summary>
/// Client for the Firecrawl v2 API.
///
/// <example>
/// <code>
/// var client = new FirecrawlClient("fc-your-api-key");
///
/// // Scrape a single page
/// var doc = await client.ScrapeAsync("https://example.com",
///     new ScrapeOptions { Formats = new List&lt;object&gt; { "markdown" } });
///
/// // Crawl a website
/// var job = await client.CrawlAsync("https://example.com",
///     new CrawlOptions { Limit = 50 });
/// </code>
/// </example>
/// </summary>
public class FirecrawlClient
{
    private const string DefaultApiUrl = "https://api.firecrawl.dev";
    private static readonly TimeSpan DefaultTimeout = TimeSpan.FromMinutes(5);
    private const int DefaultMaxRetries = 3;
    private const double DefaultBackoffFactor = 0.5;
    private const int DefaultPollIntervalSec = 2;
    private const int DefaultJobTimeoutSec = 300;

    private readonly FirecrawlHttpClient _http;

    /// <summary>
    /// Creates a new FirecrawlClient with the specified API key.
    /// </summary>
    /// <param name="apiKey">The Firecrawl API key.</param>
    /// <param name="apiUrl">Optional API base URL (defaults to https://api.firecrawl.dev).</param>
    /// <param name="timeout">Optional HTTP request timeout.</param>
    /// <param name="maxRetries">Optional maximum number of retries for transient failures.</param>
    /// <param name="backoffFactor">Optional exponential backoff factor in seconds.</param>
    /// <param name="httpClient">Optional pre-configured HttpClient instance.</param>
    public FirecrawlClient(
        string? apiKey = null,
        string? apiUrl = null,
        TimeSpan? timeout = null,
        int maxRetries = DefaultMaxRetries,
        double backoffFactor = DefaultBackoffFactor,
        HttpClient? httpClient = null)
    {
        var resolvedKey = ResolveApiKey(apiKey);
        var resolvedUrl = ResolveApiUrl(apiUrl);

        _http = new FirecrawlHttpClient(
            resolvedKey,
            resolvedUrl,
            timeout ?? DefaultTimeout,
            maxRetries,
            backoffFactor,
            httpClient);
    }

    // ================================================================
    // SCRAPE
    // ================================================================

    /// <summary>
    /// Scrapes a single URL and returns the document.
    /// </summary>
    public async Task<Document> ScrapeAsync(
        string url,
        ScrapeOptions? options = null,
        CancellationToken cancellationToken = default)
    {
        ArgumentNullException.ThrowIfNull(url);

        var body = BuildBody(options);
        body["url"] = url;

        var response = await _http.PostAsync<ApiResponse<Document>>(
            "/v2/scrape", body, cancellationToken: cancellationToken);

        return response.Data ?? throw new FirecrawlException("Scrape response contained no data");
    }

    // ================================================================
    // CRAWL
    // ================================================================

    /// <summary>
    /// Starts an async crawl job and returns immediately.
    /// </summary>
    public async Task<CrawlResponse> StartCrawlAsync(
        string url,
        CrawlOptions? options = null,
        CancellationToken cancellationToken = default)
    {
        ArgumentNullException.ThrowIfNull(url);

        var body = BuildBody(options);
        body["url"] = url;

        return await _http.PostAsync<CrawlResponse>(
            "/v2/crawl", body, cancellationToken: cancellationToken);
    }

    /// <summary>
    /// Gets the status and results of a crawl job.
    /// </summary>
    public async Task<CrawlJob> GetCrawlStatusAsync(
        string jobId,
        CancellationToken cancellationToken = default)
    {
        ArgumentNullException.ThrowIfNull(jobId);

        return await _http.GetAsync<CrawlJob>(
            $"/v2/crawl/{jobId}", cancellationToken);
    }

    /// <summary>
    /// Crawls a website and waits for completion (auto-polling).
    /// </summary>
    public async Task<CrawlJob> CrawlAsync(
        string url,
        CrawlOptions? options = null,
        int pollIntervalSec = DefaultPollIntervalSec,
        int timeoutSec = DefaultJobTimeoutSec,
        CancellationToken cancellationToken = default)
    {
        var start = await StartCrawlAsync(url, options, cancellationToken);
        return await PollCrawlAsync(
            start.Id ?? throw new FirecrawlException("Crawl start did not return a job ID"),
            pollIntervalSec, timeoutSec, cancellationToken);
    }

    /// <summary>
    /// Cancels a running crawl job.
    /// </summary>
    public async Task<Dictionary<string, object>> CancelCrawlAsync(
        string jobId,
        CancellationToken cancellationToken = default)
    {
        ArgumentNullException.ThrowIfNull(jobId);

        return await _http.DeleteAsync<Dictionary<string, object>>(
            $"/v2/crawl/{jobId}", cancellationToken);
    }

    /// <summary>
    /// Gets errors from a crawl job.
    /// </summary>
    public async Task<Dictionary<string, object>> GetCrawlErrorsAsync(
        string jobId,
        CancellationToken cancellationToken = default)
    {
        ArgumentNullException.ThrowIfNull(jobId);

        return await _http.GetAsync<Dictionary<string, object>>(
            $"/v2/crawl/{jobId}/errors", cancellationToken);
    }

    // ================================================================
    // BATCH SCRAPE
    // ================================================================

    /// <summary>
    /// Starts an async batch scrape job.
    /// </summary>
    public async Task<BatchScrapeResponse> StartBatchScrapeAsync(
        List<string> urls,
        BatchScrapeOptions? options = null,
        CancellationToken cancellationToken = default)
    {
        ArgumentNullException.ThrowIfNull(urls);

        var body = BuildBody(options);
        body["urls"] = urls;

        // The API expects scrape options flattened at the top level
        if (body.TryGetValue("options", out var nested) && nested is JsonElement nestedElement)
        {
            body.Remove("options");
            var nestedDict = JsonSerializer.Deserialize<Dictionary<string, object>>(
                nestedElement.GetRawText(), FirecrawlHttpClient.JsonOptions);
            if (nestedDict != null)
            {
                var batchFields = new Dictionary<string, object>(body);
                foreach (var kv in nestedDict)
                    body.TryAdd(kv.Key, kv.Value);
                foreach (var kv in batchFields)
                    body[kv.Key] = kv.Value;
            }
        }

        Dictionary<string, string>? extraHeaders = null;
        if (options?.IdempotencyKey is { Length: > 0 } idempotencyKey)
        {
            extraHeaders = new Dictionary<string, string>
            {
                ["x-idempotency-key"] = idempotencyKey
            };
        }

        return await _http.PostAsync<BatchScrapeResponse>(
            "/v2/batch/scrape", body, extraHeaders, cancellationToken);
    }

    /// <summary>
    /// Gets the status and results of a batch scrape job.
    /// </summary>
    public async Task<BatchScrapeJob> GetBatchScrapeStatusAsync(
        string jobId,
        CancellationToken cancellationToken = default)
    {
        ArgumentNullException.ThrowIfNull(jobId);

        return await _http.GetAsync<BatchScrapeJob>(
            $"/v2/batch/scrape/{jobId}", cancellationToken);
    }

    /// <summary>
    /// Batch-scrapes URLs and waits for completion (auto-polling).
    /// </summary>
    public async Task<BatchScrapeJob> BatchScrapeAsync(
        List<string> urls,
        BatchScrapeOptions? options = null,
        int pollIntervalSec = DefaultPollIntervalSec,
        int timeoutSec = DefaultJobTimeoutSec,
        CancellationToken cancellationToken = default)
    {
        var start = await StartBatchScrapeAsync(urls, options, cancellationToken);
        return await PollBatchScrapeAsync(
            start.Id ?? throw new FirecrawlException("Batch scrape start did not return a job ID"),
            pollIntervalSec, timeoutSec, cancellationToken);
    }

    /// <summary>
    /// Cancels a running batch scrape job.
    /// </summary>
    public async Task<Dictionary<string, object>> CancelBatchScrapeAsync(
        string jobId,
        CancellationToken cancellationToken = default)
    {
        ArgumentNullException.ThrowIfNull(jobId);

        return await _http.DeleteAsync<Dictionary<string, object>>(
            $"/v2/batch/scrape/{jobId}", cancellationToken);
    }

    // ================================================================
    // PARSE
    // ================================================================

    /// <summary>
    /// Parses an uploaded file (HTML, PDF, DOCX, etc.) via <c>/v2/parse</c>
    /// and returns the extracted document.
    /// </summary>
    /// <param name="file">The file to upload.</param>
    /// <param name="options">Optional parse options. Browser-only formats
    /// (changeTracking, screenshot, branding), actions, waitFor, location,
    /// and mobile are rejected.</param>
    /// <param name="cancellationToken">Cancellation token.</param>
    public async Task<Document> ParseAsync(
        ParseFile file,
        ParseOptions? options = null,
        CancellationToken cancellationToken = default)
    {
        ArgumentNullException.ThrowIfNull(file);

        var filename = file.Filename?.Trim();
        if (string.IsNullOrEmpty(filename))
            throw new ArgumentException("filename cannot be empty", nameof(file));

        if (file.Content is null || file.Content.Length == 0)
            throw new ArgumentException("file content cannot be empty", nameof(file));

        options?.Validate();

        var optionsJson = JsonSerializer.Serialize(
            options ?? new ParseOptions(),
            FirecrawlHttpClient.JsonOptions);

        var fields = new Dictionary<string, string>
        {
            ["options"] = optionsJson,
        };

        var response = await _http.PostMultipartAsync<ApiResponse<Document>>(
            "/v2/parse",
            fields,
            fileField: "file",
            fileName: filename,
            fileContentType: file.ResolveContentType(),
            fileContent: file.Content,
            cancellationToken: cancellationToken);

        return response.Data ?? throw new FirecrawlException("Parse response contained no data");
    }

    // ================================================================
    // MAP
    // ================================================================

    /// <summary>
    /// Discovers URLs on a website.
    /// </summary>
    public async Task<MapData> MapAsync(
        string url,
        MapOptions? options = null,
        CancellationToken cancellationToken = default)
    {
        ArgumentNullException.ThrowIfNull(url);

        var body = BuildBody(options);
        body["url"] = url;

        var response = await _http.PostAsync<ApiResponse<MapData>>(
            "/v2/map", body, cancellationToken: cancellationToken);

        return response.Data ?? throw new FirecrawlException("Map response contained no data");
    }

    // ================================================================
    // MONITOR
    // ================================================================

    public async Task<MonitorModel> CreateMonitorAsync(
        CreateMonitorRequest request,
        CancellationToken cancellationToken = default)
    {
        ArgumentNullException.ThrowIfNull(request);

        var response = await _http.PostAsync<ApiResponse<MonitorModel>>(
            "/v2/monitor", request, cancellationToken: cancellationToken);

        return response.Data ?? throw new FirecrawlException("Create monitor response contained no data");
    }

    public async Task<List<MonitorModel>> ListMonitorsAsync(
        int? limit = null,
        int? offset = null,
        CancellationToken cancellationToken = default)
    {
        var response = await _http.GetAsync<ApiResponse<List<MonitorModel>>>(
            $"/v2/monitor{BuildQuery(limit, offset)}", cancellationToken);

        return response.Data ?? new List<MonitorModel>();
    }

    public async Task<MonitorModel> GetMonitorAsync(
        string monitorId,
        CancellationToken cancellationToken = default)
    {
        ArgumentNullException.ThrowIfNull(monitorId);

        var response = await _http.GetAsync<ApiResponse<MonitorModel>>(
            $"/v2/monitor/{monitorId}", cancellationToken);

        return response.Data ?? throw new FirecrawlException("Get monitor response contained no data");
    }

    public async Task<MonitorModel> UpdateMonitorAsync(
        string monitorId,
        UpdateMonitorRequest request,
        CancellationToken cancellationToken = default)
    {
        ArgumentNullException.ThrowIfNull(monitorId);
        ArgumentNullException.ThrowIfNull(request);

        var response = await _http.PatchAsync<ApiResponse<MonitorModel>>(
            $"/v2/monitor/{monitorId}", request, cancellationToken);

        return response.Data ?? throw new FirecrawlException("Update monitor response contained no data");
    }

    public async Task<bool> DeleteMonitorAsync(
        string monitorId,
        CancellationToken cancellationToken = default)
    {
        ArgumentNullException.ThrowIfNull(monitorId);

        var response = await _http.DeleteAsync<Dictionary<string, object>>(
            $"/v2/monitor/{monitorId}", cancellationToken);

        return response.TryGetValue("success", out var success) && success switch
        {
            bool value => value,
            JsonElement element when element.ValueKind == JsonValueKind.True => true,
            _ => false
        };
    }

    public async Task<MonitorCheck> RunMonitorAsync(
        string monitorId,
        CancellationToken cancellationToken = default)
    {
        ArgumentNullException.ThrowIfNull(monitorId);

        var response = await _http.PostAsync<ApiResponse<MonitorCheck>>(
            $"/v2/monitor/{monitorId}/run", new Dictionary<string, object>(), cancellationToken: cancellationToken);

        return response.Data ?? throw new FirecrawlException("Run monitor response contained no data");
    }

    public async Task<List<MonitorCheck>> ListMonitorChecksAsync(
        string monitorId,
        int? limit = null,
        int? offset = null,
        CancellationToken cancellationToken = default)
    {
        ArgumentNullException.ThrowIfNull(monitorId);

        var response = await _http.GetAsync<ApiResponse<List<MonitorCheck>>>(
            $"/v2/monitor/{monitorId}/checks{BuildQuery(limit, offset)}", cancellationToken);

        return response.Data ?? new List<MonitorCheck>();
    }

    public async Task<MonitorCheckDetail> GetMonitorCheckAsync(
        string monitorId,
        string checkId,
        int? limit = null,
        int? skip = null,
        string? status = null,
        bool autoPaginate = true,
        CancellationToken cancellationToken = default)
    {
        ArgumentNullException.ThrowIfNull(monitorId);
        ArgumentNullException.ThrowIfNull(checkId);

        var response = await _http.GetAsync<ApiResponse<MonitorCheckDetail>>(
            $"/v2/monitor/{monitorId}/checks/{checkId}{BuildMonitorCheckQuery(limit, skip, status)}",
            cancellationToken);

        var check = response.Data ?? throw new FirecrawlException("Get monitor check response contained no data");
        return autoPaginate ? await PaginateMonitorCheckAsync(check, cancellationToken) : check;
    }

    // ================================================================
    // SEARCH
    // ================================================================

    /// <summary>
    /// Performs a web search.
    /// </summary>
    public async Task<SearchData> SearchAsync(
        string query,
        SearchOptions? options = null,
        CancellationToken cancellationToken = default)
    {
        ArgumentNullException.ThrowIfNull(query);

        var body = BuildBody(options);
        body["query"] = query;

        var response = await _http.PostAsync<ApiResponse<SearchData>>(
            "/v2/search", body, cancellationToken: cancellationToken);

        return response.Data ?? throw new FirecrawlException("Search response contained no data");
    }

    // ================================================================
    // USAGE & METRICS
    // ================================================================

    /// <summary>
    /// Gets current concurrency usage.
    /// </summary>
    public async Task<ConcurrencyCheck> GetConcurrencyAsync(
        CancellationToken cancellationToken = default)
    {
        return await _http.GetAsync<ConcurrencyCheck>(
            "/v2/concurrency-check", cancellationToken);
    }

    /// <summary>
    /// Gets current credit usage.
    /// </summary>
    public async Task<CreditUsage> GetCreditUsageAsync(
        CancellationToken cancellationToken = default)
    {
        return await _http.GetAsync<CreditUsage>(
            "/v2/team/credit-usage", cancellationToken);
    }

    // ================================================================
    // INTERNAL POLLING HELPERS
    // ================================================================

    private async Task<CrawlJob> PollCrawlAsync(
        string jobId,
        int pollIntervalSec,
        int timeoutSec,
        CancellationToken cancellationToken)
    {
        var deadline = DateTime.UtcNow.AddSeconds(timeoutSec);

        while (DateTime.UtcNow < deadline)
        {
            cancellationToken.ThrowIfCancellationRequested();

            var job = await GetCrawlStatusAsync(jobId, cancellationToken);
            if (job.IsDone)
                return await PaginateCrawlAsync(job, cancellationToken);

            await Task.Delay(TimeSpan.FromSeconds(pollIntervalSec), cancellationToken);
        }

        throw new JobTimeoutException(jobId, timeoutSec, "Crawl");
    }

    private async Task<BatchScrapeJob> PollBatchScrapeAsync(
        string jobId,
        int pollIntervalSec,
        int timeoutSec,
        CancellationToken cancellationToken)
    {
        var deadline = DateTime.UtcNow.AddSeconds(timeoutSec);

        while (DateTime.UtcNow < deadline)
        {
            cancellationToken.ThrowIfCancellationRequested();

            var job = await GetBatchScrapeStatusAsync(jobId, cancellationToken);
            if (job.IsDone)
                return await PaginateBatchScrapeAsync(job, cancellationToken);

            await Task.Delay(TimeSpan.FromSeconds(pollIntervalSec), cancellationToken);
        }

        throw new JobTimeoutException(jobId, timeoutSec, "Batch scrape");
    }

    private async Task<CrawlJob> PaginateCrawlAsync(
        CrawlJob job,
        CancellationToken cancellationToken)
    {
        job.Data ??= new List<Document>();
        var current = job;

        while (!string.IsNullOrEmpty(current.Next))
        {
            var nextPage = await _http.GetAbsoluteAsync<CrawlJob>(
                current.Next, cancellationToken);

            if (nextPage.Data is { Count: > 0 })
                job.Data.AddRange(nextPage.Data);

            current = nextPage;
        }

        job.Next = null;
        return job;
    }

    private async Task<BatchScrapeJob> PaginateBatchScrapeAsync(
        BatchScrapeJob job,
        CancellationToken cancellationToken)
    {
        job.Data ??= new List<Document>();
        var current = job;

        while (!string.IsNullOrEmpty(current.Next))
        {
            var nextPage = await _http.GetAbsoluteAsync<BatchScrapeJob>(
                current.Next, cancellationToken);

            if (nextPage.Data is { Count: > 0 })
                job.Data.AddRange(nextPage.Data);

            current = nextPage;
        }

        job.Next = null;
        return job;
    }

    private async Task<MonitorCheckDetail> PaginateMonitorCheckAsync(
        MonitorCheckDetail check,
        CancellationToken cancellationToken)
    {
        check.Pages ??= new List<MonitorCheckPage>();
        var current = check;

        while (!string.IsNullOrEmpty(current.Next))
        {
            var response = await _http.GetAbsoluteAsync<ApiResponse<MonitorCheckDetail>>(
                current.Next, cancellationToken);
            if (response.Data == null)
                break;

            var nextPage = response.Data;

            if (nextPage.Pages is { Count: > 0 })
                check.Pages.AddRange(nextPage.Pages);

            current = nextPage;
        }

        check.Next = null;
        return check;
    }

    // ================================================================
    // INTERNAL UTILITIES
    // ================================================================

    private static Dictionary<string, object> BuildBody(object? options)
    {
        if (options == null)
            return new Dictionary<string, object>();

        var json = JsonSerializer.Serialize(options, FirecrawlHttpClient.JsonOptions);
        return JsonSerializer.Deserialize<Dictionary<string, object>>(json, FirecrawlHttpClient.JsonOptions)
            ?? new Dictionary<string, object>();
    }

    private static string BuildQuery(int? limit = null, int? offset = null, string? status = null)
    {
        var query = new List<string>();
        if (limit.HasValue)
            query.Add($"limit={Uri.EscapeDataString(limit.Value.ToString())}");
        if (offset.HasValue)
            query.Add($"offset={Uri.EscapeDataString(offset.Value.ToString())}");
        if (!string.IsNullOrWhiteSpace(status))
            query.Add($"status={Uri.EscapeDataString(status)}");

        return query.Count == 0 ? string.Empty : "?" + string.Join("&", query);
    }

    private static string BuildMonitorCheckQuery(int? limit = null, int? skip = null, string? status = null)
    {
        var query = new List<string>();
        if (limit.HasValue)
            query.Add($"limit={Uri.EscapeDataString(limit.Value.ToString())}");
        if (skip.HasValue)
            query.Add($"skip={Uri.EscapeDataString(skip.Value.ToString())}");
        if (!string.IsNullOrWhiteSpace(status))
            query.Add($"status={Uri.EscapeDataString(status)}");

        return query.Count == 0 ? string.Empty : "?" + string.Join("&", query);
    }

    private static string ResolveApiKey(string? apiKey)
    {
        if (!string.IsNullOrWhiteSpace(apiKey))
            return apiKey;

        var envKey = Environment.GetEnvironmentVariable("FIRECRAWL_API_KEY");
        if (!string.IsNullOrWhiteSpace(envKey))
            return envKey;

        throw new FirecrawlException(
            "API key is required. Pass it to the constructor or set the FIRECRAWL_API_KEY environment variable.");
    }

    private static string ResolveApiUrl(string? apiUrl)
    {
        if (!string.IsNullOrWhiteSpace(apiUrl))
            return apiUrl;

        var envUrl = Environment.GetEnvironmentVariable("FIRECRAWL_API_URL");
        if (!string.IsNullOrWhiteSpace(envUrl))
            return envUrl;

        return DefaultApiUrl;
    }
}
