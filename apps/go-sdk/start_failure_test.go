package firecrawl

import (
	"context"
	"errors"
	"net/http"
	"net/http/httptest"
	"strings"
	"sync/atomic"
	"testing"

	"github.com/firecrawl/firecrawl/apps/go-sdk/option"
)

func TestJobStartRejectsUnsuccessfulEnvelope(t *testing.T) {
	for _, kind := range []string{"crawl", "batch"} {
		for _, test := range []struct {
			name    string
			body    string
			message string
		}{
			{"explicit failure", `{"success":false,"error":"insufficient credits"}`, "insufficient credits"},
			{"failure with ID", `{"success":false,"id":"job-1","error":"job was rejected"}`, "job was rejected"},
			{"failure without explanation", `{"success":false,"id":"job-1"}`, "start response was unsuccessful"},
			{"missing ID", `{}`, "contained no job ID"},
		} {
			t.Run(kind+"/"+test.name, func(t *testing.T) {
				var calls atomic.Int32
				server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
					calls.Add(1)
					w.Header().Set("Content-Type", "application/json")
					_, _ = w.Write([]byte(test.body))
				}))
				defer server.Close()

				client, err := NewClient(option.WithAPIKey("fc-test"), option.WithAPIURL(server.URL))
				if err != nil {
					t.Fatal(err)
				}
				if kind == "crawl" {
					_, err = client.CrawlWithPolling(context.Background(), "https://example.com", nil, 0, 5)
				} else {
					_, err = client.BatchScrapeWithPolling(context.Background(), []string{"https://example.com"}, nil, 0, 5)
				}

				var apiErr *FirecrawlError
				if !errors.As(err, &apiErr) || !strings.Contains(apiErr.Message, test.message) {
					t.Fatalf("lost start failure detail: %v", err)
				}
				if got := calls.Load(); got != 1 {
					t.Fatalf("sent %d requests after failed kickoff; want only POST", got)
				}
			})
		}
	}
}

func TestJobStartAcceptsSuccessfulEnvelope(t *testing.T) {
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Content-Type", "application/json")
		_, _ = w.Write([]byte(`{"success":true,"id":"job-1"}`))
	}))
	defer server.Close()

	client, err := NewClient(option.WithAPIKey("fc-test"), option.WithAPIURL(server.URL))
	if err != nil {
		t.Fatal(err)
	}
	crawl, err := client.StartCrawl(context.Background(), "https://example.com", nil)
	if err != nil || crawl.ID != "job-1" {
		t.Fatalf("crawl start: %#v, %v", crawl, err)
	}
	batch, err := client.StartBatchScrape(context.Background(), []string{"https://example.com"}, nil)
	if err != nil || batch.ID != "job-1" {
		t.Fatalf("batch start: %#v, %v", batch, err)
	}
}
