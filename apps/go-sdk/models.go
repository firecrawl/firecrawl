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
	Video          string                   `json:"video,omitempty"`
	Attributes     []map[string]interface{} `json:"attributes,omitempty"`
	Actions        map[string]interface{}   `json:"actions,omitempty"`
	Answer         string                   `json:"answer,omitempty"`
	Highlights     string                   `json:"highlights,omitempty"`
	Warning        string                   `json:"warning,omitempty"`
	ChangeTracking map[string]interface{}   `json:"changeTracking,omitempty"`
	Branding       map[string]interface{}   `json:"branding,omitempty"`
	Product        *ProductProfile          `json:"product,omitempty"`
}

// ProductProfile represents structured product data extracted from a page
// via the `product` scrape format.
type ProductProfile struct {
	Title         string               `json:"title"`
	Brand         string               `json:"brand,omitempty"`
	Category      string               `json:"category,omitempty"`
	URL           string               `json:"url"`
	Description   string               `json:"description,omitempty"`
	Variants      []ProductVariant     `json:"variants,omitempty"`
}

// ProductImage is a single product image.
type ProductImage struct {
	URL string `json:"url"`
	Alt string `json:"alt,omitempty"`
}

// ProductPrice represents a price for a product or variant.
type ProductPrice struct {
	Amount    float64 `json:"amount"`
	Currency  string  `json:"currency,omitempty"`
	Formatted string  `json:"formatted,omitempty"`
}

// ProductAvailability represents stock availability for a product or variant.
type ProductAvailability struct {
	InStock bool   `json:"inStock"`
	Text    string `json:"text,omitempty"`
}

// ProductSale represents sale information for a product variant.
type ProductSale struct {
	OriginalPrice ProductPrice `json:"originalPrice"`
}

// ProductVariant represents a single purchasable variant of a product.
type ProductVariant struct {
	ID           string              `json:"id,omitempty"`
	SKU          string              `json:"sku,omitempty"`
	Title        string              `json:"title,omitempty"`
	Values       map[string]any      `json:"values,omitempty"`
	Price        *ProductPrice       `json:"price,omitempty"`
	Sale         *ProductSale        `json:"sale,omitempty"`
	Availability ProductAvailability `json:"availability"`
	Images       []ProductImage      `json:"images,omitempty"`
}

// PaperResult represents a ranked research paper result.
type PaperResult struct {
	PaperID   string                 `json:"paperId"`
	PrimaryID string                 `json:"primaryId,omitempty"`
	IDs       map[string]interface{} `json:"ids,omitempty"`
	Title     string                 `json:"title,omitempty"`
	Abstract  string                 `json:"abstract,omitempty"`
	Score     *float64               `json:"score,omitempty"`
	Year      *int                   `json:"year,omitempty"`
	Authors   []string               `json:"authors,omitempty"`
	Venue     string                 `json:"venue,omitempty"`
	URL       string                 `json:"url,omitempty"`
	Signals   map[string]interface{} `json:"signals,omitempty"`
}

// PaperMetadata represents paper metadata returned by inspect/read endpoints.
type PaperMetadata struct {
	PaperID     string                 `json:"paperId,omitempty"`
	IDs         map[string]interface{} `json:"ids,omitempty"`
	Title       string                 `json:"title,omitempty"`
	Abstract    string                 `json:"abstract,omitempty"`
	Authors     string                 `json:"authors,omitempty"`
	Categories  []string               `json:"categories,omitempty"`
	CreatedDate string                 `json:"createdDate,omitempty"`
	UpdateDate  string                 `json:"updateDate,omitempty"`
}

// Passage is a relevant paper passage.
type Passage struct {
	Text     string                 `json:"text,omitempty"`
	Section  string                 `json:"section,omitempty"`
	Page     *int                   `json:"page,omitempty"`
	Score    *float64               `json:"score,omitempty"`
	Metadata map[string]interface{} `json:"metadata,omitempty"`
}

// SearchPapersResponse is returned by SearchPapers.
type SearchPapersResponse struct {
	Success bool          `json:"success"`
	Results []PaperResult `json:"results"`
}

// PaperMetadataResponse is returned by InspectPaper.
type PaperMetadataResponse struct {
	Success bool          `json:"success"`
	Paper   PaperMetadata `json:"paper"`
}

// ReadPaperResponse is returned by ReadPaper.
type ReadPaperResponse struct {
	Success  bool          `json:"success"`
	Paper    PaperMetadata `json:"paper"`
	PaperID  string        `json:"paperId,omitempty"`
	Query    string        `json:"query,omitempty"`
	Passages []Passage     `json:"passages,omitempty"`
}

// SimilarPapersResponse is returned by RelatedPapers.
type SimilarPapersResponse struct {
	Success   bool          `json:"success"`
	Results   []PaperResult `json:"results"`
	PoolSize  *int          `json:"poolSize,omitempty"`
	Truncated bool          `json:"truncated"`
	Note      *string       `json:"note,omitempty"`
}

// GitHubSearchItem represents a GitHub research search result.
type GitHubSearchItem struct {
	ResultType   string                 `json:"resultType,omitempty"`
	Repo         string                 `json:"repo,omitempty"`
	URL          string                 `json:"url,omitempty"`
	PageType     string                 `json:"pageType,omitempty"`
	Number       *int                   `json:"number,omitempty"`
	SegmentCount *int                   `json:"segmentCount,omitempty"`
	ReadmeURL    string                 `json:"readmeUrl,omitempty"`
	Title        string                 `json:"title,omitempty"`
	Snippet      string                 `json:"snippet,omitempty"`
	ContentMD    string                 `json:"contentMd,omitempty"`
	Scores       map[string]interface{} `json:"scores,omitempty"`
}

// GitHubSearchResponse is returned by SearchGitHub.
type GitHubSearchResponse struct {
	Success bool               `json:"success"`
	Results []GitHubSearchItem `json:"results"`
}

// Research options for search-like endpoints.
type SearchPapersOptions struct {
	K          *int     `json:"k,omitempty"`
	Authors    []string `json:"authors,omitempty"`
	Categories []string `json:"categories,omitempty"`
	From       string   `json:"from,omitempty"`
	To         string   `json:"to,omitempty"`
}

// ReadPaperOptions configures ReadPaper.
type ReadPaperOptions struct {
	K *int `json:"k,omitempty"`
}

// RelatedPapersOptions configures RelatedPapers.
type RelatedPapersOptions struct {
	Mode   string   `json:"mode,omitempty"`
	K      *int     `json:"k,omitempty"`
	Rerank *bool    `json:"rerank,omitempty"`
	Anchor []string `json:"anchor,omitempty"`
}

// SearchGitHubOptions configures SearchGitHub.
type SearchGitHubOptions struct {
	K *int `json:"k,omitempty"`
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
//
// Goal is an optional natural-language description of what the monitor is
// watching for (max 2000 chars). When set with JudgeEnabled left nil, the
// API auto-enables judging for this monitor.
type MonitorCreateRequest struct {
	Name          string                   `json:"name"`
	Schedule      MonitorSchedule          `json:"schedule"`
	Targets       []map[string]interface{} `json:"targets"`
	Webhook       map[string]interface{}   `json:"webhook,omitempty"`
	Notification  map[string]interface{}   `json:"notification,omitempty"`
	RetentionDays *int                     `json:"retentionDays,omitempty"`
	Goal          *string                  `json:"goal,omitempty"`
	JudgeEnabled  *bool                    `json:"judgeEnabled,omitempty"`
}

// MonitorUpdateRequest updates a scheduled monitor.
//
// Goal and JudgeEnabled follow the same semantics as MonitorCreateRequest;
// leave them nil to keep the existing values.
type MonitorUpdateRequest struct {
	Name          string                   `json:"name,omitempty"`
	Status        string                   `json:"status,omitempty"`
	Schedule      *MonitorSchedule         `json:"schedule,omitempty"`
	Targets       []map[string]interface{} `json:"targets,omitempty"`
	Webhook       map[string]interface{}   `json:"webhook,omitempty"`
	Notification  map[string]interface{}   `json:"notification,omitempty"`
	RetentionDays *int                     `json:"retentionDays,omitempty"`
	Goal          *string                  `json:"goal,omitempty"`
	JudgeEnabled  *bool                    `json:"judgeEnabled,omitempty"`
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
	Goal                     *string                  `json:"goal,omitempty"`
	JudgeEnabled             bool                     `json:"judgeEnabled"`
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

// MonitorJsonFieldDiff is a single field-level diff returned for monitors
// that requested JSON extraction. Keys are field paths in the extracted
// JSON; values describe what changed between the previous and current run.
type MonitorJsonFieldDiff struct {
	Previous interface{} `json:"previous"`
	Current  interface{} `json:"current"`
}

// MonitorPageDiff is the diff payload returned alongside a monitor page
// when its scrape produced a change. The shape depends on what the
// monitor's formats asked for:
//
//   - markdown-only monitors  → Text holds the unified diff and JSON
//     holds the parseDiff AST (a {"files": [...]} object).
//   - JSON-extraction monitors → JSON holds the per-field
//     map[string]MonitorJsonFieldDiff and Text is empty.
//   - mixed (JSON + git-diff) monitors → both fields are populated:
//     JSON is the per-field diff and Text is the markdown sidecar.
//
// JSON is left as interface{} so callers can decode into either of the
// two possible shapes; use json.Unmarshal with a concrete target when
// the monitor's mode is known.
type MonitorPageDiff struct {
	Text string      `json:"text,omitempty"`
	JSON interface{} `json:"json,omitempty"`
}

// MonitorPageSnapshot is the snapshot of the current JSON extraction at
// this run. It is present on JSON and mixed-mode monitors and absent
// for markdown-only monitors.
type MonitorPageSnapshot struct {
	JSON map[string]interface{} `json:"json,omitempty"`
}

// MonitorMeaningfulChange is a single goal-relevant change selected by the
// monitor judge.
type MonitorMeaningfulChange struct {
	Type   string  `json:"type"`
	Before *string `json:"before"`
	After  *string `json:"after"`
	Reason string  `json:"reason"`
}

// MonitorPageJudgment is the judge's verdict on whether a page change is
// meaningful. Populated on monitor check pages when the monitor has a
// goal set and judging is enabled.
type MonitorPageJudgment struct {
	Meaningful        bool                      `json:"meaningful"`
	Confidence        string                    `json:"confidence"`
	Reason            string                    `json:"reason"`
	MeaningfulChanges []MonitorMeaningfulChange `json:"meaningfulChanges"`
}

// MonitorCheckPage is a single page result in a monitor check.
type MonitorCheckPage struct {
	ID               string               `json:"id"`
	TargetID         string               `json:"targetId"`
	URL              string               `json:"url"`
	Status           string               `json:"status"`
	PreviousScrapeID string               `json:"previousScrapeId,omitempty"`
	CurrentScrapeID  string               `json:"currentScrapeId,omitempty"`
	StatusCode       *int                 `json:"statusCode,omitempty"`
	Error            string               `json:"error,omitempty"`
	Metadata         interface{}          `json:"metadata,omitempty"`
	Diff             *MonitorPageDiff     `json:"diff,omitempty"`
	Snapshot         *MonitorPageSnapshot `json:"snapshot,omitempty"`
	Judgment         *MonitorPageJudgment `json:"judgment,omitempty"`
	CreatedAt        string               `json:"createdAt,omitempty"`
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
