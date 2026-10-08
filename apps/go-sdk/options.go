package firecrawl

import "encoding/json"

// QueryFormatMode selects how deprecated query answers are generated.
type QueryFormatMode string

const (
	QueryModeFreeform    QueryFormatMode = "freeform"
	QueryModeDirectQuote QueryFormatMode = "directQuote"
)

// QuestionFormat asks a question about page content.
type QuestionFormat struct {
	Question string `json:"question"`
}

// MarshalJSON always emits the API-required question format type.
func (q QuestionFormat) MarshalJSON() ([]byte, error) {
	type questionFormat struct {
		Type     string `json:"type"`
		Question string `json:"question"`
	}

	return json.Marshal(questionFormat{
		Type:     "question",
		Question: q.Question,
	})
}

// HighlightsFormat extracts direct highlights from page content.
type HighlightsFormat struct {
	Query string `json:"query"`
}

// MarshalJSON always emits the API-required highlights format type.
func (h HighlightsFormat) MarshalJSON() ([]byte, error) {
	type highlightsFormat struct {
		Type  string `json:"type"`
		Query string `json:"query"`
	}

	return json.Marshal(highlightsFormat{
		Type:  "highlights",
		Query: h.Query,
	})
}

// QueryFormat asks a question about page content.
//
// Deprecated: use QuestionFormat or HighlightsFormat instead.
type QueryFormat struct {
	Prompt string          `json:"prompt"`
	Mode   QueryFormatMode `json:"mode,omitempty"`
}

// MarshalJSON always emits the API-required query format type.
func (q QueryFormat) MarshalJSON() ([]byte, error) {
	type queryFormat struct {
		Type   string          `json:"type"`
		Prompt string          `json:"prompt"`
		Mode   QueryFormatMode `json:"mode,omitempty"`
	}

	return json.Marshal(queryFormat{
		Type:   "query",
		Prompt: q.Prompt,
		Mode:   q.Mode,
	})
}

// ScrapeOptions configures a single-page scrape request.
type ScrapeOptions struct {
	Formats             []string                 `json:"-"`
	FormatOptions       []interface{}            `json:"-"`
	Headers             map[string]string        `json:"headers,omitempty"`
	IncludeTags         []string                 `json:"includeTags,omitempty"`
	ExcludeTags         []string                 `json:"excludeTags,omitempty"`
	OnlyMainContent     *bool                    `json:"onlyMainContent,omitempty"`
	Timeout             *int                     `json:"timeout,omitempty"`
	WaitFor             *int                     `json:"waitFor,omitempty"`
	Mobile              *bool                    `json:"mobile,omitempty"`
	Parsers             []interface{}            `json:"parsers,omitempty"`
	Actions             []map[string]interface{} `json:"actions,omitempty"`
	Location            *LocationConfig          `json:"location,omitempty"`
	SkipTLSVerification *bool                    `json:"skipTlsVerification,omitempty"`
	RemoveBase64Images  *bool                    `json:"removeBase64Images,omitempty"`
	BlockAds            *bool                    `json:"blockAds,omitempty"`
	Proxy               *string                  `json:"proxy,omitempty"`
	MaxAge              *int64                   `json:"maxAge,omitempty"`
	StoreInCache        *bool                    `json:"storeInCache,omitempty"`
	Lockdown            *bool                    `json:"lockdown,omitempty"`
	RedactPII           *bool                    `json:"redactPII,omitempty"`
	AuditMetadata       *AuditMetadata           `json:"auditMetadata,omitempty"`
	Integration         *string                  `json:"integration,omitempty"`
	JsonOptions         *JsonOptions             `json:"jsonOptions,omitempty"`
	DomainTools         *bool                    `json:"domainTools,omitempty"`
	// CheckPromptInjection scans the page content for prompt injection with any
	// format except rawBase64, before LLM-backed formats run. A detection fails
	// the scrape with SCRAPE_PROMPT_INJECTION_DETECTED. Adds 4 credits when the
	// check scans the whole page.
	CheckPromptInjection *bool `json:"checkPromptInjection,omitempty"`
}

// MarshalJSON preserves string formats while allowing object formats such as QuestionFormat.
func (o ScrapeOptions) MarshalJSON() ([]byte, error) {
	type scrapeOptions ScrapeOptions
	payload := struct {
		scrapeOptions
		Formats interface{} `json:"formats,omitempty"`
	}{
		scrapeOptions: scrapeOptions(o),
	}

	if len(o.FormatOptions) > 0 {
		payload.Formats = o.FormatOptions
	} else if len(o.Formats) > 0 {
		payload.Formats = o.Formats
	}

	return json.Marshal(payload)
}

// CrawlOptions configures a crawl request.
type CrawlOptions struct {
	Prompt                 *string        `json:"prompt,omitempty"`
	ExcludePaths           []string       `json:"excludePaths,omitempty"`
	IncludePaths           []string       `json:"includePaths,omitempty"`
	MaxDiscoveryDepth      *int           `json:"maxDiscoveryDepth,omitempty"`
	Sitemap                *string        `json:"sitemap,omitempty"`
	IgnoreQueryParameters  *bool          `json:"ignoreQueryParameters,omitempty"`
	DeduplicateSimilarURLs *bool          `json:"deduplicateSimilarURLs,omitempty"`
	Limit                  *int           `json:"limit,omitempty"`
	CrawlEntireDomain      *bool          `json:"crawlEntireDomain,omitempty"`
	AllowExternalLinks     *bool          `json:"allowExternalLinks,omitempty"`
	AllowSubdomains        *bool          `json:"allowSubdomains,omitempty"`
	Delay                  *int           `json:"delay,omitempty"`
	MaxConcurrency         *int           `json:"maxConcurrency,omitempty"`
	Webhook                interface{}    `json:"webhook,omitempty"`
	ScrapeOptions          *ScrapeOptions `json:"scrapeOptions,omitempty"`
	RegexOnFullURL         *bool          `json:"regexOnFullURL,omitempty"`
	ZeroDataRetention      *bool          `json:"zeroDataRetention,omitempty"`
	Integration            *string        `json:"integration,omitempty"`
}

// BatchScrapeOptions configures a batch scrape request.
type BatchScrapeOptions struct {
	ScrapeOptions     *ScrapeOptions `json:"options,omitempty"`
	Webhook           interface{}    `json:"webhook,omitempty"`
	AppendToID        *string        `json:"appendToId,omitempty"`
	IgnoreInvalidURLs *bool          `json:"ignoreInvalidURLs,omitempty"`
	MaxConcurrency    *int           `json:"maxConcurrency,omitempty"`
	ZeroDataRetention *bool          `json:"zeroDataRetention,omitempty"`
	IdempotencyKey    *string        `json:"-"` // Sent as HTTP header, not in body
	Integration       *string        `json:"integration,omitempty"`
}

// MapOptions configures a map (URL discovery) request.
type MapOptions struct {
	Search                *string         `json:"search,omitempty"`
	Sitemap               *string         `json:"sitemap,omitempty"`
	IncludeSubdomains     *bool           `json:"includeSubdomains,omitempty"`
	IgnoreQueryParameters *bool           `json:"ignoreQueryParameters,omitempty"`
	Limit                 *int            `json:"limit,omitempty"`
	Timeout               *int            `json:"timeout,omitempty"`
	Integration           *string         `json:"integration,omitempty"`
	Location              *LocationConfig `json:"location,omitempty"`
	AuditMetadata         *AuditMetadata  `json:"auditMetadata,omitempty"`
}

// SearchOptions configures a search request.
type SearchOptions struct {
	DomainTools       *bool          `json:"domainTools,omitempty"`
	Sources           []interface{}  `json:"sources,omitempty"`
	Categories        []interface{}  `json:"categories,omitempty"`
	IncludeDomains    []string       `json:"includeDomains,omitempty"`
	ExcludeDomains    []string       `json:"excludeDomains,omitempty"`
	Limit             *int           `json:"limit,omitempty"`
	TBS               *string        `json:"tbs,omitempty"`
	Location          *string        `json:"location,omitempty"`
	Country           *string        `json:"country,omitempty"`
	IgnoreInvalidURLs *bool          `json:"ignoreInvalidURLs,omitempty"`
	Timeout           *int           `json:"timeout,omitempty"`
	Highlights        *bool          `json:"highlights,omitempty"`
	ScrapeOptions     *ScrapeOptions `json:"scrapeOptions,omitempty"`
	Integration       *string        `json:"integration,omitempty"`
}

// AgentOptions configures an agent request.
type AgentOptions struct {
	URLs                  []string               `json:"urls,omitempty"`
	Prompt                string                 `json:"prompt"`
	Schema                map[string]interface{} `json:"schema,omitempty"`
	Integration           *string                `json:"integration,omitempty"`
	MaxCredits            *int                   `json:"maxCredits,omitempty"`
	StrictConstrainToURLs *bool                  `json:"strictConstrainToURLs,omitempty"`
	Model                 *string                `json:"model,omitempty"`
	// Effort sets the reasoning budget for the agent. Valid values are "low",
	// "medium", and "high". Every effort level runs spark-2.
	Effort        *string        `json:"effort,omitempty"`
	Webhook       *WebhookConfig `json:"webhook,omitempty"`
	AuditMetadata *AuditMetadata `json:"auditMetadata,omitempty"`
	// ThreadID continues an existing thread as its next turn. Nil starts a new
	// thread.
	ThreadID *string `json:"threadId,omitempty"`
	// Mode is "extract" or "chat".
	Mode *string `json:"mode,omitempty"`
	// Exchange lets the agent call Exchange data providers. Nil on a follow-up
	// turn inherits the previous turn's settings.
	Exchange *AgentExchangeOptions `json:"exchange,omitempty"`
}

// AgentExchangeOptions configures Exchange for an agent run. Every field is
// optional and the server owns the defaults.
type AgentExchangeOptions struct {
	Enabled *bool `json:"enabled,omitempty"`
	// Toolkits pins up to 5 provider slugs. An empty list means every provider
	// the team can use; nil inherits the previous turn's pin.
	Toolkits *[]string `json:"toolkits,omitempty"`
	MaxCalls *int      `json:"maxCalls,omitempty"`
	// RequireApproval ends the turn with a PendingApproval before a paid
	// provider call. It needs Mode "chat" on the same request.
	RequireApproval *bool `json:"requireApproval,omitempty"`
	// Approve and Decline answer the previous turn's PendingApproval, so they
	// need ThreadID.
	Approve *AgentExchangeApprove `json:"approve,omitempty"`
	Decline *AgentExchangeDecline `json:"decline,omitempty"`
	// OnTermsRequired is "skip" or "ask".
	OnTermsRequired *string `json:"onTermsRequired,omitempty"`
}

// AgentExchangeApprove approves a pending approval. CallIDs and Always are
// ignored on a terms approval.
type AgentExchangeApprove struct {
	ApprovalID string `json:"approvalId"`
	// CallIDs approves a subset of the pending calls. Nil approves all of
	// them; an empty list approves none.
	CallIDs *[]string `json:"callIds,omitempty"`
	Always  *bool     `json:"always,omitempty"`
}

// AgentExchangeDecline declines a pending approval.
type AgentExchangeDecline struct {
	ApprovalID string `json:"approvalId"`
}

// AuditMetadata identifies the user associated with a SIEM logging event.
type AuditMetadata struct {
	Username string `json:"username"`
}

// LocationConfig specifies geolocation for requests.
type LocationConfig struct {
	Country   string   `json:"country,omitempty"`
	Languages []string `json:"languages,omitempty"`
}

// WebhookConfig configures webhook notifications.
type WebhookConfig struct {
	URL      string            `json:"url"`
	Headers  map[string]string `json:"headers,omitempty"`
	Metadata map[string]string `json:"metadata,omitempty"`
	Events   []string          `json:"events,omitempty"`
}

// JsonOptions configures JSON extraction within formats.
type JsonOptions struct {
	Prompt string                 `json:"prompt,omitempty"`
	Schema map[string]interface{} `json:"schema,omitempty"`
	// Deprecated: Use ScrapeOptions.CheckPromptInjection or ParseOptions.CheckPromptInjection.
	CheckPromptInjection *bool `json:"checkPromptInjection,omitempty"`
}

// Pointer helpers for optional fields.

// Bool returns a pointer to the given bool value.
func Bool(v bool) *bool { return &v }

// Int returns a pointer to the given int value.
func Int(v int) *int { return &v }

// Int64 returns a pointer to the given int64 value.
func Int64(v int64) *int64 { return &v }

// String returns a pointer to the given string value.
func String(v string) *string { return &v }

// Float64 returns a pointer to the given float64 value.
func Float64(v float64) *float64 { return &v }
