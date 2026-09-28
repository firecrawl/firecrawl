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

func TestRepeatedMonitorPaginationCursorFailsInsteadOfLooping(t *testing.T) {
	var calls atomic.Int32
	var server *httptest.Server
	server = httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if calls.Add(1) > 4 {
			w.WriteHeader(http.StatusBadGateway)
			return
		}
		w.Header().Set("Content-Type", "application/json")
		_, _ = fmt.Fprintf(w, `{"data":{"pages":[]},"next":%q}`, server.URL+"/next")
	}))
	defer server.Close()

	client, err := NewClient(option.WithAPIKey("fc-test"), option.WithAPIURL(server.URL), option.WithMaxRetries(0))
	if err != nil {
		t.Fatal(err)
	}
	_, err = client.GetMonitorCheck(context.Background(), "monitor-1", "check-1", nil)
	var apiErr *FirecrawlError
	if !errors.As(err, &apiErr) || !strings.Contains(apiErr.Message, "pagination cursor repeated") {
		t.Fatalf("expected repeated cursor error, got %v", err)
	}
	if got := calls.Load(); got != 2 {
		t.Fatalf("fetched %d pages, want 2 before detecting cycle", got)
	}
}

func TestDistinctMonitorPaginationCursorsStillComplete(t *testing.T) {
	var server *httptest.Server
	server = httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Content-Type", "application/json")
		switch r.URL.Path {
		case "/first":
			_, _ = fmt.Fprintf(w, `{"data":{"pages":[{"url":"https://first.example"}]},"next":%q}`, server.URL+"/second")
		case "/second":
			_, _ = w.Write([]byte(`{"data":{"pages":[{"url":"https://second.example"}]}}`))
		default:
			_, _ = fmt.Fprintf(w, `{"data":{"pages":[]},"next":%q}`, server.URL+"/first")
		}
	}))
	defer server.Close()

	client, err := NewClient(option.WithAPIKey("fc-test"), option.WithAPIURL(server.URL))
	if err != nil {
		t.Fatal(err)
	}
	detail, err := client.GetMonitorCheck(context.Background(), "monitor-1", "check-1", nil)
	if err != nil || detail == nil || len(detail.Pages) != 2 {
		t.Fatalf("distinct cursors should paginate: %#v, %v", detail, err)
	}
}
