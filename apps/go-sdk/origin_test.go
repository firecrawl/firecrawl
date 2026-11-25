package firecrawl

import (
	"context"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"testing"

	"github.com/firecrawl/firecrawl/apps/go-sdk/option"
)

func TestJobStartsSendSDKOrigin(t *testing.T) {
	cases := []struct {
		name     string
		path     string
		response string
		call     func(*Client) error
	}{
		{
			name:     "StartCrawl",
			path:     "/v2/crawl",
			response: `{"success":true,"id":"crawl-1","url":"https://api.firecrawl.dev/v2/crawl/crawl-1"}`,
			call: func(c *Client) error {
				_, err := c.StartCrawl(context.Background(), "https://example.com", &CrawlOptions{Limit: Int(5)})
				return err
			},
		},
		{
			name:     "StartBatchScrape",
			path:     "/v2/batch/scrape",
			response: `{"success":true,"id":"batch-1","url":"https://api.firecrawl.dev/v2/batch/scrape/batch-1"}`,
			call: func(c *Client) error {
				_, err := c.StartBatchScrape(context.Background(), []string{"https://example.com"}, &BatchScrapeOptions{
					ScrapeOptions: &ScrapeOptions{Formats: []string{"markdown"}},
				})
				return err
			},
		},
		{
			name:     "Map",
			path:     "/v2/map",
			response: `{"success":true,"links":[]}`,
			call: func(c *Client) error {
				_, err := c.Map(context.Background(), "https://example.com", nil)
				return err
			},
		},
	}

	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			captured := make(chan capturedRequest, 1)
			server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
				captured <- captureRequest(r)
				w.Header().Set("Content-Type", "application/json")
				_, _ = w.Write([]byte(tc.response))
			}))
			defer server.Close()

			client, err := NewClient(option.WithAPIKey("fc-test"), option.WithAPIURL(server.URL))
			if err != nil {
				t.Fatalf("NewClient: %v", err)
			}
			if err := tc.call(client); err != nil {
				t.Fatalf("%s: %v", tc.name, err)
			}

			req := <-captured
			if req.path != tc.path {
				t.Errorf("path = %q, want %q", req.path, tc.path)
			}
			var body map[string]interface{}
			if err := json.Unmarshal([]byte(req.body), &body); err != nil {
				t.Fatalf("decode body %q: %v", req.body, err)
			}
			if got, want := body["origin"], "go-sdk@"+Version; got != want {
				t.Errorf("origin = %v, want %q", got, want)
			}
		})
	}
}
