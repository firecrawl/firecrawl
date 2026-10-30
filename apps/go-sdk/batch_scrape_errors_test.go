package firecrawl

import (
	"context"
	"errors"
	"net/http"
	"net/http/httptest"
	"sync"
	"testing"

	"github.com/firecrawl/firecrawl/apps/go-sdk/option"
)

const batchErrorsPayload = `{
	"errors": [
		{
			"id": "job-1",
			"timestamp": "2026-10-29T11:14:17.000Z",
			"url": "https://does-not-resolve.invalid",
			"code": "SCRAPE_DNS_RESOLUTION_ERROR",
			"error": "DNS resolution error"
		},
		{
			"id": "job-2",
			"url": "https://slow.example.com",
			"code": "SCRAPE_TIMEOUT",
			"error": "Scrape timed out"
		},
		{
			"id": "job-3",
			"url": "https://terms.example.com",
			"code": "SCRAPE_THIRD_PARTY_DATA_TERMS_REQUIRED",
			"error": "An organization admin must accept the provider's terms first",
			"requiresAction": {"type": "accept_terms", "terms": "acme", "version": "2", "url": "https://firecrawl.dev/terms/acme"}
		}
	],
	"robotsBlocked": ["https://example.com/private"]
}`

// batchServer fakes the batch scrape lifecycle: start -> status (completed) ->
// errors, recording every request so tests can assert on what was called.
type batchServer struct {
	*httptest.Server
	mu       sync.Mutex
	requests []*http.Request
	// errorsStatus is the HTTP status the /errors endpoint responds with.
	errorsStatus int
	// errorsBody is the body the /errors endpoint responds with.
	errorsBody string
}

func newBatchServer(t *testing.T) *batchServer {
	t.Helper()
	s := &batchServer{errorsStatus: http.StatusOK, errorsBody: batchErrorsPayload}
	s.Server = httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		s.mu.Lock()
		s.requests = append(s.requests, r.Clone(r.Context()))
		s.mu.Unlock()

		w.Header().Set("Content-Type", "application/json")
		switch {
		case r.Method == http.MethodPost && r.URL.Path == "/v2/batch/scrape":
			_, _ = w.Write([]byte(`{"success":true,"id":"batch-123","url":"` + s.URL + `/v2/batch/scrape/batch-123"}`))
		case r.Method == http.MethodGet && r.URL.Path == "/v2/batch/scrape/batch-123":
			_, _ = w.Write([]byte(`{"success":true,"status":"completed","total":1,"completed":1,"creditsUsed":1,"expiresAt":"2026-10-30T11:14:17.000Z","data":[{"markdown":"# ok","metadata":{"sourceURL":"https://example.com","statusCode":200}}]}`))
		case r.Method == http.MethodGet && r.URL.Path == "/v2/batch/scrape/batch-123/errors":
			w.WriteHeader(s.errorsStatus)
			_, _ = w.Write([]byte(s.errorsBody))
		case r.Method == http.MethodGet && r.URL.Path == "/v2/crawl/crawl-456":
			_, _ = w.Write([]byte(`{"success":true,"status":"completed","total":1,"completed":1,"data":[]}`))
		default:
			w.WriteHeader(http.StatusNotFound)
			_, _ = w.Write([]byte(`{"success":false,"error":"unexpected ` + r.Method + ` ` + r.URL.String() + `"}`))
		}
	}))
	t.Cleanup(s.Close)
	return s
}

func (s *batchServer) requestsTo(path string) []*http.Request {
	s.mu.Lock()
	defer s.mu.Unlock()
	var out []*http.Request
	for _, r := range s.requests {
		if r.URL.Path == path {
			out = append(out, r)
		}
	}
	return out
}

func newBatchClient(t *testing.T, s *batchServer) *Client {
	t.Helper()
	client, err := NewClient(
		option.WithAPIKey("fc-test"),
		option.WithAPIURL(s.URL),
		option.WithMaxRetries(0),
	)
	if err != nil {
		t.Fatalf("NewClient: %v", err)
	}
	return client
}

func assertBatchErrors(t *testing.T, got []BatchScrapeError, robotsBlocked []string) {
	t.Helper()
	if len(got) != 3 {
		t.Fatalf("got %d errors, want 3: %+v", len(got), got)
	}
	dns := got[0]
	if dns.ID != "job-1" || dns.URL != "https://does-not-resolve.invalid" || dns.Code != "SCRAPE_DNS_RESOLUTION_ERROR" || dns.Error != "DNS resolution error" || dns.Timestamp != "2026-10-29T11:14:17.000Z" {
		t.Errorf("unexpected first error: %+v", dns)
	}
	if dns.RequiresAction != nil {
		t.Errorf("first error should not require an action, got %+v", dns.RequiresAction)
	}
	if got[1].Code != "SCRAPE_TIMEOUT" || got[1].Timestamp != "" {
		t.Errorf("unexpected second error: %+v", got[1])
	}
	terms := got[2]
	if terms.RequiresAction == nil {
		t.Fatalf("third error should carry requiresAction: %+v", terms)
	}
	if terms.RequiresAction.Type != "accept_terms" || terms.RequiresAction.Terms != "acme" || terms.RequiresAction.Version != "2" || terms.RequiresAction.URL != "https://firecrawl.dev/terms/acme" {
		t.Errorf("unexpected requiresAction: %+v", terms.RequiresAction)
	}
	if len(robotsBlocked) != 1 || robotsBlocked[0] != "https://example.com/private" {
		t.Errorf("unexpected robotsBlocked: %v", robotsBlocked)
	}
}

func TestBatchScrapeReturnsIDAndErrors(t *testing.T) {
	s := newBatchServer(t)
	client := newBatchClient(t, s)

	job, err := client.BatchScrapeWithPolling(context.Background(), []string{"https://example.com", "https://does-not-resolve.invalid"}, nil, 1, 30)
	if err != nil {
		t.Fatalf("BatchScrapeWithPolling: %v", err)
	}

	if job.ID != "batch-123" {
		t.Errorf("job.ID = %q, want batch-123", job.ID)
	}
	if job.Status != "completed" {
		t.Errorf("job.Status = %q, want completed", job.Status)
	}
	if len(job.Data) != 1 || job.Data[0].Markdown != "# ok" {
		t.Fatalf("unexpected job.Data: %+v", job.Data)
	}
	if status, _ := job.Data[0].Metadata["statusCode"].(float64); status != 200 {
		t.Errorf("document should keep its HTTP status code: %+v", job.Data[0].Metadata)
	}
	assertBatchErrors(t, job.Errors, job.RobotsBlocked)

	reqs := s.requestsTo("/v2/batch/scrape/batch-123/errors")
	if len(reqs) != 1 {
		t.Fatalf("errors endpoint called %d times, want 1", len(reqs))
	}
	if got := reqs[0].Header.Get("Authorization"); got != "Bearer fc-test" {
		t.Errorf("Authorization = %q, want Bearer fc-test", got)
	}
}

func TestBatchScrapeFailsWhenErrorsEndpointFails(t *testing.T) {
	s := newBatchServer(t)
	s.errorsStatus = http.StatusInternalServerError
	s.errorsBody = `{"success":false,"error":"Internal server error"}`
	client := newBatchClient(t, s)

	job, err := client.BatchScrapeWithPolling(context.Background(), []string{"https://example.com"}, nil, 1, 30)
	if err == nil {
		t.Fatalf("expected an error, got job %+v", job)
	}
	var fcErr *FirecrawlError
	if !errors.As(err, &fcErr) {
		t.Fatalf("error %T is not a *FirecrawlError: %v", err, err)
	}
	if fcErr.StatusCode != http.StatusInternalServerError {
		t.Errorf("StatusCode = %d, want 500", fcErr.StatusCode)
	}
}

func TestGetBatchScrapeErrors(t *testing.T) {
	s := newBatchServer(t)
	client := newBatchClient(t, s)

	resp, err := client.GetBatchScrapeErrors(context.Background(), "batch-123")
	if err != nil {
		t.Fatalf("GetBatchScrapeErrors: %v", err)
	}
	assertBatchErrors(t, resp.Errors, resp.RobotsBlocked)
}

func TestGetBatchScrapeErrorsAcceptsDataEnvelope(t *testing.T) {
	s := newBatchServer(t)
	s.errorsBody = `{"success":true,"data":` + batchErrorsPayload + `}`
	client := newBatchClient(t, s)

	resp, err := client.GetBatchScrapeErrors(context.Background(), "batch-123")
	if err != nil {
		t.Fatalf("GetBatchScrapeErrors: %v", err)
	}
	assertBatchErrors(t, resp.Errors, resp.RobotsBlocked)
}

func TestGetBatchScrapeErrorsEmptyIsNotNil(t *testing.T) {
	s := newBatchServer(t)
	s.errorsBody = `{"errors":[],"robotsBlocked":[]}`
	client := newBatchClient(t, s)

	resp, err := client.GetBatchScrapeErrors(context.Background(), "batch-123")
	if err != nil {
		t.Fatalf("GetBatchScrapeErrors: %v", err)
	}
	if resp.Errors == nil || len(resp.Errors) != 0 {
		t.Errorf("Errors = %#v, want empty non-nil slice", resp.Errors)
	}
	if resp.RobotsBlocked == nil || len(resp.RobotsBlocked) != 0 {
		t.Errorf("RobotsBlocked = %#v, want empty non-nil slice", resp.RobotsBlocked)
	}
}

func TestGetBatchScrapeErrorsRequiresJobID(t *testing.T) {
	s := newBatchServer(t)
	client := newBatchClient(t, s)

	if _, err := client.GetBatchScrapeErrors(context.Background(), ""); err == nil {
		t.Fatal("expected an error for an empty job ID")
	}
	if n := len(s.requests); n != 0 {
		t.Errorf("made %d requests, want none", n)
	}
}

func TestStatusResponsesCarryJobID(t *testing.T) {
	s := newBatchServer(t)
	client := newBatchClient(t, s)

	batch, err := client.GetBatchScrapeStatus(context.Background(), "batch-123")
	if err != nil {
		t.Fatalf("GetBatchScrapeStatus: %v", err)
	}
	if batch.ID != "batch-123" {
		t.Errorf("batch.ID = %q, want batch-123", batch.ID)
	}
	if batch.Errors != nil {
		t.Errorf("GetBatchScrapeStatus should not fetch errors, got %+v", batch.Errors)
	}
	if n := len(s.requestsTo("/v2/batch/scrape/batch-123/errors")); n != 0 {
		t.Errorf("GetBatchScrapeStatus called the errors endpoint %d times", n)
	}

	crawl, err := client.GetCrawlStatus(context.Background(), "crawl-456")
	if err != nil {
		t.Fatalf("GetCrawlStatus: %v", err)
	}
	if crawl.ID != "crawl-456" {
		t.Errorf("crawl.ID = %q, want crawl-456", crawl.ID)
	}
}
