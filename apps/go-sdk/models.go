package firecrawl

import "encoding/json"

// Document represents a scraped web page.
type Document struct {
	Markdown       string                   `json:"markdown,omitempty"`
	HTML           string                   `json:"html,omitempty"`
	RawHTML        string                   `json:"rawHtml,omitempty"`
	JSON           interface{}              `json:"json,omitempty"`
	Summary        string                   `json:"summary,omitempty"`
	Metadata       map[string]interface{}   `json:"metadata,omitempty"`
	Links          []string                 `json:"links,omitempty"`
	Images         []string                 `json:"images,omitempty"`
	Screenshot     string                   `json:"screenshot,omitempty"`
	Audio          string                   `json:"audio,omitempty"`
	Attributes     []map[string]interface{} `json:"attributes,omitempty"`
	Actions        map[string]interface{}   `json:"actions,omitempty"`
	Warning        string                   `json:"warning,omitempty"`
	ChangeTracking map[string]interface{}   `json:"changeTracking,omitempty"`
	Branding       map[string]interface{}   `json:"branding,omitempty"`
}

// CrawlResponse is returned when starting an async crawl.
type CrawlResponse struct {
	ID  string `json:"id"`
	URL string `json:"url,omitempty"`
}

// CrawlJob represents the status and results of a crawl job.
type CrawlJob struct {
	ID          string     `json:"id,omitempty"`
	Status      string     `json:"status"`
	Total       int        `json:"total"`
	Completed   int        `json:"completed"`
	CreditsUsed *int       `json:"creditsUsed,omitempty"`
	ExpiresAt   string     `json:"expiresAt,omitempty"`
	Next        string     `json:"next,omitempty"`
	Data        []Document `json:"data,omitempty"`
}

// IsDone returns true if the crawl job has finished (completed, failed, or cancelled).
func (c *CrawlJob) IsDone() bool {
	return c.Status == "completed" || c.Status == "failed" || c.Status == "cancelled"
}

// BatchScrapeResponse is returned when starting an async batch scrape.
type BatchScrapeResponse struct {
	ID          string   `json:"id"`
	URL         string   `json:"url,omitempty"`
	InvalidURLs []string `json:"invalidURLs,omitempty"`
}

// BatchScrapeJob represents the status and results of a batch scrape job.
type BatchScrapeJob struct {
	ID          string     `json:"id,omitempty"`
	Status      string     `json:"status"`
	Total       int        `json:"total"`
	Completed   int        `json:"completed"`
	CreditsUsed *int       `json:"creditsUsed,omitempty"`
	ExpiresAt   string     `json:"expiresAt,omitempty"`
	Next        string     `json:"next,omitempty"`
	Data        []Document `json:"data,omitempty"`
}

// IsDone returns true if the batch scrape job has finished.
func (b *BatchScrapeJob) IsDone() bool {
	return b.Status == "completed" || b.Status == "failed" || b.Status == "cancelled"
}

// LinkResult represents a discovered URL from a map request.
// The API may return links as plain strings or as objects with url/title/description.
type LinkResult struct {
	URL         string `json:"url,omitempty"`
	Title       string `json:"title,omitempty"`
	Description string `json:"description,omitempty"`
}

// UnmarshalJSON handles both string and object link elements from the API.
func (l *LinkResult) UnmarshalJSON(data []byte) error {
	// Try as a plain string first.
	var s string
	if err := json.Unmarshal(data, &s); err == nil {
		l.URL = s
		return nil
	}

	// Otherwise unmarshal as an object.
	type linkAlias LinkResult
	var alias linkAlias
	if err := json.Unmarshal(data, &alias); err != nil {
		return err
	}
	*l = LinkResult(alias)
	return nil
}

// MapData represents the result of a map (URL discovery) request.
type MapData struct {
	Links []LinkResult `json:"links,omitempty"`
}

// MonitorSchedule configures when a monitor runs.
type MonitorSchedule struct {
	Cron     string `json:"cron"`
	Timezone string `json:"timezone,omitempty"`
}

// MonitorCreateRequest creates a scheduled monitor.
type MonitorCreateRequest struct {
	Name          string                   `json:"name"`
	Schedule      MonitorSchedule          `json:"schedule"`
	Targets       []map[string]interface{} `json:"targets"`
	Webhook       map[string]interface{}   `json:"webhook,omitempty"`
	Notification  map[string]interface{}   `json:"notification,omitempty"`
	RetentionDays *int                     `json:"retentionDays,omitempty"`
}

// MonitorUpdateRequest updates a scheduled monitor.
type MonitorUpdateRequest struct {
	Name          string                   `json:"name,omitempty"`
	Status        string                   `json:"status,omitempty"`
	Schedule      *MonitorSchedule         `json:"schedule,omitempty"`
	Targets       []map[string]interface{} `json:"targets,omitempty"`
	Webhook       map[string]interface{}   `json:"webhook,omitempty"`
	Notification  map[string]interface{}   `json:"notification,omitempty"`
	RetentionDays *int                     `json:"retentionDays,omitempty"`
}

// Monitor represents a scheduled monitor.
type Monitor struct {
	ID                       string                   `json:"id"`
	Name                     string                   `json:"name"`
	Status                   string                   `json:"status"`
	Schedule                 MonitorSchedule          `json:"schedule"`
	NextRunAt                string                   `json:"nextRunAt,omitempty"`
	LastRunAt                string                   `json:"lastRunAt,omitempty"`
	CurrentCheckID           string                   `json:"currentCheckId,omitempty"`
	Targets                  []map[string]interface{} `json:"targets,omitempty"`
	Webhook                  map[string]interface{}   `json:"webhook,omitempty"`
	Notification             map[string]interface{}   `json:"notification,omitempty"`
	RetentionDays            int                      `json:"retentionDays"`
	EstimatedCreditsPerMonth *int                     `json:"estimatedCreditsPerMonth,omitempty"`
	LastCheckSummary         *MonitorSummary          `json:"lastCheckSummary,omitempty"`
	CreatedAt                string                   `json:"createdAt,omitempty"`
	UpdatedAt                string                   `json:"updatedAt,omitempty"`
}

// MonitorSummary summarizes page statuses in a check.
type MonitorSummary struct {
	TotalPages int `json:"totalPages"`
	Same       int `json:"same"`
	Changed    int `json:"changed"`
	New        int `json:"new"`
	Removed    int `json:"removed"`
	Error      int `json:"error"`
}

// MonitorCheck represents a single monitor run.
type MonitorCheck struct {
	ID                 string         `json:"id"`
	MonitorID          string         `json:"monitorId"`
	Status             string         `json:"status"`
	Trigger            string         `json:"trigger"`
	ScheduledFor       string         `json:"scheduledFor,omitempty"`
	StartedAt          string         `json:"startedAt,omitempty"`
	FinishedAt         string         `json:"finishedAt,omitempty"`
	EstimatedCredits   *int           `json:"estimatedCredits,omitempty"`
	ReservedCredits    *int           `json:"reservedCredits,omitempty"`
	ActualCredits      *int           `json:"actualCredits,omitempty"`
	BillingStatus      string         `json:"billingStatus,omitempty"`
	Summary            MonitorSummary `json:"summary"`
	TargetResults      interface{}    `json:"targetResults,omitempty"`
	NotificationStatus interface{}    `json:"notificationStatus,omitempty"`
	Error              string         `json:"error,omitempty"`
	CreatedAt          string         `json:"createdAt,omitempty"`
	UpdatedAt          string         `json:"updatedAt,omitempty"`
}

// MonitorCheckPage is a single page result in a monitor check.
type MonitorCheckPage struct {
	ID               string      `json:"id"`
	TargetID         string      `json:"targetId"`
	URL              string      `json:"url"`
	Status           string      `json:"status"`
	PreviousScrapeID string      `json:"previousScrapeId,omitempty"`
	CurrentScrapeID  string      `json:"currentScrapeId,omitempty"`
	StatusCode       *int        `json:"statusCode,omitempty"`
	Error            string      `json:"error,omitempty"`
	Metadata         interface{} `json:"metadata,omitempty"`
	Diff             interface{} `json:"diff,omitempty"`
	CreatedAt        string      `json:"createdAt,omitempty"`
}

// MonitorCheckDetail includes paginated page results and inline diffs.
type MonitorCheckDetail struct {
	MonitorCheck
	Pages []MonitorCheckPage `json:"pages,omitempty"`
	Next  string             `json:"next,omitempty"`
}

// ListMonitorsOptions controls monitor list pagination.
type ListMonitorsOptions struct {
	Limit  *int
	Offset *int
}

// ListMonitorChecksOptions controls monitor check pagination/filtering.
type ListMonitorChecksOptions struct {
	Limit  *int
	Offset *int
	Status string
}

// GetMonitorCheckOptions controls monitor check page pagination/filtering.
type GetMonitorCheckOptions struct {
	Limit        *int
	Skip         *int
	Status       string
	AutoPaginate *bool
}

// SearchData represents the result of a search request.
type SearchData struct {
	Web    []map[string]interface{} `json:"web,omitempty"`
	News   []map[string]interface{} `json:"news,omitempty"`
	Images []map[string]interface{} `json:"images,omitempty"`
}

// AgentResponse is returned when starting an async agent task.
type AgentResponse struct {
	Success bool   `json:"success"`
	ID      string `json:"id,omitempty"`
	Error   string `json:"error,omitempty"`
}

// AgentStatusResponse represents the status and results of an agent task.
type AgentStatusResponse struct {
	Success     bool        `json:"success"`
	Status      string      `json:"status"`
	Error       string      `json:"error,omitempty"`
	Data        interface{} `json:"data,omitempty"`
	Model       string      `json:"model,omitempty"`
	ExpiresAt   string      `json:"expiresAt,omitempty"`
	CreditsUsed *int        `json:"creditsUsed,omitempty"`
}

// IsDone returns true if the agent task has finished.
func (a *AgentStatusResponse) IsDone() bool {
	return a.Status == "completed" || a.Status == "failed" || a.Status == "cancelled"
}

// BrowserCreateResponse is returned when creating a browser session.
type BrowserCreateResponse struct {
	Success     bool   `json:"success"`
	ID          string `json:"id,omitempty"`
	CDPUrl      string `json:"cdpUrl,omitempty"`
	LiveViewURL string `json:"liveViewUrl,omitempty"`
	ExpiresAt   string `json:"expiresAt,omitempty"`
	Error       string `json:"error,omitempty"`
}

// BrowserExecuteResponse is returned when executing code in a browser session.
type BrowserExecuteResponse struct {
	Success  bool   `json:"success"`
	Stdout   string `json:"stdout,omitempty"`
	Result   string `json:"result,omitempty"`
	Stderr   string `json:"stderr,omitempty"`
	ExitCode *int   `json:"exitCode,omitempty"`
	Killed   *bool  `json:"killed,omitempty"`
	Error    string `json:"error,omitempty"`
}

// BrowserDeleteResponse is returned when deleting a browser session.
type BrowserDeleteResponse struct {
	Success           bool   `json:"success"`
	SessionDurationMs *int64 `json:"sessionDurationMs,omitempty"`
	CreditsBilled     *int   `json:"creditsBilled,omitempty"`
	Error             string `json:"error,omitempty"`
}

// BrowserListResponse is returned when listing browser sessions.
type BrowserListResponse struct {
	Success  bool             `json:"success"`
	Sessions []BrowserSession `json:"sessions,omitempty"`
	Error    string           `json:"error,omitempty"`
}

// BrowserSession represents a browser session.
type BrowserSession struct {
	ID            string `json:"id"`
	Status        string `json:"status"`
	CDPUrl        string `json:"cdpUrl,omitempty"`
	LiveViewURL   string `json:"liveViewUrl,omitempty"`
	StreamWebView bool   `json:"streamWebView,omitempty"`
	CreatedAt     string `json:"createdAt,omitempty"`
	LastActivity  string `json:"lastActivity,omitempty"`
}

// ConcurrencyCheck represents concurrency usage information.
type ConcurrencyCheck struct {
	Concurrency    int `json:"concurrency"`
	MaxConcurrency int `json:"maxConcurrency"`
}

// CreditUsage represents credit usage information.
type CreditUsage struct {
	RemainingCredits   int    `json:"remainingCredits"`
	PlanCredits        int    `json:"planCredits"`
	BillingPeriodStart string `json:"billingPeriodStart,omitempty"`
	BillingPeriodEnd   string `json:"billingPeriodEnd,omitempty"`
}
