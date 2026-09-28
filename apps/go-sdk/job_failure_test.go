package firecrawl

import (
	"context"
	"errors"
	"fmt"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"

	"github.com/firecrawl/firecrawl/apps/go-sdk/option"
)

func TestPollingReturnsErrorForTerminalFailure(t *testing.T) {
	for _, kind := range []string{"crawl", "batch"} {
		for _, status := range []string{"failed", "cancelled"} {
			t.Run(kind+"/"+status, func(t *testing.T) {
				server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
					w.Header().Set("Content-Type", "application/json")
					if r.Method == http.MethodPost {
						_, _ = w.Write([]byte(`{"success":true,"id":"job-1"}`))
						return
					}
					_, _ = fmt.Fprintf(w, `{"status":%q,"error":"source unavailable","data":[{"markdown":"partial"}]}`, status)
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

				var failed *JobFailedError
				if !errors.As(err, &failed) {
					t.Fatalf("expected JobFailedError, got %v", err)
				}
				if failed.JobID != "job-1" || failed.Status != status || !strings.Contains(failed.Error(), "source unavailable") {
					t.Fatalf("lost terminal failure detail: %+v", failed)
				}
				if kind == "crawl" {
					job, ok := failed.Job.(*CrawlJob)
					if !ok || len(job.Data) != 1 || job.Data[0].Markdown != "partial" {
						t.Fatalf("lost partial crawl result: %#v", failed.Job)
					}
				} else {
					job, ok := failed.Job.(*BatchScrapeJob)
					if !ok || len(job.Data) != 1 || job.Data[0].Markdown != "partial" {
						t.Fatalf("lost partial batch result: %#v", failed.Job)
					}
				}
			})
		}
	}
}

func TestPollingReturnsCompletedJob(t *testing.T) {
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Content-Type", "application/json")
		if r.Method == http.MethodPost {
			_, _ = w.Write([]byte(`{"success":true,"id":"job-1"}`))
			return
		}
		_, _ = w.Write([]byte(`{"status":"completed","data":[{"markdown":"done"}]}`))
	}))
	defer server.Close()

	client, err := NewClient(option.WithAPIKey("fc-test"), option.WithAPIURL(server.URL))
	if err != nil {
		t.Fatal(err)
	}
	job, err := client.CrawlWithPolling(context.Background(), "https://example.com", nil, 0, 5)
	if err != nil || job.Status != "completed" || len(job.Data) != 1 {
		t.Fatalf("completed job: %#v, %v", job, err)
	}
}
