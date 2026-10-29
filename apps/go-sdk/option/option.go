// Package option provides functional options for configuring the Firecrawl client.
package option

import (
	"net/http"
	"time"
)

// RequestOption configures an individual request or the client.
type RequestOption func(*RequestConfig)

// RequestConfig holds the configuration for an HTTP request.
type RequestConfig struct {
	APIKey        string
	APIURL        string
	HTTPClient    *http.Client
	MaxRetries    int
	BackoffFactor float64
	ExtraHeaders  map[string]string
}

// WithAPIKey sets the API key. Defaults to the FIRECRAWL_API_KEY environment variable.
func WithAPIKey(key string) RequestOption {
	return func(c *RequestConfig) {
		c.APIKey = key
	}
}

// WithAPIURL sets the API base URL. Defaults to https://api.firecrawl.dev.
func WithAPIURL(url string) RequestOption {
	return func(c *RequestConfig) {
		c.APIURL = url
	}
}

// WithHTTPClient sets a custom *http.Client for all requests.
func WithHTTPClient(client *http.Client) RequestOption {
	return func(c *RequestConfig) {
		c.HTTPClient = client
	}
}

// WithMaxRetries sets the maximum number of automatic retries for transient failures.
// Default: 3.
func WithMaxRetries(n int) RequestOption {
	return func(c *RequestConfig) {
		c.MaxRetries = n
	}
}

// WithBackoffFactor sets the exponential backoff factor in seconds. Default: 0.5.
func WithBackoffFactor(f float64) RequestOption {
	return func(c *RequestConfig) {
		c.BackoffFactor = f
	}
}

// WithTimeout sets the HTTP client timeout. Default: 5 minutes.
func WithTimeout(d time.Duration) RequestOption {
	return func(c *RequestConfig) {
		if c.HTTPClient == nil {
			c.HTTPClient = &http.Client{}
		}
		c.HTTPClient.Timeout = d
	}
}

// WithHeader adds an extra header to all requests.
func WithHeader(key, value string) RequestOption {
	return func(c *RequestConfig) {
		if c.ExtraHeaders == nil {
			c.ExtraHeaders = make(map[string]string)
		}
		c.ExtraHeaders[key] = value
	}
}
