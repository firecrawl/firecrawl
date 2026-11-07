package firecrawl

import (
	"context"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"reflect"
	"testing"

	"github.com/firecrawl/firecrawl/apps/go-sdk/option"
)

func browserTestClient(t *testing.T, captured chan<- capturedRequest) *Client {
	t.Helper()
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		captured <- captureRequest(r)
		w.Header().Set("Content-Type", "application/json")
		w.WriteHeader(http.StatusOK)
		_, _ = w.Write([]byte(`{"success":true,"id":"session-1"}`))
	}))
	t.Cleanup(server.Close)

	client, err := NewClient(
		option.WithAPIKey("fc-test"),
		option.WithAPIURL(server.URL),
	)
	if err != nil {
		t.Fatalf("NewClient: %v", err)
	}
	return client
}

func TestBrowserSendsLocation(t *testing.T) {
	captured := make(chan capturedRequest, 1)
	client := browserTestClient(t, captured)

	if _, err := client.Browser(context.Background(), &BrowserOptions{
		Location: &BrowserLocation{Country: "GB"},
	}); err != nil {
		t.Fatalf("Browser: %v", err)
	}

	req := <-captured
	if req.path != "/v2/browser" {
		t.Fatalf("path = %q, want /v2/browser", req.path)
	}
	var body map[string]any
	if err := json.Unmarshal([]byte(req.body), &body); err != nil {
		t.Fatalf("decode body: %v", err)
	}
	want := map[string]any{"location": map[string]any{"country": "GB"}}
	if !reflect.DeepEqual(body, want) {
		t.Fatalf("body = %v, want %v", body, want)
	}
}

func TestBrowserOmitsLocationWhenUnset(t *testing.T) {
	captured := make(chan capturedRequest, 1)
	client := browserTestClient(t, captured)

	if _, err := client.Browser(context.Background(), &BrowserOptions{TTL: Int(60)}); err != nil {
		t.Fatalf("Browser: %v", err)
	}

	var body map[string]any
	if err := json.Unmarshal([]byte((<-captured).body), &body); err != nil {
		t.Fatalf("decode body: %v", err)
	}
	if _, ok := body["location"]; ok {
		t.Fatalf("body has location: %v", body)
	}
}
