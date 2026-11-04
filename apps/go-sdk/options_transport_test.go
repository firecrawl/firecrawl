package firecrawl

import (
	"context"
	"encoding/json"
	"io"
	"net/http"
	"net/http/httptest"
	"strings"
	"sync/atomic"
	"testing"

	"github.com/firecrawl/firecrawl/apps/go-sdk/option"
)

func TestOptionsTransportPreservesSchemaInteger(t *testing.T) {
	for _, batch := range []bool{false, true} {
		t.Run(map[bool]string{false: "scrape", true: "batch"}[batch], func(t *testing.T) {
			received := make(chan string, 1)
			server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
				b, _ := io.ReadAll(r.Body)
				select {
				case received <- string(b):
				default:
					t.Error("unexpected extra request body")
				}
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
			bodyJSON := <-received
			if !strings.Contains(bodyJSON, "9007199254740993") {
				t.Fatalf("schema integer changed in actual request: %s", bodyJSON)
			}
			var body map[string]json.RawMessage
			if err = json.Unmarshal([]byte(bodyJSON), &body); err != nil {
				t.Fatal(err)
			}
			if string(body["onlyMainContent"]) != "false" {
				t.Fatalf("false option dropped: %s", bodyJSON)
			}
			if _, nested := body["options"]; nested {
				t.Fatalf("batch options not flattened: %s", bodyJSON)
			}
		})
	}
}

func TestOptionsSerializationFailureDoesNotDeliverDefaultRequest(t *testing.T) {
	var calls atomic.Int32
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		calls.Add(1)
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
	if delivered := calls.Load(); delivered != 0 {
		t.Fatalf("delivered %d default requests despite invalid options", delivered)
	}
}
