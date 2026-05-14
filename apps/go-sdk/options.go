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
	Integration         *string                  `json:"integration,omitempty"`
	JsonOptions         *JsonOptions             `json:"jsonOptions,omitempty"`
}

// MarshalJSON preserves string formats while allowing object formats such as QuestionFormat.
// When Formats contains "json" and JsonOptions is set, the "json" string entry is replaced
// with a format object embedding the JsonOptions fields, and JsonOptions is omitted from the
// top-level payload.
func (o ScrapeOptions) MarshalJSON() ([]byte, error) {
	// Clear JsonOptions from the copy so it never appears as a top-level field.
	clean := o
	clean.JsonOptions = nil

	type scrapeOptions ScrapeOptions
	payload := struct {
		scrapeOptions
		Formats interface{} `json:"formats,omitempty"`
	}{
		scrapeOptions: scrapeOptions(clean),
	}

	if len(o.FormatOptions) > 0 {
		payload.Formats = o.FormatOptions
	} else if len(o.Formats) > 0 {
		payload.Formats = buildFormats(o.Formats, o.JsonOptions)
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
}

// SearchOptions configures a search request.
type SearchOptions struct {
	Sources           []interface{}  `json:"sources,omitempty"`
	Categories        []interface{}  `json:"categories,omitempty"`
	IncludeDomains    []string       `json:"includeDomains,omitempty"`
	ExcludeDomains    []string       `json:"excludeDomains,omitempty"`
	Limit             *int           `json:"limit,omitempty"`
	TBS               *string        `json:"tbs,omitempty"`
	Location          *string        `json:"location,omitempty"`
	IgnoreInvalidURLs *bool          `json:"ignoreInvalidURLs,omitempty"`
	Timeout           *int           `json:"timeout,omitempty"`
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
	Webhook               *WebhookConfig         `json:"webhook,omitempty"`
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
// When set alongside Formats containing "json", MarshalJSON on
// ScrapeOptions/ParseOptions will embed these fields into the formats array
// as a format object: {"type": "json", "schema": ..., "prompt": ...}.
type JsonOptions struct {
	Prompt string                 `json:"prompt,omitempty"`
	Schema map[string]interface{} `json:"schema,omitempty"`
}

// JsonFormat represents a JSON extraction format entry in the formats array.
// Use this in FormatOptions for explicit control, or set JsonOptions on
// ScrapeOptions for automatic transformation.
type JsonFormat struct {
	Prompt string                 `json:"prompt,omitempty"`
	Schema map[string]interface{} `json:"schema,omitempty"`
}

// MarshalJSON always emits the API-required json format type.
func (j JsonFormat) MarshalJSON() ([]byte, error) {
	type jsonFormat struct {
		Type   string                 `json:"type"`
		Prompt string                 `json:"prompt,omitempty"`
		Schema map[string]interface{} `json:"schema,omitempty"`
	}

	return json.Marshal(jsonFormat{
		Type:   "json",
		Prompt: j.Prompt,
		Schema: j.Schema,
	})
}

// buildFormats transforms a string formats slice into the v2 API format.
// If "json" is present and jsonOpts is non-nil, the "json" entry is replaced
// with a JsonFormat object. Other string entries are preserved as-is.
func buildFormats(formats []string, jsonOpts *JsonOptions) interface{} {
	if jsonOpts == nil {
		return formats
	}

	hasJSON := false
	for _, f := range formats {
		if f == "json" {
			hasJSON = true
			break
		}
	}

	if !hasJSON {
		return formats
	}

	result := make([]interface{}, 0, len(formats))
	for _, f := range formats {
		if f == "json" {
			result = append(result, JsonFormat{
				Prompt: jsonOpts.Prompt,
				Schema: jsonOpts.Schema,
			})
		} else {
			result = append(result, f)
		}
	}
	return result
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
