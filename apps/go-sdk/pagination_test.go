package firecrawl

import (
	"context"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"testing"
)

func TestPaginateCrawlClearsConsumedNextCursor(t *testing.T) {
	var server *httptest.Server
	server = httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Content-Type", "application/json")
		switch r.URL.Path {
		case "/crawl/page-2":
			_ = json.NewEncoder(w).Encode(CrawlJob{
				Data: []Document{{Markdown: "page 2"}},
				Next: server.URL + "/crawl/page-3",
			})
		case "/crawl/page-3":
			_ = json.NewEncoder(w).Encode(CrawlJob{Data: []Document{{Markdown: "page 3"}}})
		default:
			http.NotFound(w, r)
		}
	}))
	t.Cleanup(server.Close)

	client := &Client{
		http: newHTTPClient("", server.URL, server.Client(), 0, 0, nil),
	}
	job := &CrawlJob{
		Data: []Document{{Markdown: "page 1"}},
		Next: server.URL + "/crawl/page-2",
	}

	result, err := client.paginateCrawl(context.Background(), job)
	if err != nil {
		t.Fatalf("paginateCrawl returned an error: %v", err)
	}
	if len(result.Data) != 3 {
		t.Fatalf("expected 3 documents, got %d", len(result.Data))
	}
	if result.Next != "" {
		t.Fatalf("expected consumed next cursor to be cleared, got %q", result.Next)
	}
}

func TestPaginateBatchScrapeClearsConsumedNextCursor(t *testing.T) {
	var server *httptest.Server
	server = httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Content-Type", "application/json")
		switch r.URL.Path {
		case "/batch/page-2":
			_ = json.NewEncoder(w).Encode(BatchScrapeJob{
				Data: []Document{{Markdown: "page 2"}},
				Next: server.URL + "/batch/page-3",
			})
		case "/batch/page-3":
			_ = json.NewEncoder(w).Encode(BatchScrapeJob{Data: []Document{{Markdown: "page 3"}}})
		default:
			http.NotFound(w, r)
		}
	}))
	t.Cleanup(server.Close)

	client := &Client{
		http: newHTTPClient("", server.URL, server.Client(), 0, 0, nil),
	}
	job := &BatchScrapeJob{
		Data: []Document{{Markdown: "page 1"}},
		Next: server.URL + "/batch/page-2",
	}

	result, err := client.paginateBatchScrape(context.Background(), job)
	if err != nil {
		t.Fatalf("paginateBatchScrape returned an error: %v", err)
	}
	if len(result.Data) != 3 {
		t.Fatalf("expected 3 documents, got %d", len(result.Data))
	}
	if result.Next != "" {
		t.Fatalf("expected consumed next cursor to be cleared, got %q", result.Next)
	}
}
