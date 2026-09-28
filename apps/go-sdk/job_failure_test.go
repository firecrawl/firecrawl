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
				reason := "source unavailable"
				errorField := `,"error":"source unavailable"`
				if status == "cancelled" {
					errorField = ""
					reason = kind + " did not complete"
					if kind == "batch" {
						reason = "batch scrape did not complete"
					}
				}
				server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
					w.Header().Set("Content-Type", "application/json")
					if r.Method == http.MethodPost {
						_, _ = w.Write([]byte(`{"success":true,"id":"job-1"}`))
						return
					}
					_, _ = fmt.Fprintf(w, `{"status":%q%s,"data":[{"markdown":"partial"}]}`, status, errorField)
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
				if failed.JobID != "job-1" || failed.Status != status || !strings.Contains(failed.Error(), reason) {
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
	batch, err := client.BatchScrapeWithPolling(context.Background(), []string{"https://example.com"}, nil, 0, 5)
	if err != nil || batch.Status != "completed" || len(batch.Data) != 1 {
		t.Fatalf("completed batch: %#v, %v", batch, err)
	}
}

func TestFailedJobRetainsPaginatedPartialResults(t *testing.T) {
	for _, kind := range []string{"crawl", "batch"} {
		t.Run(kind, func(t *testing.T) {
			var server *httptest.Server
			server = httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
				w.Header().Set("Content-Type", "application/json")
				if r.Method == http.MethodPost {
					_, _ = w.Write([]byte(`{"id":"job-1"}`))
					return
				}
				if r.URL.Query().Get("skip") == "1" {
					_, _ = w.Write([]byte(`{"status":"failed","data":[{"markdown":"second"}]}`))
					return
				}
				_, _ = fmt.Fprintf(w, `{"status":"failed","next":%q,"data":[{"markdown":"first"}]}`, server.URL+r.URL.Path+"?skip=1")
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
			if !errors.As(err, &failed) || failed.PaginationError != nil {
				t.Fatalf("expected paginated job failure, got %v", err)
			}
			if kind == "crawl" {
				job := failed.Job.(*CrawlJob)
				if len(job.Data) != 2 || job.Data[1].Markdown != "second" {
					t.Fatalf("lost later crawl result: %#v", job)
				}
			} else {
				job := failed.Job.(*BatchScrapeJob)
				if len(job.Data) != 2 || job.Data[1].Markdown != "second" {
					t.Fatalf("lost later batch result: %#v", job)
				}
			}
		})
	}
}

func TestFailedJobExposesPaginationFailureWithoutLosingJob(t *testing.T) {
	for _, kind := range []string{"crawl", "batch"} {
		t.Run(kind, func(t *testing.T) {
			var server *httptest.Server
			server = httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
				w.Header().Set("Content-Type", "application/json")
				if r.Method == http.MethodPost {
					_, _ = w.Write([]byte(`{"id":"job-1"}`))
					return
				}
				if r.URL.Path == "/next" {
					_, _ = fmt.Fprintf(w, `{"next":%q,"data":[{"markdown":"second"}]}`, server.URL+"/next")
					return
				}
				_, _ = fmt.Fprintf(w, `{"status":"failed","next":%q,"data":[{"markdown":"first"}]}`, server.URL+"/next")
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
			if !errors.As(err, &failed) || failed.PaginationError == nil || !errors.Is(err, failed.PaginationError) {
				t.Fatalf("pagination failure not reachable from job error: %v", err)
			}
			if !strings.Contains(failed.Error(), "partial results could not be fully fetched") {
				t.Fatalf("pagination failure missing from message: %v", failed)
			}
			if kind == "crawl" {
				if len(failed.Job.(*CrawlJob).Data) != 2 {
					t.Fatalf("lost partial crawl pages: %#v", failed.Job)
				}
			} else if len(failed.Job.(*BatchScrapeJob).Data) != 2 {
				t.Fatalf("lost partial batch pages: %#v", failed.Job)
			}
		})
	}
}
