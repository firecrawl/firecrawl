// Package firecrawl provides a Go client for the Firecrawl v2 web scraping API.
//
// Create a client using [NewClient] with functional options:
//
//	client, err := firecrawl.NewClient(
//	    option.WithAPIKey("fc-your-api-key"),
//	)
//
// Or let the client read the FIRECRAWL_API_KEY environment variable:
//
//	client, err := firecrawl.NewClient()
package firecrawl

import (
	"context"
	"encoding/json"
	"fmt"
	"net/http"
	"net/url"
	"os"
	"strings"
	"time"

	"github.com/firecrawl/firecrawl/apps/go-sdk/option"
)

const (
	defaultPollInterval = 2   // seconds
	defaultJobTimeout   = 300 // seconds
)

// Client is the Firecrawl v2 API client.
type Client struct {
	http *httpClient
}

// NewClient creates a new Firecrawl client.
//
// The API key is resolved in order from:
//  1. [option.WithAPIKey]
//  2. FIRECRAWL_API_KEY environment variable
//
// The API URL defaults to https://api.firecrawl.dev and can be overridden
// with [option.WithAPIURL] or the FIRECRAWL_API_URL environment variable.
func NewClient(opts ...option.RequestOption) (*Client, error) {
	cfg := &option.RequestConfig{
		MaxRetries:    defaultMaxRetries,
		BackoffFactor: defaultBackoffFactor,
	}
	for _, opt := range opts {
		opt(cfg)
	}

	// Resolve API key.
	apiKey := strings.TrimSpace(cfg.APIKey)
	if apiKey == "" {
		apiKey = strings.TrimSpace(os.Getenv("FIRECRAWL_API_KEY"))
	}
	if apiKey == "" {
		return nil, &FirecrawlError{
			Message: "API key is required. Set it via option.WithAPIKey(), " +
				"or FIRECRAWL_API_KEY environment variable.",
		}
	}

	// Resolve API URL.
	apiURL := cfg.APIURL
	if apiURL == "" {
		apiURL = os.Getenv("FIRECRAWL_API_URL")
	}
	if apiURL == "" {
		apiURL = defaultAPIURL
	}

	// Resolve HTTP client.
	httpCl := cfg.HTTPClient
	if httpCl == nil {
		httpCl = &http.Client{Timeout: defaultTimeout}
	}

	hc := newHTTPClient(apiKey, apiURL, httpCl, cfg.MaxRetries, cfg.BackoffFactor, cfg.ExtraHeaders)
	return &Client{http: hc}, nil
}

// ================================================================
// SCRAPE
// ================================================================

// Scrape scrapes a single URL and returns the document.
func (c *Client) Scrape(ctx context.Context, url string, opts *ScrapeOptions) (*Document, error) {
	if url == "" {
		return nil, &FirecrawlError{Message: "URL is required"}
	}

	body := map[string]interface{}{"url": url}
	mergeOptions(body, opts)

	raw, err := c.http.post(ctx, "/v2/scrape", body, nil)
	if err != nil {
		return nil, err
	}

	doc, err := extractDataAs[Document](raw)
	if err != nil {
		return nil, err
	}
	return doc, nil
}

// Interact executes code in a scrape-bound browser session.
func (c *Client) Interact(ctx context.Context, jobID, code string, params *InteractParams) (*BrowserExecuteResponse, error) {
	if jobID == "" {
		return nil, &FirecrawlError{Message: "job ID is required"}
	}
	if code == "" {
		return nil, &FirecrawlError{Message: "code is required"}
	}

	body := map[string]interface{}{
		"code":     code,
		"language": "node",
	}
	if params != nil {
		if params.Language != "" {
			body["language"] = params.Language
		}
		if params.Timeout != nil {
			body["timeout"] = *params.Timeout
		}
		if params.Origin != "" {
			body["origin"] = params.Origin
		}
	}

	raw, err := c.http.post(ctx, "/v2/scrape/"+jobID+"/interact", body, nil)
	if err != nil {
		return nil, err
	}

	var resp BrowserExecuteResponse
	if err := json.Unmarshal(raw, &resp); err != nil {
		return nil, &FirecrawlError{Message: fmt.Sprintf("failed to decode response: %v", err)}
	}
	return &resp, nil
}

// StopInteractiveBrowser stops the interactive browser session for a scrape job.
func (c *Client) StopInteractiveBrowser(ctx context.Context, jobID string) (*BrowserDeleteResponse, error) {
	if jobID == "" {
		return nil, &FirecrawlError{Message: "job ID is required"}
	}

	raw, err := c.http.delete(ctx, "/v2/scrape/"+jobID+"/interact")
	if err != nil {
		return nil, err
	}

	var resp BrowserDeleteResponse
	if err := json.Unmarshal(raw, &resp); err != nil {
		return nil, &FirecrawlError{Message: fmt.Sprintf("failed to decode response: %v", err)}
	}
	return &resp, nil
}

// ================================================================
// CRAWL
// ================================================================

// StartCrawl starts an async crawl job and returns immediately.
func (c *Client) StartCrawl(ctx context.Context, url string, opts *CrawlOptions) (*CrawlResponse, error) {
	if url == "" {
		return nil, &FirecrawlError{Message: "URL is required"}
	}
	if opts != nil && opts.Limit != nil && *opts.Limit <= 0 {
		return nil, &FirecrawlError{Message: "limit must be positive"}
	}

	body := map[string]interface{}{"url": url}
	mergeOptions(body, opts)

	raw, err := c.http.post(ctx, "/v2/crawl", body, nil)
	if err != nil {
		return nil, err
	}

	var resp CrawlResponse
	if err := json.Unmarshal(raw, &resp); err != nil {
		return nil, &FirecrawlError{Message: fmt.Sprintf("failed to decode response: %v", err)}
	}
	return &resp, nil
}

// GetCrawlStatus gets the status and results of a crawl job.
func (c *Client) GetCrawlStatus(ctx context.Context, jobID string) (*CrawlJob, error) {
	if jobID == "" {
		return nil, &FirecrawlError{Message: "job ID is required"}
	}

	raw, err := c.http.get(ctx, "/v2/crawl/"+jobID)
	if err != nil {
		return nil, err
	}

	var job CrawlJob
	if err := json.Unmarshal(raw, &job); err != nil {
		return nil, &FirecrawlError{Message: fmt.Sprintf("failed to decode response: %v", err)}
	}
	return &job, nil
}

// Crawl crawls a website and waits for completion with auto-polling.
func (c *Client) Crawl(ctx context.Context, url string, opts *CrawlOptions) (*CrawlJob, error) {
	return c.CrawlWithPolling(ctx, url, opts, defaultPollInterval, defaultJobTimeout)
}

// CrawlWithPolling crawls a website and waits for completion with custom polling settings.
func (c *Client) CrawlWithPolling(ctx context.Context, url string, opts *CrawlOptions, pollIntervalSec, timeoutSec int) (*CrawlJob, error) {
	start, err := c.StartCrawl(ctx, url, opts)
	if err != nil {
		return nil, err
	}
	return c.pollCrawl(ctx, start.ID, pollIntervalSec, timeoutSec)
}

// CancelCrawl cancels a running crawl job.
func (c *Client) CancelCrawl(ctx context.Context, jobID string) (map[string]interface{}, error) {
	if jobID == "" {
		return nil, &FirecrawlError{Message: "job ID is required"}
	}

	raw, err := c.http.delete(ctx, "/v2/crawl/"+jobID)
	if err != nil {
		return nil, err
	}

	var resp map[string]interface{}
	if err := json.Unmarshal(raw, &resp); err != nil {
		return nil, &FirecrawlError{Message: fmt.Sprintf("failed to decode response: %v", err)}
	}
	return resp, nil
}

// GetCrawlErrors gets errors from a crawl job.
func (c *Client) GetCrawlErrors(ctx context.Context, jobID string) (map[string]interface{}, error) {
	if jobID == "" {
		return nil, &FirecrawlError{Message: "job ID is required"}
	}

	raw, err := c.http.get(ctx, "/v2/crawl/"+jobID+"/errors")
	if err != nil {
		return nil, err
	}

	var resp map[string]interface{}
	if err := json.Unmarshal(raw, &resp); err != nil {
		return nil, &FirecrawlError{Message: fmt.Sprintf("failed to decode response: %v", err)}
	}
	return resp, nil
}

// ================================================================
// BATCH SCRAPE
// ================================================================

// StartBatchScrape starts an async batch scrape job.
func (c *Client) StartBatchScrape(ctx context.Context, urls []string, opts *BatchScrapeOptions) (*BatchScrapeResponse, error) {
	if len(urls) == 0 {
		return nil, &FirecrawlError{Message: "URLs list is required"}
	}

	body := map[string]interface{}{"urls": urls}
	var extraHeaders map[string]string

	if opts != nil {
		if opts.IdempotencyKey != nil && *opts.IdempotencyKey != "" {
			extraHeaders = map[string]string{"x-idempotency-key": *opts.IdempotencyKey}
		}
		mergeOptions(body, opts)
		// Flatten nested scrape options to top level as the API expects.
		if nested, ok := body["options"]; ok {
			delete(body, "options")
			if nestedMap, ok := nested.(map[string]interface{}); ok {
				batchFields := make(map[string]interface{})
				for k, v := range body {
					batchFields[k] = v
				}
				for k, v := range nestedMap {
					body[k] = v
				}
				for k, v := range batchFields {
					body[k] = v
				}
			}
		}
	}

	raw, err := c.http.post(ctx, "/v2/batch/scrape", body, extraHeaders)
	if err != nil {
		return nil, err
	}

	var resp BatchScrapeResponse
	if err := json.Unmarshal(raw, &resp); err != nil {
		return nil, &FirecrawlError{Message: fmt.Sprintf("failed to decode response: %v", err)}
	}
	return &resp, nil
}

// GetBatchScrapeStatus gets the status and results of a batch scrape job.
func (c *Client) GetBatchScrapeStatus(ctx context.Context, jobID string) (*BatchScrapeJob, error) {
	if jobID == "" {
		return nil, &FirecrawlError{Message: "job ID is required"}
	}

	raw, err := c.http.get(ctx, "/v2/batch/scrape/"+jobID)
	if err != nil {
		return nil, err
	}

	var job BatchScrapeJob
	if err := json.Unmarshal(raw, &job); err != nil {
		return nil, &FirecrawlError{Message: fmt.Sprintf("failed to decode response: %v", err)}
	}
	return &job, nil
}

// BatchScrape batch-scrapes URLs and waits for completion with auto-polling.
func (c *Client) BatchScrape(ctx context.Context, urls []string, opts *BatchScrapeOptions) (*BatchScrapeJob, error) {
	return c.BatchScrapeWithPolling(ctx, urls, opts, defaultPollInterval, defaultJobTimeout)
}

// BatchScrapeWithPolling batch-scrapes URLs and waits for completion with custom polling settings.
func (c *Client) BatchScrapeWithPolling(ctx context.Context, urls []string, opts *BatchScrapeOptions, pollIntervalSec, timeoutSec int) (*BatchScrapeJob, error) {
	start, err := c.StartBatchScrape(ctx, urls, opts)
	if err != nil {
		return nil, err
	}
	return c.pollBatchScrape(ctx, start.ID, pollIntervalSec, timeoutSec)
}

// CancelBatchScrape cancels a running batch scrape job.
func (c *Client) CancelBatchScrape(ctx context.Context, jobID string) (map[string]interface{}, error) {
	if jobID == "" {
		return nil, &FirecrawlError{Message: "job ID is required"}
	}

	raw, err := c.http.delete(ctx, "/v2/batch/scrape/"+jobID)
	if err != nil {
		return nil, err
	}

	var resp map[string]interface{}
	if err := json.Unmarshal(raw, &resp); err != nil {
		return nil, &FirecrawlError{Message: fmt.Sprintf("failed to decode response: %v", err)}
	}
	return resp, nil
}

// ================================================================
// MAP
// ================================================================

// Map discovers URLs on a website.
func (c *Client) Map(ctx context.Context, url string, opts *MapOptions) (*MapData, error) {
	if url == "" {
		return nil, &FirecrawlError{Message: "URL is required"}
	}
	if opts != nil && opts.Limit != nil && *opts.Limit <= 0 {
		return nil, &FirecrawlError{Message: "limit must be positive"}
	}

	body := map[string]interface{}{"url": url}
	mergeOptions(body, opts)

	raw, err := c.http.post(ctx, "/v2/map", body, nil)
	if err != nil {
		return nil, err
	}

	data, err := extractDataAs[MapData](raw)
	if err != nil {
		return nil, err
	}
	return data, nil
}

// ================================================================
// MONITOR
// ================================================================

// CreateMonitor creates a scheduled monitor.
func (c *Client) CreateMonitor(ctx context.Context, req *MonitorCreateRequest) (*Monitor, error) {
	if req == nil {
		return nil, &FirecrawlError{Message: "monitor request is required"}
	}
	raw, err := c.http.post(ctx, "/v2/monitor", req, nil)
	if err != nil {
		return nil, err
	}
	return extractDataAs[Monitor](raw)
}

// ListMonitors lists monitors for the authenticated team.
func (c *Client) ListMonitors(ctx context.Context, opts *ListMonitorsOptions) ([]Monitor, error) {
	path := "/v2/monitor" + listQuery(opts)
	raw, err := c.http.get(ctx, path)
	if err != nil {
		return nil, err
	}
	data, err := extractDataAs[[]Monitor](raw)
	if err != nil {
		return nil, err
	}
	return *data, nil
}

// GetMonitor gets a monitor by ID.
func (c *Client) GetMonitor(ctx context.Context, monitorID string) (*Monitor, error) {
	if monitorID == "" {
		return nil, &FirecrawlError{Message: "monitor ID is required"}
	}
	raw, err := c.http.get(ctx, "/v2/monitor/"+monitorID)
	if err != nil {
		return nil, err
	}
	return extractDataAs[Monitor](raw)
}

// UpdateMonitor updates a monitor.
func (c *Client) UpdateMonitor(ctx context.Context, monitorID string, req *MonitorUpdateRequest) (*Monitor, error) {
	if monitorID == "" {
		return nil, &FirecrawlError{Message: "monitor ID is required"}
	}
	if req == nil {
		return nil, &FirecrawlError{Message: "monitor update request is required"}
	}
	raw, err := c.http.patch(ctx, "/v2/monitor/"+monitorID, req)
	if err != nil {
		return nil, err
	}
	return extractDataAs[Monitor](raw)
}

// DeleteMonitor deletes a monitor.
func (c *Client) DeleteMonitor(ctx context.Context, monitorID string) (bool, error) {
	if monitorID == "" {
		return false, &FirecrawlError{Message: "monitor ID is required"}
	}
	raw, err := c.http.delete(ctx, "/v2/monitor/"+monitorID)
	if err != nil {
		return false, err
	}
	var resp struct {
		Success bool `json:"success"`
	}
	if err := json.Unmarshal(raw, &resp); err != nil {
		return false, &FirecrawlError{Message: fmt.Sprintf("failed to decode response: %v", err)}
	}
	return resp.Success, nil
}

// RunMonitor triggers a manual monitor check.
func (c *Client) RunMonitor(ctx context.Context, monitorID string) (*MonitorCheck, error) {
	if monitorID == "" {
		return nil, &FirecrawlError{Message: "monitor ID is required"}
	}
	raw, err := c.http.post(ctx, "/v2/monitor/"+monitorID+"/run", map[string]interface{}{}, nil)
	if err != nil {
		return nil, err
	}
	return extractDataAs[MonitorCheck](raw)
}

// ListMonitorChecks lists checks for a monitor.
func (c *Client) ListMonitorChecks(ctx context.Context, monitorID string, opts *ListMonitorChecksOptions) ([]MonitorCheck, error) {
	if monitorID == "" {
		return nil, &FirecrawlError{Message: "monitor ID is required"}
	}
	path := "/v2/monitor/" + monitorID + "/checks" + checksQuery(opts)
	raw, err := c.http.get(ctx, path)
	if err != nil {
		return nil, err
	}
	data, err := extractDataAs[[]MonitorCheck](raw)
	if err != nil {
		return nil, err
	}
	return *data, nil
}

// GetMonitorCheck gets a monitor check with page results, auto-paginated by default.
func (c *Client) GetMonitorCheck(ctx context.Context, monitorID, checkID string, opts *GetMonitorCheckOptions) (*MonitorCheckDetail, error) {
	if monitorID == "" || checkID == "" {
		return nil, &FirecrawlError{Message: "monitor ID and check ID are required"}
	}
	path := "/v2/monitor/" + monitorID + "/checks/" + checkID + monitorCheckPageQuery(opts)
	raw, err := c.http.get(ctx, path)
	if err != nil {
		return nil, err
	}
	detail, err := extractMonitorCheckDetail(raw)
	if err != nil {
		return nil, err
	}

	autoPaginate := true
	if opts != nil && opts.AutoPaginate != nil {
		autoPaginate = *opts.AutoPaginate
	}
	for autoPaginate && detail.Next != "" {
		raw, err := c.http.getAbsolute(ctx, detail.Next)
		if err != nil {
			return nil, err
		}
		nextPage, err := extractMonitorCheckDetail(raw)
		if err != nil {
			return nil, err
		}
		detail.Pages = append(detail.Pages, nextPage.Pages...)
		detail.Next = nextPage.Next
	}

	return detail, nil
}

// ================================================================
// SEARCH
// ================================================================

// Search performs a web search.
func (c *Client) Search(ctx context.Context, query string, opts *SearchOptions) (*SearchData, error) {
	if query == "" {
		return nil, &FirecrawlError{Message: "query is required"}
	}
	if opts != nil && opts.Limit != nil && *opts.Limit <= 0 {
		return nil, &FirecrawlError{Message: "limit must be positive"}
	}

	body := map[string]interface{}{"query": query}
	mergeOptions(body, opts)

	raw, err := c.http.post(ctx, "/v2/search", body, nil)
	if err != nil {
		return nil, err
	}

	data, err := extractDataAs[SearchData](raw)
	if err != nil {
		return nil, err
	}
	return data, nil
}

// ================================================================
// AGENT
// ================================================================

// StartAgent starts an async agent task.
func (c *Client) StartAgent(ctx context.Context, opts *AgentOptions) (*AgentResponse, error) {
	if opts == nil {
		return nil, &FirecrawlError{Message: "agent options are required"}
	}

	raw, err := c.http.post(ctx, "/v2/agent", opts, nil)
	if err != nil {
		return nil, err
	}

	var resp AgentResponse
	if err := json.Unmarshal(raw, &resp); err != nil {
		return nil, &FirecrawlError{Message: fmt.Sprintf("failed to decode response: %v", err)}
	}
	return &resp, nil
}

// GetAgentStatus gets the status of an agent task.
func (c *Client) GetAgentStatus(ctx context.Context, jobID string) (*AgentStatusResponse, error) {
	if jobID == "" {
		return nil, &FirecrawlError{Message: "job ID is required"}
	}

	raw, err := c.http.get(ctx, "/v2/agent/"+jobID)
	if err != nil {
		return nil, err
	}

	var resp AgentStatusResponse
	if err := json.Unmarshal(raw, &resp); err != nil {
		return nil, &FirecrawlError{Message: fmt.Sprintf("failed to decode response: %v", err)}
	}
	return &resp, nil
}

// Agent runs an agent task and waits for completion with auto-polling.
func (c *Client) Agent(ctx context.Context, opts *AgentOptions) (*AgentStatusResponse, error) {
	return c.AgentWithPolling(ctx, opts, defaultPollInterval, defaultJobTimeout)
}

// AgentWithPolling runs an agent task and waits for completion with custom polling settings.
func (c *Client) AgentWithPolling(ctx context.Context, opts *AgentOptions, pollIntervalSec, timeoutSec int) (*AgentStatusResponse, error) {
	start, err := c.StartAgent(ctx, opts)
	if err != nil {
		return nil, err
	}
	if start.ID == "" {
		return nil, &FirecrawlError{Message: "agent start did not return a job ID"}
	}

	deadline := time.Now().Add(time.Duration(timeoutSec) * time.Second)
	for time.Now().Before(deadline) {
		select {
		case <-ctx.Done():
			return nil, ctx.Err()
		default:
		}

		status, err := c.GetAgentStatus(ctx, start.ID)
		if err != nil {
			return nil, err
		}
		if status.IsDone() {
			return status, nil
		}
		select {
		case <-ctx.Done():
			return nil, ctx.Err()
		case <-time.After(time.Duration(pollIntervalSec) * time.Second):
		}
	}

	return nil, &JobTimeoutError{
		FirecrawlError: FirecrawlError{Message: "agent job timed out"},
		JobID:          start.ID,
		TimeoutSeconds: timeoutSec,
	}
}

// CancelAgent cancels a running agent task.
func (c *Client) CancelAgent(ctx context.Context, jobID string) (map[string]interface{}, error) {
	if jobID == "" {
		return nil, &FirecrawlError{Message: "job ID is required"}
	}

	raw, err := c.http.delete(ctx, "/v2/agent/"+jobID)
	if err != nil {
		return nil, err
	}

	var resp map[string]interface{}
	if err := json.Unmarshal(raw, &resp); err != nil {
		return nil, &FirecrawlError{Message: fmt.Sprintf("failed to decode response: %v", err)}
	}
	return resp, nil
}

// ================================================================
// BROWSER
// ================================================================

// Browser creates a new browser session with default settings.
func (c *Client) Browser(ctx context.Context, opts *BrowserOptions) (*BrowserCreateResponse, error) {
	body := map[string]interface{}{}
	if opts != nil {
		if opts.TTL != nil {
			body["ttl"] = *opts.TTL
		}
		if opts.ActivityTTL != nil {
			body["activityTtl"] = *opts.ActivityTTL
		}
		if opts.StreamWebView != nil {
			body["streamWebView"] = *opts.StreamWebView
		}
	}

	raw, err := c.http.post(ctx, "/v2/browser", body, nil)
	if err != nil {
		return nil, err
	}

	var resp BrowserCreateResponse
	if err := json.Unmarshal(raw, &resp); err != nil {
		return nil, &FirecrawlError{Message: fmt.Sprintf("failed to decode response: %v", err)}
	}
	return &resp, nil
}

// BrowserExecute executes code in a browser session.
func (c *Client) BrowserExecute(ctx context.Context, sessionID, code string, params *BrowserExecuteParams) (*BrowserExecuteResponse, error) {
	if sessionID == "" {
		return nil, &FirecrawlError{Message: "session ID is required"}
	}
	if code == "" {
		return nil, &FirecrawlError{Message: "code is required"}
	}

	body := map[string]interface{}{
		"code":     code,
		"language": "bash",
	}
	if params != nil {
		if params.Language != "" {
			body["language"] = params.Language
		}
		if params.Timeout != nil {
			body["timeout"] = *params.Timeout
		}
	}

	raw, err := c.http.post(ctx, "/v2/browser/"+sessionID+"/execute", body, nil)
	if err != nil {
		return nil, err
	}

	var resp BrowserExecuteResponse
	if err := json.Unmarshal(raw, &resp); err != nil {
		return nil, &FirecrawlError{Message: fmt.Sprintf("failed to decode response: %v", err)}
	}
	return &resp, nil
}

// DeleteBrowser deletes a browser session.
func (c *Client) DeleteBrowser(ctx context.Context, sessionID string) (*BrowserDeleteResponse, error) {
	if sessionID == "" {
		return nil, &FirecrawlError{Message: "session ID is required"}
	}

	raw, err := c.http.delete(ctx, "/v2/browser/"+sessionID)
	if err != nil {
		return nil, err
	}

	var resp BrowserDeleteResponse
	if err := json.Unmarshal(raw, &resp); err != nil {
		return nil, &FirecrawlError{Message: fmt.Sprintf("failed to decode response: %v", err)}
	}
	return &resp, nil
}

// ListBrowsers lists browser sessions with an optional status filter.
func (c *Client) ListBrowsers(ctx context.Context, status string) (*BrowserListResponse, error) {
	endpoint := "/v2/browser"
	if status != "" {
		endpoint += "?status=" + status
	}

	raw, err := c.http.get(ctx, endpoint)
	if err != nil {
		return nil, err
	}

	var resp BrowserListResponse
	if err := json.Unmarshal(raw, &resp); err != nil {
		return nil, &FirecrawlError{Message: fmt.Sprintf("failed to decode response: %v", err)}
	}
	return &resp, nil
}

// ================================================================
// USAGE & METRICS
// ================================================================

// GetConcurrency gets current concurrency usage.
func (c *Client) GetConcurrency(ctx context.Context) (*ConcurrencyCheck, error) {
	raw, err := c.http.get(ctx, "/v2/concurrency-check")
	if err != nil {
		return nil, err
	}

	var resp ConcurrencyCheck
	if err := json.Unmarshal(raw, &resp); err != nil {
		return nil, &FirecrawlError{Message: fmt.Sprintf("failed to decode response: %v", err)}
	}
	return &resp, nil
}

// GetCreditUsage gets current credit usage.
func (c *Client) GetCreditUsage(ctx context.Context) (*CreditUsage, error) {
	raw, err := c.http.get(ctx, "/v2/team/credit-usage")
	if err != nil {
		return nil, err
	}

	var resp CreditUsage
	if err := json.Unmarshal(raw, &resp); err != nil {
		return nil, &FirecrawlError{Message: fmt.Sprintf("failed to decode response: %v", err)}
	}
	return &resp, nil
}

// ================================================================
// INTERNAL POLLING HELPERS
// ================================================================

func (c *Client) pollCrawl(ctx context.Context, jobID string, pollIntervalSec, timeoutSec int) (*CrawlJob, error) {
	deadline := time.Now().Add(time.Duration(timeoutSec) * time.Second)
	for time.Now().Before(deadline) {
		select {
		case <-ctx.Done():
			return nil, ctx.Err()
		default:
		}

		job, err := c.GetCrawlStatus(ctx, jobID)
		if err != nil {
			return nil, err
		}
		if job.IsDone() {
			return c.paginateCrawl(ctx, job)
		}
		select {
		case <-ctx.Done():
			return nil, ctx.Err()
		case <-time.After(time.Duration(pollIntervalSec) * time.Second):
		}
	}

	return nil, &JobTimeoutError{
		FirecrawlError: FirecrawlError{Message: "crawl job timed out"},
		JobID:          jobID,
		TimeoutSeconds: timeoutSec,
	}
}

func (c *Client) pollBatchScrape(ctx context.Context, jobID string, pollIntervalSec, timeoutSec int) (*BatchScrapeJob, error) {
	deadline := time.Now().Add(time.Duration(timeoutSec) * time.Second)
	for time.Now().Before(deadline) {
		select {
		case <-ctx.Done():
			return nil, ctx.Err()
		default:
		}

		job, err := c.GetBatchScrapeStatus(ctx, jobID)
		if err != nil {
			return nil, err
		}
		if job.IsDone() {
			return c.paginateBatchScrape(ctx, job)
		}
		select {
		case <-ctx.Done():
			return nil, ctx.Err()
		case <-time.After(time.Duration(pollIntervalSec) * time.Second):
		}
	}

	return nil, &JobTimeoutError{
		FirecrawlError: FirecrawlError{Message: "batch scrape job timed out"},
		JobID:          jobID,
		TimeoutSeconds: timeoutSec,
	}
}

func (c *Client) paginateCrawl(ctx context.Context, job *CrawlJob) (*CrawlJob, error) {
	if job.Data == nil {
		job.Data = []Document{}
	}
	current := job
	for current.Next != "" {
		raw, err := c.http.getAbsolute(ctx, current.Next)
		if err != nil {
			return nil, err
		}
		var nextPage CrawlJob
		if err := json.Unmarshal(raw, &nextPage); err != nil {
			return nil, &FirecrawlError{Message: fmt.Sprintf("failed to decode pagination response: %v", err)}
		}
		job.Data = append(job.Data, nextPage.Data...)
		current = &nextPage
	}
	return job, nil
}

func (c *Client) paginateBatchScrape(ctx context.Context, job *BatchScrapeJob) (*BatchScrapeJob, error) {
	if job.Data == nil {
		job.Data = []Document{}
	}
	current := job
	for current.Next != "" {
		raw, err := c.http.getAbsolute(ctx, current.Next)
		if err != nil {
			return nil, err
		}
		var nextPage BatchScrapeJob
		if err := json.Unmarshal(raw, &nextPage); err != nil {
			return nil, &FirecrawlError{Message: fmt.Sprintf("failed to decode pagination response: %v", err)}
		}
		job.Data = append(job.Data, nextPage.Data...)
		current = &nextPage
	}
	return job, nil
}

// ================================================================
// INTERNAL UTILITIES
// ================================================================

// InteractParams holds optional parameters for the Interact method.
type InteractParams struct {
	Language string
	Timeout  *int
	Origin   string
}

// BrowserOptions holds optional parameters for creating a browser session.
type BrowserOptions struct {
	TTL           *int
	ActivityTTL   *int
	StreamWebView *bool
}

// BrowserExecuteParams holds optional parameters for browser code execution.
type BrowserExecuteParams struct {
	Language string
	Timeout  *int
}

// mergeOptions serializes the options struct and merges its fields into the body map.
func mergeOptions(body map[string]interface{}, opts interface{}) {
	if opts == nil {
		return
	}
	data, err := json.Marshal(opts)
	if err != nil {
		return
	}
	var optsMap map[string]interface{}
	if err := json.Unmarshal(data, &optsMap); err != nil {
		return
	}
	for k, v := range optsMap {
		body[k] = v
	}
}

func listQuery(opts *ListMonitorsOptions) string {
	if opts == nil {
		return ""
	}
	values := url.Values{}
	if opts.Limit != nil {
		values.Set("limit", fmt.Sprintf("%d", *opts.Limit))
	}
	if opts.Offset != nil {
		values.Set("offset", fmt.Sprintf("%d", *opts.Offset))
	}
	if encoded := values.Encode(); encoded != "" {
		return "?" + encoded
	}
	return ""
}

func checksQuery(opts *ListMonitorChecksOptions) string {
	if opts == nil {
		return ""
	}
	values := url.Values{}
	if opts.Limit != nil {
		values.Set("limit", fmt.Sprintf("%d", *opts.Limit))
	}
	if opts.Offset != nil {
		values.Set("offset", fmt.Sprintf("%d", *opts.Offset))
	}
	if opts.Status != "" {
		values.Set("status", opts.Status)
	}
	if encoded := values.Encode(); encoded != "" {
		return "?" + encoded
	}
	return ""
}

func monitorCheckPageQuery(opts *GetMonitorCheckOptions) string {
	if opts == nil {
		return ""
	}
	values := url.Values{}
	if opts.Limit != nil {
		values.Set("limit", fmt.Sprintf("%d", *opts.Limit))
	}
	if opts.Skip != nil {
		values.Set("skip", fmt.Sprintf("%d", *opts.Skip))
	}
	if opts.Status != "" {
		values.Set("status", opts.Status)
	}
	if encoded := values.Encode(); encoded != "" {
		return "?" + encoded
	}
	return ""
}

// extractDataAs extracts the "data" field from a raw API response and deserializes it.
func extractDataAs[T any](raw json.RawMessage) (*T, error) {
	var envelope map[string]json.RawMessage
	if err := json.Unmarshal(raw, &envelope); err != nil {
		return nil, &FirecrawlError{Message: fmt.Sprintf("failed to decode response: %v", err)}
	}

	dataRaw, ok := envelope["data"]
	if !ok {
		// Some endpoints return data at the top level.
		var result T
		if err := json.Unmarshal(raw, &result); err != nil {
			return nil, &FirecrawlError{Message: fmt.Sprintf("failed to decode response: %v", err)}
		}
		return &result, nil
	}

	var result T
	if err := json.Unmarshal(dataRaw, &result); err != nil {
		return nil, &FirecrawlError{Message: fmt.Sprintf("failed to decode data: %v", err)}
	}
	return &result, nil
}

func extractMonitorCheckDetail(raw json.RawMessage) (*MonitorCheckDetail, error) {
	var envelope struct {
		Data MonitorCheckDetail `json:"data"`
		Next string             `json:"next"`
	}
	if err := json.Unmarshal(raw, &envelope); err != nil {
		return nil, &FirecrawlError{Message: fmt.Sprintf("failed to decode response: %v", err)}
	}
	if envelope.Next != "" {
		envelope.Data.Next = envelope.Next
	}
	return &envelope.Data, nil
}
