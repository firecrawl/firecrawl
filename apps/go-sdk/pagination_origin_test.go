package firecrawl

import (
	"context"
	"fmt"
	"net/http"
	"net/http/httptest"
	"strings"
	"sync"
	"testing"

	"github.com/firecrawl/firecrawl/apps/go-sdk/option"
)

func TestPinToAPIOrigin(t *testing.T) {
	cases := []struct {
		name   string
		apiURL string
		next   string
		want   string
	}{
		{"same origin", "https://api.firecrawl.dev", "https://api.firecrawl.dev/v2/crawl/abc?skip=10", "https://api.firecrawl.dev/v2/crawl/abc?skip=10"},
		{"cross host", "https://api.firecrawl.dev", "https://evil.example/v2/crawl/abc?skip=10", "https://api.firecrawl.dev/v2/crawl/abc?skip=10"},
		{"protocol relative", "https://api.firecrawl.dev", "//evil.example/v2/crawl/abc?skip=10", "https://api.firecrawl.dev/v2/crawl/abc?skip=10"},
		{"different port", "https://api.firecrawl.dev", "https://api.firecrawl.dev:8443/v2/crawl/abc", "https://api.firecrawl.dev/v2/crawl/abc"},
		{"different scheme", "https://api.firecrawl.dev", "http://api.firecrawl.dev/v2/crawl/abc", "https://api.firecrawl.dev/v2/crawl/abc"},
		{"self-hosted http api url", "http://localhost:3002", "https://evil.example/v2/crawl/abc?skip=10", "http://localhost:3002/v2/crawl/abc?skip=10"},
		{"userinfo and fragment dropped", "https://api.firecrawl.dev", "https://user:pass@evil.example/v2/crawl/abc?skip=10#frag", "https://api.firecrawl.dev/v2/crawl/abc?skip=10"},
		{"empty path", "https://api.firecrawl.dev", "https://evil.example", "https://api.firecrawl.dev/"},
		{"relative path", "https://api.firecrawl.dev", "/v2/crawl/abc?skip=10", "https://api.firecrawl.dev/v2/crawl/abc?skip=10"},
		{"relative path with api url prefix", "https://proxy.example/firecrawl", "v2/crawl/abc?skip=10", "https://proxy.example/firecrawl/v2/crawl/abc?skip=10"},
		{"relative path with escaped api url prefix", "https://proxy.example/a%2Fb", "v2/crawl/abc", "https://proxy.example/a%2Fb/v2/crawl/abc"},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			got, err := pinToAPIOrigin(tc.apiURL, tc.next)
			if err != nil {
				t.Fatalf("pinToAPIOrigin: %v", err)
			}
			if got != tc.want {
				t.Errorf("pinToAPIOrigin(%q, %q) = %q, want %q", tc.apiURL, tc.next, got, tc.want)
			}
		})
	}
}

func TestPinToAPIOriginRejectsRelativeAPIURL(t *testing.T) {
	for _, apiURL := range []string{"localhost:3002", "/v2", ""} {
		if _, err := pinToAPIOrigin(apiURL, "https://evil.example/v2/crawl/abc"); err == nil {
			t.Errorf("pinToAPIOrigin(%q, ...) returned no error", apiURL)
		}
	}
}

// recordingTransport records every outgoing request and only forwards those
// addressed to the test server, so tests can assert that no request was aimed
// at a foreign host without ever reaching the real network.
type recordingTransport struct {
	apiHost  string
	mu       sync.Mutex
	requests []*http.Request
}

func (rt *recordingTransport) RoundTrip(r *http.Request) (*http.Response, error) {
	rt.mu.Lock()
	rt.requests = append(rt.requests, r.Clone(r.Context()))
	rt.mu.Unlock()
	if r.URL.Scheme != "http" || r.URL.Host != rt.apiHost {
		return nil, fmt.Errorf("refusing request outside the test server origin: %s", r.URL)
	}
	return http.DefaultTransport.RoundTrip(r)
}

func (rt *recordingTransport) snapshot() []*http.Request {
	rt.mu.Lock()
	defer rt.mu.Unlock()
	return append([]*http.Request(nil), rt.requests...)
}

type paginationFollower struct {
	name     string
	pagePath string
	route    func(w http.ResponseWriter, r *http.Request, next string) bool
	run      func(ctx context.Context, c *Client) (int, error)
}

var paginationFollowers = []paginationFollower{
	{
		name:     "crawl",
		pagePath: "/v2/crawl/abc",
		route: func(w http.ResponseWriter, r *http.Request, next string) bool {
			switch {
			case r.Method == http.MethodPost && r.URL.Path == "/v2/crawl":
				_, _ = w.Write([]byte(`{"success":true,"id":"abc"}`))
			case r.URL.Path == "/v2/crawl/abc" && r.URL.Query().Get("skip") == "":
				_, _ = w.Write([]byte(`{"status":"completed","data":[{"markdown":"one"}],"next":"` + next + `"}`))
			default:
				return false
			}
			return true
		},
		run: func(ctx context.Context, c *Client) (int, error) {
			job, err := c.CrawlWithPolling(ctx, "https://example.com", nil, 1, 30)
			if err != nil {
				return 0, err
			}
			return len(job.Data), nil
		},
	},
	{
		name:     "batch scrape",
		pagePath: "/v2/batch/scrape/abc",
		route: func(w http.ResponseWriter, r *http.Request, next string) bool {
			switch {
			case r.Method == http.MethodPost && r.URL.Path == "/v2/batch/scrape":
				_, _ = w.Write([]byte(`{"success":true,"id":"abc"}`))
			case r.URL.Path == "/v2/batch/scrape/abc" && r.URL.Query().Get("skip") == "":
				_, _ = w.Write([]byte(`{"status":"completed","data":[{"markdown":"one"}],"next":"` + next + `"}`))
			default:
				return false
			}
			return true
		},
		run: func(ctx context.Context, c *Client) (int, error) {
			job, err := c.BatchScrapeWithPolling(ctx, []string{"https://example.com"}, nil, 1, 30)
			if err != nil {
				return 0, err
			}
			return len(job.Data), nil
		},
	},
	{
		name:     "monitor check",
		pagePath: "/v2/monitor/m1/checks/c1",
		route: func(w http.ResponseWriter, r *http.Request, next string) bool {
			if r.URL.Path != "/v2/monitor/m1/checks/c1" || r.URL.Query().Get("skip") != "" {
				return false
			}
			_, _ = w.Write([]byte(`{"success":true,"data":{"id":"c1","pages":[{"url":"https://example.com/one"}]},"next":"` + next + `"}`))
			return true
		},
		run: func(ctx context.Context, c *Client) (int, error) {
			detail, err := c.GetMonitorCheck(ctx, "m1", "c1", nil)
			if err != nil {
				return 0, err
			}
			return len(detail.Pages), nil
		},
	},
}

func TestPaginationNextURLPinnedToAPIOrigin(t *testing.T) {
	nextForms := []struct {
		name string
		next func(apiHost string) string
	}{
		{"same origin", func(apiHost string) string { return "http://" + apiHost }},
		{"cross host", func(string) string { return "https://evil.example" }},
		{"protocol relative", func(string) string { return "//evil.example" }},
		{"different port", func(apiHost string) string { return "http://" + strings.Split(apiHost, ":")[0] + ":1" }},
		{"different scheme", func(apiHost string) string { return "https://" + apiHost }},
		{"relative", func(string) string { return "" }},
	}

	for _, f := range paginationFollowers {
		for _, form := range nextForms {
			t.Run(f.name+"/"+form.name, func(t *testing.T) {
				var next string
				server := httptest.NewUnstartedServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
					w.Header().Set("Content-Type", "application/json")
					if f.route(w, r, next) {
						return
					}
					if r.URL.Path == f.pagePath && r.URL.Query().Get("skip") == "10" {
						if f.name == "monitor check" {
							_, _ = w.Write([]byte(`{"success":true,"data":{"id":"c1","pages":[{"url":"https://example.com/two"}]}}`))
						} else {
							_, _ = w.Write([]byte(`{"status":"completed","data":[{"markdown":"two"}]}`))
						}
						return
					}
					w.WriteHeader(http.StatusNotFound)
					_, _ = w.Write([]byte(`{"error":"unexpected ` + r.Method + ` ` + r.URL.String() + `"}`))
				}))
				apiHost := server.Listener.Addr().String()
				next = form.next(apiHost) + f.pagePath + "?skip=10"
				server.Start()
				defer server.Close()

				transport := &recordingTransport{apiHost: apiHost}
				client, err := NewClient(
					option.WithAPIKey("fc-test"),
					option.WithAPIURL(server.URL),
					option.WithHTTPClient(&http.Client{Transport: transport}),
					option.WithMaxRetries(0),
				)
				if err != nil {
					t.Fatalf("NewClient: %v", err)
				}

				count, err := f.run(context.Background(), client)
				if err != nil {
					t.Fatalf("%s: %v", f.name, err)
				}
				if count != 2 {
					t.Errorf("got %d items, want 2 (both pages)", count)
				}

				var followed *http.Request
				for _, r := range transport.snapshot() {
					if r.URL.Scheme != "http" || r.URL.Host != apiHost {
						t.Errorf("request sent outside the API origin: %s", r.URL)
					}
					if r.URL.Path == f.pagePath && r.URL.Query().Get("skip") == "10" {
						followed = r
					}
				}
				if followed == nil {
					t.Fatalf("next page %q was not requested from the API origin", next)
				}
				if got := followed.Header.Get("Authorization"); got != "Bearer fc-test" {
					t.Errorf("Authorization = %q, want Bearer fc-test", got)
				}
			})
		}
	}
}
