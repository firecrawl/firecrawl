package firecrawl

import (
	"context"
	"io"
	"net/http"
	"net/http/httptest"
	"net/url"
	"strings"
	"sync/atomic"
	"testing"
)

type testRoundTripper func(*http.Request) (*http.Response, error)

func (f testRoundTripper) RoundTrip(req *http.Request) (*http.Response, error) {
	return f(req)
}

func TestCrawlPaginationRejectsCrossOriginNextURL(t *testing.T) {
	trusted := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		t.Errorf("pagination should not request the trusted server")
	}))
	defer trusted.Close()

	var attackerRequests atomic.Int32
	var leakedAuth atomic.Value
	attacker := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		attackerRequests.Add(1)
		leakedAuth.Store(r.Header.Get("Authorization"))
		w.Header().Set("Content-Type", "application/json")
		_, _ = w.Write([]byte(`{"status":"completed","data":[]}`))
	}))
	defer attacker.Close()

	client := &Client{http: newHTTPClient("secret-key", trusted.URL, trusted.Client(), 0, defaultBackoffFactor, nil)}
	_, err := client.paginateCrawl(context.Background(), &CrawlJob{Next: attacker.URL + "/v2/crawl/job?skip=1"})
	if got := attackerRequests.Load(); got != 0 {
		t.Fatalf("cross-origin server received %d request(s) with Authorization %q", got, leakedAuth.Load())
	}
	if err == nil {
		t.Fatal("expected cross-origin pagination URL to be rejected")
	}
}

func TestCrawlPaginationRejectsURLWithUserinfo(t *testing.T) {
	var requests atomic.Int32
	trusted := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		requests.Add(1)
		_, _ = w.Write([]byte(`{"status":"completed","data":[]}`))
	}))
	defer trusted.Close()

	pageURL, err := url.Parse(trusted.URL + "/v2/crawl/job?skip=1")
	if err != nil {
		t.Fatal(err)
	}
	pageURL.User = url.UserPassword("untrusted", "secret")

	client := &Client{http: newHTTPClient("secret-key", trusted.URL, trusted.Client(), 0, defaultBackoffFactor, nil)}
	_, err = client.paginateCrawl(context.Background(), &CrawlJob{Next: pageURL.String()})
	if err == nil {
		t.Fatal("expected pagination URL with userinfo to be rejected")
	}
	if got := requests.Load(); got != 0 {
		t.Fatalf("server received %d request(s) for rejected URL", got)
	}
}

func TestCrawlPaginationAllowsConfiguredAPIOrigin(t *testing.T) {
	var requests atomic.Int32
	trusted := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		requests.Add(1)
		if got := r.Header.Get("Authorization"); got != "Bearer secret-key" {
			t.Errorf("Authorization = %q, want configured API credential", got)
		}
		w.Header().Set("Content-Type", "application/json")
		_, _ = w.Write([]byte(`{"status":"completed","data":[]}`))
	}))
	defer trusted.Close()

	client := &Client{http: newHTTPClient("secret-key", trusted.URL, trusted.Client(), 0, defaultBackoffFactor, nil)}
	_, err := client.paginateCrawl(context.Background(), &CrawlJob{Next: trusted.URL + "/v2/crawl/job?skip=1"})
	if err != nil {
		t.Fatalf("same-origin pagination failed: %v", err)
	}
	if got := requests.Load(); got != 1 {
		t.Fatalf("same-origin request count = %d, want 1", got)
	}
}

func TestPaginationAllowsExplicitDefaultPort(t *testing.T) {
	cases := []struct {
		name, apiURL, nextURL string
	}{
		{"https next has explicit port", "https://api.example.test", "https://api.example.test:443/v2/crawl/job?skip=1"},
		{"https API has explicit port", "https://api.example.test:443", "https://api.example.test/v2/crawl/job?skip=1"},
		{"http next has explicit port", "http://api.example.test", "http://api.example.test:80/v2/crawl/job?skip=1"},
		{"http API has explicit port", "http://api.example.test:80", "http://api.example.test/v2/crawl/job?skip=1"},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			requests := 0
			transport := testRoundTripper(func(req *http.Request) (*http.Response, error) {
				requests++
				return &http.Response{StatusCode: 200, Body: io.NopCloser(strings.NewReader(`{}`)), Header: make(http.Header)}, nil
			})
			client := newHTTPClient("secret-key", tc.apiURL, &http.Client{Transport: transport}, 0, defaultBackoffFactor, nil)
			if _, err := client.getAbsolute(context.Background(), tc.nextURL); err != nil {
				t.Fatalf("same-origin pagination URL rejected: %v", err)
			}
			if requests != 1 {
				t.Fatalf("request count = %d, want 1", requests)
			}
		})
	}
}
