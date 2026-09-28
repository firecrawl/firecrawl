package firecrawl

import (
	"context"
	"net/http"
	"net/http/httptest"
	"sync/atomic"
	"testing"
)

func TestCrawlPaginationRejectsCrossOriginNextURL(t *testing.T) {
	trusted := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		t.Fatal("pagination should not request the trusted server")
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
