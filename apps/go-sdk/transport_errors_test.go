package firecrawl

import (
	"context"
	"errors"
	"io"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"

	"github.com/firecrawl/firecrawl/apps/go-sdk/option"
)

var errBodyTooLarge = errors.New("response body too large")

type limitedBody struct {
	body      io.ReadCloser
	remaining int64
}

func (b *limitedBody) Read(p []byte) (int, error) {
	if b.remaining <= 0 {
		return 0, errBodyTooLarge
	}
	if int64(len(p)) > b.remaining {
		p = p[:b.remaining]
	}
	n, err := b.body.Read(p)
	b.remaining -= int64(n)
	return n, err
}

func (b *limitedBody) Close() error { return b.body.Close() }

type limitingTransport struct {
	limit int64
	calls int
}

func (t *limitingTransport) RoundTrip(req *http.Request) (*http.Response, error) {
	t.calls++
	resp, err := http.DefaultTransport.RoundTrip(req)
	if err != nil {
		return nil, err
	}
	resp.Body = &limitedBody{body: resp.Body, remaining: t.limit}
	return resp, nil
}

func TestScrapeBodyReadErrorIsUnwrappable(t *testing.T) {
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Content-Type", "application/json")
		_, _ = w.Write([]byte(`{"success":true,"data":{"markdown":"` + strings.Repeat("a", 4096) + `"}}`))
	}))
	defer server.Close()

	transport := &limitingTransport{limit: 1024}
	client, err := NewClient(
		option.WithAPIKey("fc-test"),
		option.WithAPIURL(server.URL),
		option.WithHTTPClient(&http.Client{Transport: transport}),
		option.WithMaxRetries(1),
		option.WithBackoffFactor(0.001),
	)
	if err != nil {
		t.Fatalf("NewClient: %v", err)
	}

	_, err = client.Scrape(context.Background(), "https://example.com", nil)
	if !errors.Is(err, errBodyTooLarge) {
		t.Fatalf("expected errors.Is(err, errBodyTooLarge), got %T: %v", err, err)
	}
	var fe *FirecrawlError
	if !errors.As(err, &fe) {
		t.Fatalf("expected *FirecrawlError, got %T: %v", err, err)
	}
	if !strings.Contains(fe.Error(), "request failed after 1 retries") {
		t.Errorf("Error() = %q, want the existing retry message", fe.Error())
	}
	if transport.calls != 2 {
		t.Errorf("transport calls = %d, want 2 (retry behavior unchanged)", transport.calls)
	}
}

func TestScrapeRoundTripErrorIsUnwrappable(t *testing.T) {
	client, err := NewClient(
		option.WithAPIKey("fc-test"),
		option.WithAPIURL("http://firecrawl.invalid"),
		option.WithHTTPClient(&http.Client{Transport: roundTripFunc(func(*http.Request) (*http.Response, error) {
			return nil, errBodyTooLarge
		})}),
		option.WithMaxRetries(0),
	)
	if err != nil {
		t.Fatalf("NewClient: %v", err)
	}

	_, err = client.Scrape(context.Background(), "https://example.com", nil)
	if !errors.Is(err, errBodyTooLarge) {
		t.Fatalf("expected errors.Is(err, errBodyTooLarge), got %T: %v", err, err)
	}
}

type roundTripFunc func(*http.Request) (*http.Response, error)

func (f roundTripFunc) RoundTrip(req *http.Request) (*http.Response, error) { return f(req) }
