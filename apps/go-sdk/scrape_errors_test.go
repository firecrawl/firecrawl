package firecrawl

import (
	"context"
	"errors"
	"net/http"
	"net/http/httptest"
	"testing"

	"github.com/firecrawl/firecrawl/apps/go-sdk/option"
)

func TestScrapeReturnsErrorOnSuccessFalse(t *testing.T) {
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Content-Type", "application/json")
		w.WriteHeader(http.StatusOK)
		_, _ = w.Write([]byte(`{"success":false,"code":"SCRAPE_DNS_RESOLUTION_ERROR","error":"DNS resolution failed for hostname \"nonexistent.example\"."}`))
	}))
	defer server.Close()

	client, err := NewClient(option.WithAPIKey("fc-test"), option.WithAPIURL(server.URL))
	if err != nil {
		t.Fatalf("NewClient: %v", err)
	}

	doc, err := client.Scrape(context.Background(), "https://nonexistent.example", nil)
	if doc != nil {
		t.Errorf("expected nil document, got %+v", doc)
	}
	var fe *FirecrawlError
	if !errors.As(err, &fe) {
		t.Fatalf("expected *FirecrawlError, got %T: %v", err, err)
	}
	if fe.ErrorCode != "SCRAPE_DNS_RESOLUTION_ERROR" {
		t.Errorf("ErrorCode = %q, want SCRAPE_DNS_RESOLUTION_ERROR", fe.ErrorCode)
	}
	if fe.StatusCode != 200 {
		t.Errorf("StatusCode = %d, want 200", fe.StatusCode)
	}
	if fe.Message != `DNS resolution failed for hostname "nonexistent.example".` {
		t.Errorf("Message = %q", fe.Message)
	}
}

func TestScrapeReturnsDocumentOnSuccess(t *testing.T) {
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Content-Type", "application/json")
		w.WriteHeader(http.StatusOK)
		_, _ = w.Write([]byte(`{"success":true,"data":{"markdown":"# Hello"}}`))
	}))
	defer server.Close()

	client, err := NewClient(option.WithAPIKey("fc-test"), option.WithAPIURL(server.URL))
	if err != nil {
		t.Fatalf("NewClient: %v", err)
	}

	doc, err := client.Scrape(context.Background(), "https://example.com", nil)
	if err != nil {
		t.Fatalf("Scrape: %v", err)
	}
	if doc.Markdown != "# Hello" {
		t.Errorf("Markdown = %q, want # Hello", doc.Markdown)
	}
}
