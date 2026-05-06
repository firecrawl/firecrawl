package com.firecrawl.client;

import com.fasterxml.jackson.core.JsonProcessingException;
import com.firecrawl.errors.FirecrawlException;
import com.firecrawl.errors.JobTimeoutException;
import com.firecrawl.models.*;

import okhttp3.OkHttpClient;

import java.util.*;
import java.util.concurrent.CompletableFuture;
import java.util.concurrent.Executor;
import java.util.concurrent.ForkJoinPool;

/**
 * Client for the Firecrawl v2 API.
 *
 * <p>Example usage:
 * <pre>{@code
 * FirecrawlClient client = FirecrawlClient.builder()
 *     .apiKey("fc-your-api-key")
 *     .build();
 *
 * // Scrape a single page
 * Document doc = client.scrape("https://example.com",
 *     ScrapeOptions.builder()
 *         .formats(List.of("markdown"))
 *         .build());
 *
 * // Crawl a website
 * CrawlJob job = client.crawl("https://example.com",
 *     CrawlOptions.builder()
 *         .limit(50)
 *         .build());
 * }</pre>
 */
public class FirecrawlClient {

    private static final String DEFAULT_API_URL = "https://api.firecrawl.dev";
    private static final long DEFAULT_TIMEOUT_MS = 300_000; // 5 minutes
    private static final int DEFAULT_MAX_RETRIES = 3;
    private static final double DEFAULT_BACKOFF_FACTOR = 0.5;
    private static final int DEFAULT_POLL_INTERVAL = 2; // seconds
    private static final int DEFAULT_JOB_TIMEOUT = 300; // seconds

    private final FirecrawlHttpClient http;
    private final Executor asyncExecutor;

    private FirecrawlClient(FirecrawlHttpClient http, Executor asyncExecutor) {
        this.http = http;
        this.asyncExecutor = asyncExecutor;
    }

    /**
     * Creates a new builder for constructing a FirecrawlClient.
     */
    public static Builder builder() {
        return new Builder();
    }

    /**
     * Creates a client from the FIRECRAWL_API_KEY environment variable.
     */
    public static FirecrawlClient fromEnv() {
        String apiKey = System.getenv("FIRECRAWL_API_KEY");
        if (apiKey == null || apiKey.isBlank()) {
            String sysProp = System.getProperty("firecrawl.apiKey");
            if (sysProp == null || sysProp.isBlank()) {
                throw new FirecrawlException("FIRECRAWL_API_KEY environment variable or firecrawl.apiKey system property is required");
            }
            apiKey = sysProp;
        }
        return builder().apiKey(apiKey).build();
    }

    // ================================================================
    // SCRAPE
    // ================================================================

    /**
     * Scrapes a single URL and returns the document.
     *
     * @param url the URL to scrape
     * @return the scraped document
     */
    public Document scrape(String url) {
        return scrape(url, null);
    }

    /**
     * Scrapes a single URL with options.
     *
     * @param url     the URL to scrape
     * @param options scrape configuration options
     * @return the scraped document
     */
    public Document scrape(String url, ScrapeOptions options) {
        Objects.requireNonNull(url, "URL is required");
        Map<String, Object> body = new LinkedHashMap<>();
        body.put("url", url);
        if (options != null) {
            mergeOptions(body, options);
        }
        return extractData(http.post("/v2/scrape", body, Map.class), Document.class);
    }

    /**
     * Interacts with the scrape-bound browser session for a scrape job.
     *
     * @param jobId the scrape job ID
     * @param code  the code to execute
     * @return the execution result including stdout, stderr, and exit code
     */
    public BrowserExecuteResponse interact(String jobId, String code) {
        return interact(jobId, code, "node", null, null);
    }

    /**
     * Interacts with the scrape-bound browser session for a scrape job.
     *
     * @param jobId    the scrape job ID
     * @param code     the code to execute
     * @param language the language: "python", "node", or "bash" (default: "node")
     * @param timeout  execution timeout in seconds (1-300), or null for default (30)
     * @return the execution result including stdout, stderr, and exit code
     */
    public BrowserExecuteResponse interact(String jobId, String code,
                                           String language, Integer timeout) {
        return interact(jobId, code, language, timeout, null);
    }

    /**
     * Interacts with the scrape-bound browser session for a scrape job.
     *
     * @param jobId    the scrape job ID
     * @param code     the code to execute
     * @param language the language: "python", "node", or "bash" (default: "node")
     * @param timeout  execution timeout in seconds (1-300), or null for default (30)
     * @param origin   optional origin tag for request attribution
     * @return the execution result including stdout, stderr, and exit code
     */
    public BrowserExecuteResponse interact(String jobId, String code,
                                           String language, Integer timeout, String origin) {
        Objects.requireNonNull(jobId, "Job ID is required");
        Objects.requireNonNull(code, "Code is required");
        Map<String, Object> body = new LinkedHashMap<>();
        body.put("code", code);
        body.put("language", language != null ? language : "node");
        if (timeout != null) body.put("timeout", timeout);
        if (origin != null) body.put("origin", origin);
        return http.post("/v2/scrape/" + jobId + "/interact", body, BrowserExecuteResponse.class);
    }

    /**
     * Stops the interactive browser session for a scrape job.
     *
     * @param jobId the scrape job ID
     * @return the stop response with session duration and billing info
     */
    public BrowserDeleteResponse stopInteractiveBrowser(String jobId) {
        Objects.requireNonNull(jobId, "Job ID is required");
        return http.delete("/v2/scrape/" + jobId + "/interact", BrowserDeleteResponse.class);
    }

    /**
     * @deprecated Use {@link #interact(String, String)}.
     */
    @Deprecated
    public BrowserExecuteResponse scrapeExecute(String jobId, String code) {
        return interact(jobId, code);
    }

    /**
     * @deprecated Use {@link #interact(String, String, String, Integer)}.
     */
    @Deprecated
    public BrowserExecuteResponse scrapeExecute(String jobId, String code,
                                                String language, Integer timeout) {
        return interact(jobId, code, language, timeout);
    }

    /**
     * @deprecated Use {@link #interact(String, String, String, Integer, String)}.
     */
    @Deprecated
    public BrowserExecuteResponse scrapeExecute(String jobId, String code,
                                                String language, Integer timeout, String origin) {
        return interact(jobId, code, language, timeout, origin);
    }

    /**
     * @deprecated Use {@link #stopInteractiveBrowser(String)}.
     */
    @Deprecated
    public BrowserDeleteResponse deleteScrapeBrowser(String jobId) {
        return stopInteractiveBrowser(jobId);
    }

    /**
     * Parses an uploaded file and returns the extracted document.
     *
     * @param file the file payload to parse
     * @return the parsed document
     */
    public Document parse(ParseFile file) {
        return parse(file, null);
    }

    /**
     * Parses an uploaded file with scrape-compatible options.
     *
     * @param file the file payload to parse
     * @param options parse options (parse-compatible subset)
     * @return the parsed document
     */
    @SuppressWarnings("unchecked")
    public Document parse(ParseFile file, ParseOptions options) {
        Objects.requireNonNull(file, "Parse file is required");

        Map<String, Object> optionsMap = new LinkedHashMap<>();
        if (options != null) {
            mergeOptions(optionsMap, options);
        }

        String optionsJson;
        try {
            optionsJson = http.objectMapper.writeValueAsString(optionsMap);
        } catch (JsonProcessingException e) {
            throw new FirecrawlException("Failed to serialize parse options", e);
        }

        Map<String, String> fields = new LinkedHashMap<>();
        fields.put("options", optionsJson);

        return extractData(
                http.postMultipart(
                        "/v2/parse",
                        fields,
                        "file",
                        file.getContent(),
                        file.getFilename(),
                        file.getContentType(),
                        Map.class
                ),
                Document.class
        );
    }

    // ================================================================
    // CRAWL
    // ================================================================

    /**
     * Starts an async crawl job and returns immediately.
     *
     * @param url     the URL to start crawling from
     * @param options crawl configuration options
     * @return the crawl job reference with ID
     */
    public CrawlResponse startCrawl(String url, CrawlOptions options) {
        Objects.requireNonNull(url, "URL is required");
        Map<String, Object> body = new LinkedHashMap<>();
        body.put("url", url);
        if (options != null) {
            mergeOptions(body, options);
        }
        return http.post("/v2/crawl", body, CrawlResponse.class);
    }

    /**
     * Gets the status and results of a crawl job.
     *
     * @param jobId the crawl job ID
     * @return the crawl job status
     */
    public CrawlJob getCrawlStatus(String jobId) {
        Objects.requireNonNull(jobId, "Job ID is required");
        return http.get("/v2/crawl/" + jobId, CrawlJob.class);
    }

    /**
     * Crawls a website and waits for completion (auto-polling).
     *
     * @param url     the URL to crawl
     * @param options crawl configuration options
     * @return the completed crawl job with all documents
     */
    public CrawlJob crawl(String url, CrawlOptions options) {
        return crawl(url, options, DEFAULT_POLL_INTERVAL, DEFAULT_JOB_TIMEOUT);
    }

    /**
     * Crawls a website and waits for completion with custom polling settings.
     *
     * @param url            the URL to crawl
     * @param options        crawl configuration options
     * @param pollIntervalSec seconds between status checks
     * @param timeoutSec     maximum seconds to wait
     * @return the completed crawl job with all documents
     */
    public CrawlJob crawl(String url, CrawlOptions options, int pollIntervalSec, int timeoutSec) {
        CrawlResponse start = startCrawl(url, options);
        return pollCrawl(start.getId(), pollIntervalSec, timeoutSec);
    }

    /**
     * Cancels a running crawl job.
     *
     * @param jobId the crawl job ID
     * @return the cancellation response
     */
    @SuppressWarnings("unchecked")
    public Map<String, Object> cancelCrawl(String jobId) {
        Objects.requireNonNull(jobId, "Job ID is required");
        return http.delete("/v2/crawl/" + jobId, Map.class);
    }

    /**
     * Gets errors from a crawl job.
     *
     * @param jobId the crawl job ID
     * @return error details
     */
    @SuppressWarnings("unchecked")
    public Map<String, Object> getCrawlErrors(String jobId) {
        Objects.requireNonNull(jobId, "Job ID is required");
        return http.get("/v2/crawl/" + jobId + "/errors", Map.class);
    }

    // ================================================================
    // BATCH SCRAPE
    // ================================================================

    /**
     * Starts an async batch scrape job.
     *
     * @param urls    the URLs to scrape
     * @param options batch scrape configuration options
     * @return the batch job reference with ID
     */
    @SuppressWarnings("unchecked")
    public BatchScrapeResponse startBatchScrape(List<String> urls, BatchScrapeOptions options) {
        Objects.requireNonNull(urls, "URLs list is required");
        Map<String, Object> body = new LinkedHashMap<>();
        body.put("urls", urls);
        Map<String, String> extraHeaders = Collections.emptyMap();
        if (options != null) {
            // Extract idempotencyKey before serialization — it must be sent as an
            // HTTP header (x-idempotency-key), not in the JSON body.
            String idempotencyKey = options.getIdempotencyKey();
            if (idempotencyKey != null && !idempotencyKey.isEmpty()) {
                extraHeaders = Collections.singletonMap("x-idempotency-key", idempotencyKey);
            }

            mergeOptions(body, options);
            // The API expects scrape options flattened at the top level, not nested
            // under an "options" key. Extract and flatten them, but preserve
            // batch-level fields so they are not overwritten by scrape options.
            Map<String, Object> nested = (Map<String, Object>) body.remove("options");
            if (nested != null) {
                Map<String, Object> batchFields = new LinkedHashMap<>(body);
                body.putAll(nested);
                body.putAll(batchFields);
            }
        }
        return http.post("/v2/batch/scrape", body, BatchScrapeResponse.class, extraHeaders);
    }

    /**
     * Gets the status and results of a batch scrape job.
     *
     * @param jobId the batch scrape job ID
     * @return the batch scrape job status
     */
    public BatchScrapeJob getBatchScrapeStatus(String jobId) {
        Objects.requireNonNull(jobId, "Job ID is required");
        return http.get("/v2/batch/scrape/" + jobId, BatchScrapeJob.class);
    }

    /**
     * Batch-scrapes URLs and waits for completion (auto-polling).
     *
     * @param urls    the URLs to scrape
     * @param options batch scrape configuration options
     * @return the completed batch scrape job with all documents
     */
    public BatchScrapeJob batchScrape(List<String> urls, BatchScrapeOptions options) {
        return batchScrape(urls, options, DEFAULT_POLL_INTERVAL, DEFAULT_JOB_TIMEOUT);
    }

    /**
     * Batch-scrapes URLs and waits for completion with custom polling settings.
     *
     * @param urls           the URLs to scrape
     * @param options        batch scrape configuration options
     * @param pollIntervalSec seconds between status checks
     * @param timeoutSec     maximum seconds to wait
     * @return the completed batch scrape job with all documents
     */
    public BatchScrapeJob batchScrape(List<String> urls, BatchScrapeOptions options,
                                       int pollIntervalSec, int timeoutSec) {
        BatchScrapeResponse start = startBatchScrape(urls, options);
        return pollBatchScrape(start.getId(), pollIntervalSec, timeoutSec);
    }

    /**
     * Cancels a running batch scrape job.
     *
     * @param jobId the batch scrape job ID
     * @return the cancellation response
     */
    @SuppressWarnings("unchecked")
    public Map<String, Object> cancelBatchScrape(String jobId) {
        Objects.requireNonNull(jobId, "Job ID is required");
        return http.delete("/v2/batch/scrape/" + jobId, Map.class);
    }

    // ================================================================
    // MAP
    // ================================================================

    /**
     * Discovers URLs on a website.
     *
     * @param url the URL to map
     * @return the discovered URLs
     */
    public MapData map(String url) {
        return map(url, null);
    }

    /**
     * Discovers URLs on a website with options.
     *
     * @param url     the URL to map
     * @param options map configuration options
     * @return the discovered URLs
     */
    public MapData map(String url, MapOptions options) {
        Objects.requireNonNull(url, "URL is required");
        Map<String, Object> body = new LinkedHashMap<>();
        body.put("url", url);
        if (options != null) {
            mergeOptions(body, options);
        }
        return extractData(http.post("/v2/map", body, Map.class), MapData.class);
    }

    // ================================================================
    // MONITOR
    // ================================================================

    public Monitor createMonitor(Map<String, Object> request) {
        Objects.requireNonNull(request, "Monitor request is required");
        return extractData(http.post("/v2/monitor", request, Map.class), Monitor.class);
    }

    public List<Monitor> listMonitors() {
        return listMonitors(null, null);
    }

    public List<Monitor> listMonitors(Integer limit, Integer offset) {
        Map raw = http.get("/v2/monitor" + listQuery(limit, offset), Map.class);
        return extractDataList(raw, Monitor.class);
    }

    public Monitor getMonitor(String monitorId) {
        Objects.requireNonNull(monitorId, "Monitor ID is required");
        return extractData(http.get("/v2/monitor/" + monitorId, Map.class), Monitor.class);
    }

    public Monitor updateMonitor(String monitorId, Map<String, Object> request) {
        Objects.requireNonNull(monitorId, "Monitor ID is required");
        Objects.requireNonNull(request, "Monitor update request is required");
        return extractData(http.patch("/v2/monitor/" + monitorId, request, Map.class), Monitor.class);
    }

    @SuppressWarnings("unchecked")
    public boolean deleteMonitor(String monitorId) {
        Objects.requireNonNull(monitorId, "Monitor ID is required");
        Map<String, Object> response = http.delete("/v2/monitor/" + monitorId, Map.class);
        return Boolean.TRUE.equals(response.get("success"));
    }

    public MonitorCheck runMonitor(String monitorId) {
        Objects.requireNonNull(monitorId, "Monitor ID is required");
        return extractData(
                http.post("/v2/monitor/" + monitorId + "/run", Collections.emptyMap(), Map.class),
                MonitorCheck.class
        );
    }

    public List<MonitorCheck> listMonitorChecks(String monitorId) {
        return listMonitorChecks(monitorId, null, null);
    }

    public List<MonitorCheck> listMonitorChecks(String monitorId, Integer limit, Integer offset) {
        Objects.requireNonNull(monitorId, "Monitor ID is required");
        Map raw = http.get("/v2/monitor/" + monitorId + "/checks" + listQuery(limit, offset), Map.class);
        return extractDataList(raw, MonitorCheck.class);
    }

    public MonitorCheckDetail getMonitorCheck(String monitorId, String checkId) {
        return getMonitorCheck(monitorId, checkId, null, null, null, true);
    }

    public MonitorCheckDetail getMonitorCheck(
            String monitorId, String checkId, Integer limit, Integer skip, String status) {
        return getMonitorCheck(monitorId, checkId, limit, skip, status, true);
    }

    public MonitorCheckDetail getMonitorCheck(
            String monitorId, String checkId, Integer limit, Integer skip, String status, boolean autoPaginate) {
        Objects.requireNonNull(monitorId, "Monitor ID is required");
        Objects.requireNonNull(checkId, "Check ID is required");
        MonitorCheckDetail check = extractData(
                http.get("/v2/monitor/" + monitorId + "/checks/" + checkId
                        + monitorCheckQuery(limit, skip, status), Map.class),
                MonitorCheckDetail.class
        );
        return autoPaginate ? paginateMonitorCheck(check) : check;
    }

    // ================================================================
    // SEARCH
    // ================================================================

    /**
     * Performs a web search.
     *
     * @param query the search query
     * @return search results
     */
    public SearchData search(String query) {
        return search(query, null);
    }

    /**
     * Performs a web search with options.
     *
     * @param query   the search query
     * @param options search configuration options
     * @return search results
     */
    public SearchData search(String query, SearchOptions options) {
        Objects.requireNonNull(query, "Query is required");
        Map<String, Object> body = new LinkedHashMap<>();
        body.put("query", query);
        if (options != null) {
            mergeOptions(body, options);
        }
        return extractData(http.post("/v2/search", body, Map.class), SearchData.class);
    }

    // ================================================================
    // AGENT
    // ================================================================

    /**
     * Starts an async agent task.
     *
     * @param options agent configuration options
     * @return the agent response with job ID
     */
    public AgentResponse startAgent(AgentOptions options) {
        Objects.requireNonNull(options, "Agent options are required");
        return http.post("/v2/agent", options, AgentResponse.class);
    }

    /**
     * Gets the status of an agent task.
     *
     * @param jobId the agent job ID
     * @return the agent status response
     */
    public AgentStatusResponse getAgentStatus(String jobId) {
        Objects.requireNonNull(jobId, "Job ID is required");
        return http.get("/v2/agent/" + jobId, AgentStatusResponse.class);
    }

    /**
     * Runs an agent task and waits for completion (auto-polling).
     *
     * @param options agent configuration options
     * @return the completed agent status response
     */
    public AgentStatusResponse agent(AgentOptions options) {
        return agent(options, DEFAULT_POLL_INTERVAL, DEFAULT_JOB_TIMEOUT);
    }

    /**
     * Runs an agent task and waits for completion with custom polling settings.
     *
     * @param options         agent configuration options
     * @param pollIntervalSec seconds between status checks
     * @param timeoutSec      maximum seconds to wait
     * @return the completed agent status response
     */
    public AgentStatusResponse agent(AgentOptions options, int pollIntervalSec, int timeoutSec) {
        AgentResponse start = startAgent(options);
        if (start.getId() == null) {
            throw new FirecrawlException("Agent start did not return a job ID");
        }
        long deadline = System.currentTimeMillis() + (timeoutSec * 1000L);
        while (System.currentTimeMillis() < deadline) {
            AgentStatusResponse status = getAgentStatus(start.getId());
            if (status.isDone()) {
                return status;
            }
            sleep(pollIntervalSec);
        }
        throw new JobTimeoutException(start.getId(), timeoutSec, "Agent");
    }

    /**
     * Cancels a running agent task.
     *
     * @param jobId the agent job ID
     * @return the cancellation response
     */
    @SuppressWarnings("unchecked")
    public Map<String, Object> cancelAgent(String jobId) {
        Objects.requireNonNull(jobId, "Job ID is required");
        return http.delete("/v2/agent/" + jobId, Map.class);
    }

    // ================================================================
    // BROWSER
    // ================================================================

    /**
     * Creates a new browser session with default settings.
     *
     * @return the browser session details including id, CDP URL, and live view URL
     */
    public BrowserCreateResponse browser() {
        return browser(null, null, null);
    }

    /**
     * Creates a new browser session with options.
     *
     * @param ttl            total session lifetime in seconds (30-3600), or null for default
     * @param activityTtl    idle timeout in seconds (10-3600), or null for default
     * @param streamWebView  whether to enable live view streaming, or null for default
     * @return the browser session details
     */
    public BrowserCreateResponse browser(Integer ttl, Integer activityTtl, Boolean streamWebView) {
        Map<String, Object> body = new LinkedHashMap<>();
        if (ttl != null) body.put("ttl", ttl);
        if (activityTtl != null) body.put("activityTtl", activityTtl);
        if (streamWebView != null) body.put("streamWebView", streamWebView);
        return http.post("/v2/browser", body, BrowserCreateResponse.class);
    }

    /**
     * Executes code in a browser session using the default language (bash).
     *
     * @param sessionId the browser session ID
     * @param code      the code to execute
     * @return the execution result including stdout, stderr, and exit code
     */
    public BrowserExecuteResponse browserExecute(String sessionId, String code) {
        return browserExecute(sessionId, code, "bash", null);
    }

    /**
     * Executes code in a browser session with options.
     *
     * @param sessionId the browser session ID
     * @param code      the code to execute
     * @param language  the language: "python", "node", or "bash" (default: "bash")
     * @param timeout   execution timeout in seconds (1-300), or null for default (30)
     * @return the execution result including stdout, stderr, and exit code
     */
    public BrowserExecuteResponse browserExecute(String sessionId, String code,
                                                   String language, Integer timeout) {
        Objects.requireNonNull(sessionId, "Session ID is required");
        Objects.requireNonNull(code, "Code is required");
        Map<String, Object> body = new LinkedHashMap<>();
        body.put("code", code);
        body.put("language", language != null ? language : "bash");
        if (timeout != null) body.put("timeout", timeout);
        return http.post("/v2/browser/" + sessionId + "/execute", body, BrowserExecuteResponse.class);
    }

    /**
     * Deletes a browser session.
     *
     * @param sessionId the browser session ID
     * @return the deletion response with session duration and billing info
     */
    public BrowserDeleteResponse deleteBrowser(String sessionId) {
        Objects.requireNonNull(sessionId, "Session ID is required");
        return http.delete("/v2/browser/" + sessionId, BrowserDeleteResponse.class);
    }

    /**
     * Lists all browser sessions.
     *
     * @return the list of browser sessions
     */
    public BrowserListResponse listBrowsers() {
        return listBrowsers(null);
    }

    /**
     * Lists browser sessions with optional status filter.
     *
     * @param status optional filter: "active" or "destroyed", or null for all
     * @return the list of browser sessions
     */
    public BrowserListResponse listBrowsers(String status) {
        String endpoint = "/v2/browser";
        if (status != null && !status.isEmpty()) {
            endpoint += "?status=" + status;
        }
        return http.get(endpoint, BrowserListResponse.class);
    }

    // ================================================================
    // USAGE & METRICS
    // ================================================================

    /**
     * Gets current concurrency usage.
     */
    public ConcurrencyCheck getConcurrency() {
        return http.get("/v2/concurrency-check", ConcurrencyCheck.class);
    }

    /**
     * Gets current credit usage.
     */
    public CreditUsage getCreditUsage() {
        return http.get("/v2/team/credit-usage", CreditUsage.class);
    }

    // ================================================================
    // ASYNC CONVENIENCE METHODS
    // ================================================================

    /**
     * Asynchronously scrapes a URL.
     *
     * @param url     the URL to scrape
     * @param options scrape configuration options
     * @return a CompletableFuture that resolves to the scraped Document
     */
    public CompletableFuture<Document> scrapeAsync(String url, ScrapeOptions options) {
        return CompletableFuture.supplyAsync(() -> scrape(url, options), asyncExecutor);
    }

    /**
     * Asynchronously executes code in a scrape-bound browser session.
     *
     * @param jobId the scrape job ID
     * @param code  the code to execute
     * @return a CompletableFuture that resolves to the BrowserExecuteResponse
     */
    public CompletableFuture<BrowserExecuteResponse> interactAsync(String jobId, String code) {
        return CompletableFuture.supplyAsync(() -> interact(jobId, code), asyncExecutor);
    }

    /**
     * Asynchronously executes code in a scrape-bound browser session.
     *
     * @param jobId    the scrape job ID
     * @param code     the code to execute
     * @param language the language: "python", "node", or "bash"
     * @param timeout  execution timeout in seconds, or null for default
     * @return a CompletableFuture that resolves to the BrowserExecuteResponse
     */
    public CompletableFuture<BrowserExecuteResponse> interactAsync(String jobId, String code,
                                                                   String language, Integer timeout) {
        return CompletableFuture.supplyAsync(
                () -> interact(jobId, code, language, timeout),
                asyncExecutor
        );
    }

    /**
     * Asynchronously executes code in a scrape-bound browser session.
     *
     * @param jobId    the scrape job ID
     * @param code     the code to execute
     * @param language the language: "python", "node", or "bash"
     * @param timeout  execution timeout in seconds, or null for default
     * @param origin   optional origin tag for request attribution
     * @return a CompletableFuture that resolves to the BrowserExecuteResponse
     */
    public CompletableFuture<BrowserExecuteResponse> interactAsync(String jobId, String code,
                                                                   String language, Integer timeout, String origin) {
        return CompletableFuture.supplyAsync(
                () -> interact(jobId, code, language, timeout, origin),
                asyncExecutor
        );
    }

    /**
     * Asynchronously deletes a scrape-bound browser session.
     *
     * @param jobId the scrape job ID
     * @return a CompletableFuture that resolves to the BrowserDeleteResponse
     */
    public CompletableFuture<BrowserDeleteResponse> stopInteractiveBrowserAsync(String jobId) {
        return CompletableFuture.supplyAsync(() -> stopInteractiveBrowser(jobId), asyncExecutor);
    }

    /**
     * @deprecated Use {@link #interactAsync(String, String)}.
     */
    @Deprecated
    public CompletableFuture<BrowserExecuteResponse> scrapeExecuteAsync(String jobId, String code) {
        return interactAsync(jobId, code);
    }

    /**
     * @deprecated Use {@link #interactAsync(String, String, String, Integer)}.
     */
    @Deprecated
    public CompletableFuture<BrowserExecuteResponse> scrapeExecuteAsync(String jobId, String code,
                                                                        String language, Integer timeout) {
        return interactAsync(jobId, code, language, timeout);
    }

    /**
     * @deprecated Use {@link #interactAsync(String, String, String, Integer, String)}.
     */
    @Deprecated
    public CompletableFuture<BrowserExecuteResponse> scrapeExecuteAsync(String jobId, String code,
                                                                        String language, Integer timeout, String origin) {
        return interactAsync(jobId, code, language, timeout, origin);
    }

    /**
     * @deprecated Use {@link #stopInteractiveBrowserAsync(String)}.
     */
    @Deprecated
    public CompletableFuture<BrowserDeleteResponse> deleteScrapeBrowserAsync(String jobId) {
        return stopInteractiveBrowserAsync(jobId);
    }

    /**
     * Asynchronously parses an uploaded file with default options.
     *
     * @param file the file payload
     * @return a CompletableFuture that resolves to the parsed Document
     */
    public CompletableFuture<Document> parseAsync(ParseFile file) {
        return parseAsync(file, null);
    }

    /**
     * Asynchronously parses an uploaded file.
     *
     * @param file the file payload
     * @param options parse options
     * @return a CompletableFuture that resolves to the parsed Document
     */
    public CompletableFuture<Document> parseAsync(ParseFile file, ParseOptions options) {
        return CompletableFuture.supplyAsync(() -> parse(file, options), asyncExecutor);
    }

    /**
     * Asynchronously crawls a website and waits for completion.
     *
     * @param url     the URL to crawl
     * @param options crawl configuration options
     * @return a CompletableFuture that resolves to the completed CrawlJob
     */
    public CompletableFuture<CrawlJob> crawlAsync(String url, CrawlOptions options) {
        return CompletableFuture.supplyAsync(() -> crawl(url, options), asyncExecutor);
    }

    /**
     * Asynchronously crawls with custom polling settings.
     *
     * @param url            the URL to crawl
     * @param options        crawl configuration options
     * @param pollIntervalSec seconds between status checks
     * @param timeoutSec     maximum seconds to wait
     * @return a CompletableFuture that resolves to the completed CrawlJob
     */
    public CompletableFuture<CrawlJob> crawlAsync(String url, CrawlOptions options,
                                                    int pollIntervalSec, int timeoutSec) {
        return CompletableFuture.supplyAsync(() -> crawl(url, options, pollIntervalSec, timeoutSec), asyncExecutor);
    }

    /**
     * Asynchronously batch-scrapes URLs and waits for completion.
     *
     * @param urls    the URLs to scrape
     * @param options batch scrape configuration options
     * @return a CompletableFuture that resolves to the completed BatchScrapeJob
     */
    public CompletableFuture<BatchScrapeJob> batchScrapeAsync(List<String> urls, BatchScrapeOptions options) {
        return CompletableFuture.supplyAsync(() -> batchScrape(urls, options), asyncExecutor);
    }

    /**
     * Asynchronously runs a search.
     *
     * @param query   the search query
     * @param options search configuration options
     * @return a CompletableFuture that resolves to the SearchData
     */
    public CompletableFuture<SearchData> searchAsync(String query, SearchOptions options) {
        return CompletableFuture.supplyAsync(() -> search(query, options), asyncExecutor);
    }

    /**
     * Asynchronously runs a map operation.
     *
     * @param url     the URL to map
     * @param options map configuration options
     * @return a CompletableFuture that resolves to the MapData
     */
    public CompletableFuture<MapData> mapAsync(String url, MapOptions options) {
        return CompletableFuture.supplyAsync(() -> map(url, options), asyncExecutor);
    }

    public CompletableFuture<Monitor> createMonitorAsync(Map<String, Object> request) {
        return CompletableFuture.supplyAsync(() -> createMonitor(request), asyncExecutor);
    }

    public CompletableFuture<List<Monitor>> listMonitorsAsync(Integer limit, Integer offset) {
        return CompletableFuture.supplyAsync(() -> listMonitors(limit, offset), asyncExecutor);
    }

    public CompletableFuture<Monitor> getMonitorAsync(String monitorId) {
        return CompletableFuture.supplyAsync(() -> getMonitor(monitorId), asyncExecutor);
    }

    public CompletableFuture<Monitor> updateMonitorAsync(String monitorId, Map<String, Object> request) {
        return CompletableFuture.supplyAsync(() -> updateMonitor(monitorId, request), asyncExecutor);
    }

    public CompletableFuture<Boolean> deleteMonitorAsync(String monitorId) {
        return CompletableFuture.supplyAsync(() -> deleteMonitor(monitorId), asyncExecutor);
    }

    public CompletableFuture<MonitorCheck> runMonitorAsync(String monitorId) {
        return CompletableFuture.supplyAsync(() -> runMonitor(monitorId), asyncExecutor);
    }

    public CompletableFuture<List<MonitorCheck>> listMonitorChecksAsync(String monitorId, Integer limit, Integer offset) {
        return CompletableFuture.supplyAsync(() -> listMonitorChecks(monitorId, limit, offset), asyncExecutor);
    }

    public CompletableFuture<MonitorCheckDetail> getMonitorCheckAsync(
            String monitorId, String checkId, Integer limit, Integer skip, String status) {
        return CompletableFuture.supplyAsync(
                () -> getMonitorCheck(monitorId, checkId, limit, skip, status),
                asyncExecutor
        );
    }

    public CompletableFuture<MonitorCheckDetail> getMonitorCheckAsync(
            String monitorId, String checkId, Integer limit, Integer skip, String status, boolean autoPaginate) {
        return CompletableFuture.supplyAsync(
                () -> getMonitorCheck(monitorId, checkId, limit, skip, status, autoPaginate),
                asyncExecutor
        );
    }

    /**
     * Asynchronously runs an agent task and waits for completion.
     *
     * @param options agent configuration options
     * @return a CompletableFuture that resolves to the AgentStatusResponse
     */
    public CompletableFuture<AgentStatusResponse> agentAsync(AgentOptions options) {
        return CompletableFuture.supplyAsync(() -> agent(options), asyncExecutor);
    }

    /**
     * Asynchronously creates a new browser session.
     *
     * @param ttl            total session lifetime in seconds, or null for default
     * @param activityTtl    idle timeout in seconds, or null for default
     * @param streamWebView  whether to enable live view streaming, or null for default
     * @return a CompletableFuture that resolves to the BrowserCreateResponse
     */
    public CompletableFuture<BrowserCreateResponse> browserAsync(Integer ttl, Integer activityTtl,
                                                                    Boolean streamWebView) {
        return CompletableFuture.supplyAsync(() -> browser(ttl, activityTtl, streamWebView), asyncExecutor);
    }

    /**
     * Asynchronously executes code in a browser session.
     *
     * @param sessionId the browser session ID
     * @param code      the code to execute
     * @param language  the language: "python", "node", or "bash"
     * @param timeout   execution timeout in seconds, or null for default
     * @return a CompletableFuture that resolves to the BrowserExecuteResponse
     */
    public CompletableFuture<BrowserExecuteResponse> browserExecuteAsync(String sessionId, String code,
                                                                           String language, Integer timeout) {
        return CompletableFuture.supplyAsync(() -> browserExecute(sessionId, code, language, timeout), asyncExecutor);
    }

    /**
     * Asynchronously deletes a browser session.
     *
     * @param sessionId the browser session ID
     * @return a CompletableFuture that resolves to the BrowserDeleteResponse
     */
    public CompletableFuture<BrowserDeleteResponse> deleteBrowserAsync(String sessionId) {
        return CompletableFuture.supplyAsync(() -> deleteBrowser(sessionId), asyncExecutor);
    }

    /**
     * Asynchronously lists browser sessions.
     *
     * @param status optional filter: "active" or "destroyed", or null for all
     * @return a CompletableFuture that resolves to the BrowserListResponse
     */
    public CompletableFuture<BrowserListResponse> listBrowsersAsync(String status) {
        return CompletableFuture.supplyAsync(() -> listBrowsers(status), asyncExecutor);
    }

    /**
     * Asynchronously starts a crawl job and returns immediately with the job reference.
     *
     * @param url     the URL to start crawling from
     * @param options crawl configuration options
     * @return a CompletableFuture that resolves to the CrawlResponse
     */
    public CompletableFuture<CrawlResponse> startCrawlAsync(String url, CrawlOptions options) {
        return CompletableFuture.supplyAsync(() -> startCrawl(url, options), asyncExecutor);
    }

    /**
     * Asynchronously gets the status of a crawl job.
     *
     * @param jobId the crawl job ID
     * @return a CompletableFuture that resolves to the CrawlJob
     */
    public CompletableFuture<CrawlJob> getCrawlStatusAsync(String jobId) {
        return CompletableFuture.supplyAsync(() -> getCrawlStatus(jobId), asyncExecutor);
    }

    /**
     * Asynchronously cancels a crawl job.
     *
     * @param jobId the crawl job ID
     * @return a CompletableFuture that resolves to the cancellation response
     */
    public CompletableFuture<Map<String, Object>> cancelCrawlAsync(String jobId) {
        return CompletableFuture.supplyAsync(() -> cancelCrawl(jobId), asyncExecutor);
    }

    /**
     * Asynchronously starts a batch scrape job and returns immediately with the job reference.
     *
     * @param urls    the URLs to scrape
     * @param options batch scrape configuration options
     * @return a CompletableFuture that resolves to the BatchScrapeResponse
     */
    public CompletableFuture<BatchScrapeResponse> startBatchScrapeAsync(List<String> urls, BatchScrapeOptions options) {
        return CompletableFuture.supplyAsync(() -> startBatchScrape(urls, options), asyncExecutor);
    }

    /**
     * Asynchronously gets the status of a batch scrape job.
     *
     * @param jobId the batch scrape job ID
     * @return a CompletableFuture that resolves to the BatchScrapeJob
     */
    public CompletableFuture<BatchScrapeJob> getBatchScrapeStatusAsync(String jobId) {
        return CompletableFuture.supplyAsync(() -> getBatchScrapeStatus(jobId), asyncExecutor);
    }

    /**
     * Asynchronously cancels a batch scrape job.
     *
     * @param jobId the batch scrape job ID
     * @return a CompletableFuture that resolves to the cancellation response
     */
    public CompletableFuture<Map<String, Object>> cancelBatchScrapeAsync(String jobId) {
        return CompletableFuture.supplyAsync(() -> cancelBatchScrape(jobId), asyncExecutor);
    }

    /**
     * Asynchronously starts an agent task and returns immediately with the job reference.
     *
     * @param options agent configuration options
     * @return a CompletableFuture that resolves to the AgentResponse
     */
    public CompletableFuture<AgentResponse> startAgentAsync(AgentOptions options) {
        return CompletableFuture.supplyAsync(() -> startAgent(options), asyncExecutor);
    }

    /**
     * Asynchronously gets the status of an agent task.
     *
     * @param jobId the agent job ID
     * @return a CompletableFuture that resolves to the AgentStatusResponse
     */
    public CompletableFuture<AgentStatusResponse> getAgentStatusAsync(String jobId) {
        return CompletableFuture.supplyAsync(() -> getAgentStatus(jobId), asyncExecutor);
    }

    /**
     * Asynchronously cancels an agent task.
     *
     * @param jobId the agent job ID
     * @return a CompletableFuture that resolves to the cancellation response
     */
    public CompletableFuture<Map<String, Object>> cancelAgentAsync(String jobId) {
        return CompletableFuture.supplyAsync(() -> cancelAgent(jobId), asyncExecutor);
    }

    /**
     * Asynchronously gets concurrency info.
     *
     * @return a CompletableFuture that resolves to the ConcurrencyCheck
     */
    public CompletableFuture<ConcurrencyCheck> getConcurrencyAsync() {
        return CompletableFuture.supplyAsync(this::getConcurrency, asyncExecutor);
    }

    /**
     * Asynchronously gets credit usage.
     *
     * @return a CompletableFuture that resolves to the CreditUsage
     */
    public CompletableFuture<CreditUsage> getCreditUsageAsync() {
        return CompletableFuture.supplyAsync(this::getCreditUsage, asyncExecutor);
    }

    // ================================================================
    // INTERNAL POLLING HELPERS
    // ================================================================

    private CrawlJob pollCrawl(String jobId, int pollIntervalSec, int timeoutSec) {
        long deadline = System.currentTimeMillis() + (timeoutSec * 1000L);
        while (System.currentTimeMillis() < deadline) {
            CrawlJob job = getCrawlStatus(jobId);
            if (job.isDone()) {
                return paginateCrawl(job);
            }
            sleep(pollIntervalSec);
        }
        throw new JobTimeoutException(jobId, timeoutSec, "Crawl");
    }

    private BatchScrapeJob pollBatchScrape(String jobId, int pollIntervalSec, int timeoutSec) {
        long deadline = System.currentTimeMillis() + (timeoutSec * 1000L);
        while (System.currentTimeMillis() < deadline) {
            BatchScrapeJob job = getBatchScrapeStatus(jobId);
            if (job.isDone()) {
                return paginateBatchScrape(job);
            }
            sleep(pollIntervalSec);
        }
        throw new JobTimeoutException(jobId, timeoutSec, "Batch scrape");
    }

    /**
     * Auto-paginates crawl results by following the "next" cursor.
     */
    private CrawlJob paginateCrawl(CrawlJob job) {
        if (job.getData() == null) {
            job.setData(new ArrayList<>());
        }
        CrawlJob current = job;
        while (current.getNext() != null && !current.getNext().isEmpty()) {
            CrawlJob nextPage = http.getAbsolute(current.getNext(), CrawlJob.class);
            if (nextPage.getData() != null && !nextPage.getData().isEmpty()) {
                job.getData().addAll(nextPage.getData());
            }
            current = nextPage;
        }
        return job;
    }

    /**
     * Auto-paginates batch scrape results by following the "next" cursor.
     */
    private BatchScrapeJob paginateBatchScrape(BatchScrapeJob job) {
        if (job.getData() == null) {
            job.setData(new ArrayList<>());
        }
        BatchScrapeJob current = job;
        while (current.getNext() != null && !current.getNext().isEmpty()) {
            BatchScrapeJob nextPage = http.getAbsolute(current.getNext(), BatchScrapeJob.class);
            if (nextPage.getData() != null && !nextPage.getData().isEmpty()) {
                job.getData().addAll(nextPage.getData());
            }
            current = nextPage;
        }
        return job;
    }

    private MonitorCheckDetail paginateMonitorCheck(MonitorCheckDetail check) {
        if (check.getPages() == null) {
            check.setPages(new ArrayList<>());
        }
        MonitorCheckDetail current = check;
        while (current.getNext() != null && !current.getNext().isEmpty()) {
            MonitorCheckDetail nextPage = extractData(
                    http.getAbsolute(current.getNext(), Map.class),
                    MonitorCheckDetail.class
            );
            if (nextPage.getPages() != null && !nextPage.getPages().isEmpty()) {
                check.getPages().addAll(nextPage.getPages());
            }
            current = nextPage;
        }
        check.setNext(null);
        return check;
    }

    // ================================================================
    // INTERNAL UTILITIES
    // ================================================================

    /**
     * Extracts the "data" field from a raw API response map and deserializes it.
     */
    @SuppressWarnings("unchecked")
    private <T> T extractData(Map rawResponse, Class<T> type) {
        Object data = rawResponse.get("data");
        if (data == null) {
            // Some endpoints return the data at the top level
            return http.objectMapper.convertValue(rawResponse, type);
        }
        return http.objectMapper.convertValue(data, type);
    }

    private <T> List<T> extractDataList(Map rawResponse, Class<T> type) {
        Object data = rawResponse.get("data");
        if (!(data instanceof List<?>)) {
            return Collections.emptyList();
        }
        List<T> result = new ArrayList<>();
        for (Object item : (List<?>) data) {
            result.add(http.objectMapper.convertValue(item, type));
        }
        return result;
    }

    private String listQuery(Integer limit, Integer offset) {
        List<String> parts = new ArrayList<>();
        if (limit != null) parts.add("limit=" + limit);
        if (offset != null) parts.add("offset=" + offset);
        return parts.isEmpty() ? "" : "?" + String.join("&", parts);
    }

    private String monitorCheckQuery(Integer limit, Integer skip, String status) {
        List<String> parts = new ArrayList<>();
        if (limit != null) parts.add("limit=" + limit);
        if (skip != null) parts.add("skip=" + skip);
        if (status != null && !status.isBlank()) {
            parts.add("status=" + java.net.URLEncoder.encode(status, java.nio.charset.StandardCharsets.UTF_8));
        }
        return parts.isEmpty() ? "" : "?" + String.join("&", parts);
    }

    /**
     * Merges a typed options object into a request body map, using Jackson serialization.
     */
    @SuppressWarnings("unchecked")
    private void mergeOptions(Map<String, Object> body, Object options) {
        Map<String, Object> optionsMap = http.objectMapper.convertValue(options, Map.class);
        body.putAll(optionsMap);
    }

    private void sleep(int seconds) {
        try {
            Thread.sleep(seconds * 1000L);
        } catch (InterruptedException e) {
            Thread.currentThread().interrupt();
            throw new FirecrawlException("Polling interrupted", e);
        }
    }

    // ================================================================
    // BUILDER
    // ================================================================

    public static final class Builder {

        private String apiKey;
        private boolean apiKeyExplicitlySet;
        private String apiUrl = DEFAULT_API_URL;
        private long timeoutMs = DEFAULT_TIMEOUT_MS;
        private int maxRetries = DEFAULT_MAX_RETRIES;
        private double backoffFactor = DEFAULT_BACKOFF_FACTOR;
        private Executor asyncExecutor;
        private OkHttpClient httpClient;

        private Builder() {}

        /**
         * Sets the API key. Falls back to FIRECRAWL_API_KEY env var or
         * firecrawl.apiKey system property if not provided.
         */
        public Builder apiKey(String apiKey) {
            this.apiKey = apiKey;
            this.apiKeyExplicitlySet = true;
            return this;
        }

        /**
         * Sets the API base URL. Defaults to https://api.firecrawl.dev.
         * Falls back to FIRECRAWL_API_URL env var if not provided.
         */
        public Builder apiUrl(String apiUrl) {
            this.apiUrl = apiUrl;
            return this;
        }

        /**
         * Sets the HTTP request timeout in milliseconds. Default: 300000 (5 minutes).
         */
        public Builder timeoutMs(long timeoutMs) {
            this.timeoutMs = timeoutMs;
            return this;
        }

        /**
         * Sets the maximum number of automatic retries for transient failures. Default: 3.
         */
        public Builder maxRetries(int maxRetries) {
            this.maxRetries = maxRetries;
            return this;
        }

        /**
         * Sets the exponential backoff factor in seconds. Default: 0.5.
         */
        public Builder backoffFactor(double backoffFactor) {
            this.backoffFactor = backoffFactor;
            return this;
        }

        /**
         * Sets a custom executor for async operations. Default: ForkJoinPool.commonPool().
         */
        public Builder asyncExecutor(Executor asyncExecutor) {
            this.asyncExecutor = asyncExecutor;
            return this;
        }

        /**
         * Sets a pre-configured OkHttpClient instance.
         *
         * <p>When provided, this client is used as-is for all HTTP requests, giving
         * full control over connection pooling, interceptors, SSL configuration,
         * proxy settings, timeouts, and any other OkHttp feature. The
         * {@link #timeoutMs(long)} setting is ignored when a custom client is supplied.
         *
         * <p>Example:
         * <pre>{@code
         * OkHttpClient custom = new OkHttpClient.Builder()
         *     .proxy(new Proxy(Proxy.Type.HTTP, new InetSocketAddress("proxy.example.com", 8080)))
         *     .addInterceptor(myLoggingInterceptor)
         *     .connectTimeout(10, TimeUnit.SECONDS)
         *     .build();
         *
         * FirecrawlClient client = FirecrawlClient.builder()
         *     .apiKey("fc-your-api-key")
         *     .httpClient(custom)
         *     .build();
         * }</pre>
         *
         * @param httpClient the OkHttpClient instance to use
         */
        public Builder httpClient(OkHttpClient httpClient) {
            this.httpClient = httpClient;
            return this;
        }

        public FirecrawlClient build() {
            String resolvedKey = apiKey;
            if (apiKeyExplicitlySet && (resolvedKey == null || resolvedKey.isBlank())) {
                throw new FirecrawlException(
                        "API key cannot be null or empty when explicitly provided.");
            }
            if (resolvedKey == null || resolvedKey.isBlank()) {
                resolvedKey = System.getenv("FIRECRAWL_API_KEY");
            }
            if (resolvedKey == null || resolvedKey.isBlank()) {
                resolvedKey = System.getProperty("firecrawl.apiKey");
            }
            if (resolvedKey == null || resolvedKey.isBlank()) {
                throw new FirecrawlException(
                        "API key is required. Set it via builder.apiKey(), " +
                        "FIRECRAWL_API_KEY environment variable, or firecrawl.apiKey system property.");
            }

            String resolvedUrl = apiUrl;
            if (resolvedUrl == null || resolvedUrl.equals(DEFAULT_API_URL)) {
                String envUrl = System.getenv("FIRECRAWL_API_URL");
                if (envUrl != null && !envUrl.isEmpty()) {
                    resolvedUrl = envUrl;
                }
            }

            Executor executor = asyncExecutor != null ? asyncExecutor : ForkJoinPool.commonPool();
            FirecrawlHttpClient http = new FirecrawlHttpClient(
                    resolvedKey, resolvedUrl, timeoutMs, maxRetries, backoffFactor, httpClient);
            return new FirecrawlClient(http, executor);
        }
    }
}
