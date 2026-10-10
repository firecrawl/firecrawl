package firecrawl

import (
	"context"
	"errors"
	"fmt"
	"github.com/firecrawl/firecrawl/apps/go-sdk/option"
	"net/http"
	"net/http/httptest"
	"testing"
	"time"
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
