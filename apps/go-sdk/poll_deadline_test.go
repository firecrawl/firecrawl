package firecrawl

import (
	"context"
	"errors"
	"fmt"
	"net/http"
	"net/http/httptest"
	"sync/atomic"
	"testing"
	"time"

	"github.com/firecrawl/firecrawl/apps/go-sdk/option"
)

func TestPollingDeadlineBoundsRequestsAndSleep(t *testing.T) {
	for _, kind := range []string{"crawl", "batch", "agent"} {
		for _, slow := range []bool{true, false} {
			t.Run(fmt.Sprintf("%s/slow=%v", kind, slow), func(t *testing.T) {
				server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
					w.Header().Set("Content-Type", "application/json")
					if r.Method == "POST" {
						fmt.Fprint(w, `{"success":true,"id":"job-fixture"}`)
						return
					}
					if slow {
						select {
						case <-r.Context().Done():
							return
						case <-time.After(1500 * time.Millisecond):
						}
					}
					fmt.Fprint(w, `{"success":true,"status":"scraping","data":[]}`)
				}))
				defer server.Close()
				client, err := NewClient(option.WithAPIKey("fc-fixture"), option.WithAPIURL(server.URL))
				if err != nil {
					t.Fatal(err)
				}
				ctx, cancel := context.WithTimeout(context.Background(), 3*time.Second)
				defer cancel()
				start := time.Now()
				switch kind {
				case "crawl":
					_, err = client.CrawlWithPolling(ctx, "https://example.com", nil, 10, 1)
				case "batch":
					_, err = client.BatchScrapeWithPolling(ctx, []string{"https://example.com"}, nil, 10, 1)
				case "agent":
					_, err = client.AgentWithPolling(ctx, &AgentOptions{Prompt: "fixture"}, 10, 1)
				}
				var timeout *JobTimeoutError
				if !errors.As(err, &timeout) {
					t.Fatalf("expected SDK job timeout at its own deadline, got %T:%v", err, err)
				}
				if timeout.JobID != "job-fixture" || timeout.TimeoutSeconds != 1 {
					t.Fatalf("lost timeout metadata: %+v", timeout)
				}
				if elapsed := time.Since(start); elapsed > 2*time.Second {
					t.Fatalf("one-second budget took %v", elapsed)
				}
			})
		}
	}
}

func TestPollingKeepsCompletionAndParentCancellation(t *testing.T) {
	for _, kind := range []string{"crawl", "batch", "agent"} {
		for _, cancelEarly := range []bool{false, true} {
			t.Run(fmt.Sprintf("%s/cancel=%v", kind, cancelEarly), func(t *testing.T) {
				server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
					w.Header().Set("Content-Type", "application/json")
					if r.Method == "POST" {
						fmt.Fprint(w, `{"success":true,"id":"job-fixture"}`)
						return
					}
					if cancelEarly {
						<-r.Context().Done()
						return
					}
					fmt.Fprint(w, `{"success":true,"status":"completed","data":[]}`)
				}))
				defer server.Close()
				client, err := NewClient(option.WithAPIKey("fc-fixture"), option.WithAPIURL(server.URL))
				if err != nil {
					t.Fatal(err)
				}
				ctx := context.Background()
				if cancelEarly {
					var cancel context.CancelFunc
					ctx, cancel = context.WithTimeout(ctx, 100*time.Millisecond)
					defer cancel()
				}
				switch kind {
				case "crawl":
					_, err = client.CrawlWithPolling(ctx, "https://example.com", nil, 10, 2)
				case "batch":
					_, err = client.BatchScrapeWithPolling(ctx, []string{"https://example.com"}, nil, 10, 2)
				case "agent":
					_, err = client.AgentWithPolling(ctx, &AgentOptions{Prompt: "fixture"}, 10, 2)
				}
				if cancelEarly {
					if !errors.Is(err, context.DeadlineExceeded) {
						t.Fatalf("caller deadline changed: %T %v", err, err)
					}
					var timeout *JobTimeoutError
					if errors.As(err, &timeout) {
						t.Fatal("caller deadline became SDK job timeout")
					}
				} else if err != nil {
					t.Fatalf("fast completed job failed: %v", err)
				}
			})
		}
	}
}

// TestExpiredPollingContextKeepsCallerCancellation guards the polling loops' error authority.
func TestExpiredPollingContextKeepsCallerCancellation(t *testing.T) {
	for _, kind := range []string{"crawl", "batch"} {
		t.Run(kind, func(t *testing.T) {
			ctx, cancel := context.WithCancel(context.Background())
			cancel()
			client := &Client{}
			var err error
			if kind == "crawl" {
				_, err = client.pollCrawl(ctx, "job-fixture", 10, 0)
			} else {
				_, err = client.pollBatchScrape(ctx, "job-fixture", 10, 0)
			}
			if !errors.Is(err, context.Canceled) {
				t.Fatalf("caller cancellation became SDK timeout: %T %v", err, err)
			}
			var timeout *JobTimeoutError
			if errors.As(err, &timeout) {
				t.Fatal("caller cancellation was classified as a job timeout")
			}
		})
	}
}

// TestPollingDeadlineDuringCompletedPagination exercises the actual next-page HTTP request.
func TestPollingDeadlineDuringCompletedPagination(t *testing.T) {
	for _, kind := range []string{"crawl", "batch"} {
		for _, mode := range []string{"completed", "sdk-timeout", "parent-deadline"} {
			t.Run(kind+"/"+mode, func(t *testing.T) {
				var pageRequests atomic.Int32
				server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
					w.Header().Set("Content-Type", "application/json")
					if r.Method == http.MethodPost {
						fmt.Fprint(w, `{"success":true,"id":"job-fixture"}`)
						return
					}
					if r.URL.Path == "/page2" {
						pageRequests.Add(1)
						if mode != "completed" {
							select {
							case <-r.Context().Done():
								return
							case <-time.After(2 * time.Second):
							}
						}
						fmt.Fprint(w, `{"success":true,"status":"completed","data":[{"markdown":"second"}]}`)
						return
					}
					fmt.Fprintf(w, `{"success":true,"status":"completed","data":[{"markdown":"first"}],"next":%q}`, "http://"+r.Host+"/page2")
				}))
				defer server.Close()
				client, err := NewClient(option.WithAPIKey("fc-fixture"), option.WithAPIURL(server.URL))
				if err != nil {
					t.Fatal(err)
				}
				parentBudget := 3 * time.Second
				if mode == "parent-deadline" {
					parentBudget = 100 * time.Millisecond
				}
				ctx, cancel := context.WithTimeout(context.Background(), parentBudget)
				defer cancel()
				start := time.Now()
				var data []Document
				if kind == "crawl" {
					var job *CrawlJob
					job, err = client.CrawlWithPolling(ctx, "https://example.com", nil, 10, 1)
					if job != nil {
						data = job.Data
					}
				} else {
					var job *BatchScrapeJob
					job, err = client.BatchScrapeWithPolling(ctx, []string{"https://example.com"}, nil, 10, 1)
					if job != nil {
						data = job.Data
					}
				}
				if pageRequests.Load() != 1 {
					t.Fatalf("next page requests = %d, want one", pageRequests.Load())
				}
				switch mode {
				case "completed":
					if err != nil {
						t.Fatalf("fast completed pagination failed: %v", err)
					}
					if len(data) != 2 || data[0].Markdown != "first" || data[1].Markdown != "second" {
						t.Fatalf("completed pages lost: %+v", data)
					}
				case "sdk-timeout":
					var timeout *JobTimeoutError
					if !errors.As(err, &timeout) {
						t.Fatalf("pagination escaped SDK deadline: %T %v", err, err)
					}
					if timeout.JobID != "job-fixture" || timeout.TimeoutSeconds != 1 {
						t.Fatalf("lost timeout metadata: %+v", timeout)
					}
				case "parent-deadline":
					if !errors.Is(err, context.DeadlineExceeded) {
						t.Fatalf("caller deadline changed during pagination: %T %v", err, err)
					}
					var timeout *JobTimeoutError
					if errors.As(err, &timeout) {
						t.Fatal("caller deadline became SDK pagination timeout")
					}
				}
				if elapsed := time.Since(start); elapsed > 1500*time.Millisecond {
					t.Fatalf("pagination exceeded bounded elapsed time: %v", elapsed)
				}
			})
		}
	}
}
