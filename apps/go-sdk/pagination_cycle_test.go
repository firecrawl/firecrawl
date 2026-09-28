package firecrawl

import (
	"context"
	"errors"
	"fmt"
	"net/http"
	"net/http/httptest"
	"strings"
	"sync/atomic"
	"testing"

	"github.com/firecrawl/firecrawl/apps/go-sdk/option"
)

func TestRepeatedPaginationCursorFailsInsteadOfLooping(t *testing.T) {
	for _, kind := range []string{"crawl", "batch scrape", "monitor"} {
		t.Run(kind, func(t *testing.T) {
			var calls atomic.Int32
			var server *httptest.Server
			server = httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
				if calls.Add(1) > 4 {
					w.WriteHeader(http.StatusBadGateway)
					return
				}
				w.Header().Set("Content-Type", "application/json")
				cursor := server.URL + "/next"
				if kind == "monitor" && r.URL.Path != "/next" {
					_, _ = fmt.Fprintf(w, `{"data":{"pages":[]},"next":%q}`, cursor)
					return
				}
				if kind == "monitor" {
					_, _ = fmt.Fprintf(w, `{"data":{"pages":[]},"next":%q}`, cursor)
				} else {
					_, _ = fmt.Fprintf(w, `{"status":"completed","data":[],"next":%q}`, cursor)
				}
			}))
			defer server.Close()

			client, err := NewClient(option.WithAPIKey("fc-test"), option.WithAPIURL(server.URL), option.WithMaxRetries(0))
			if err != nil {
				t.Fatal(err)
			}
			cursor := server.URL + "/next"
			switch kind {
			case "crawl":
				_, err = client.paginateCrawl(context.Background(), &CrawlJob{Next: cursor})
			case "batch scrape":
				_, err = client.paginateBatchScrape(context.Background(), &BatchScrapeJob{Next: cursor})
			default:
				_, err = client.GetMonitorCheck(context.Background(), "monitor-1", "check-1", nil)
			}

			var apiErr *FirecrawlError
			if !errors.As(err, &apiErr) || !strings.Contains(apiErr.Message, "pagination cursor repeated") {
				t.Fatalf("expected repeated cursor error, got %v", err)
			}
			wantCalls := int32(1)
			if kind == "monitor" {
				wantCalls = 2
			}
			if got := calls.Load(); got != wantCalls {
				t.Fatalf("fetched %d pages, want %d before detecting cycle", got, wantCalls)
			}
		})
	}
}

func TestDistinctPaginationCursorsStillComplete(t *testing.T) {
	var server *httptest.Server
	server = httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Content-Type", "application/json")
		if r.URL.Path == "/first" {
			_, _ = fmt.Fprintf(w, `{"data":[{"markdown":"first"}],"next":%q}`, server.URL+"/second")
			return
		}
		_, _ = w.Write([]byte(`{"data":[{"markdown":"second"}]}`))
	}))
	defer server.Close()

	client, err := NewClient(option.WithAPIKey("fc-test"), option.WithAPIURL(server.URL))
	if err != nil {
		t.Fatal(err)
	}
	job, err := client.paginateCrawl(context.Background(), &CrawlJob{Next: server.URL + "/first"})
	if err != nil || len(job.Data) != 2 || job.Data[1].Markdown != "second" {
		t.Fatalf("distinct cursors should paginate: %#v, %v", job, err)
	}
}
