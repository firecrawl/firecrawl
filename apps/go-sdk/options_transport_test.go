package firecrawl

import (
	"context"
	"encoding/json"
	"io"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"

	"github.com/firecrawl/firecrawl/apps/go-sdk/option"
)

func TestOptionsTransportPreservesSchemaInteger(t *testing.T) {
	for _, batch := range []bool{false, true} {
		t.Run(map[bool]string{false: "scrape", true: "batch"}[batch], func(t *testing.T) {
			var received string
			server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
				b, _ := io.ReadAll(r.Body)
				received = string(b)
				w.Header().Set("Content-Type", "application/json")
				if batch {
					io.WriteString(w, `{"success":true,"id":"fixture"}`)
				} else {
					io.WriteString(w, `{"success":true,"data":{"markdown":"fixture"}}`)
				}
			}))
			defer server.Close()
			client, err := NewClient(option.WithAPIKey("fc-fixture"), option.WithAPIURL(server.URL))
			if err != nil {
				t.Fatal(err)
			}
			opts := &ScrapeOptions{FormatOptions: []interface{}{map[string]interface{}{"type": "json", "schema": map[string]interface{}{"type": "integer", "enum": []int64{9007199254740993}}}}, OnlyMainContent: Bool(false)}
			if batch {
				_, err = client.StartBatchScrape(context.Background(), []string{"https://example.com"}, &BatchScrapeOptions{ScrapeOptions: opts})
			} else {
				_, err = client.Scrape(context.Background(), "https://example.com", opts)
			}
			if err != nil {
				t.Fatal(err)
			}
			if !strings.Contains(received, "9007199254740993") {
				t.Fatalf("schema integer changed in actual request: %s", received)
			}
			var body map[string]json.RawMessage
			if err = json.Unmarshal([]byte(received), &body); err != nil {
				t.Fatal(err)
			}
			if string(body["onlyMainContent"]) != "false" {
				t.Fatalf("false option dropped: %s", received)
			}
			if _, nested := body["options"]; nested {
				t.Fatalf("batch options not flattened: %s", received)
			}
		})
	}
}

func TestOptionsSerializationFailureDoesNotDeliverDefaultRequest(t *testing.T) {
	calls := 0
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		calls++
		io.WriteString(w, `{"success":true,"data":{"markdown":"fixture"}}`)
	}))
	defer server.Close()
	client, err := NewClient(option.WithAPIKey("fc-fixture"), option.WithAPIURL(server.URL))
	if err != nil {
		t.Fatal(err)
	}
	_, err = client.Scrape(context.Background(), "https://example.com", &ScrapeOptions{FormatOptions: []interface{}{func() {}}})
	if err == nil {
		t.Fatal("invalid options silently discarded")
	}
	if calls != 0 {
		t.Fatalf("delivered %d default requests despite invalid options", calls)
	}
}
