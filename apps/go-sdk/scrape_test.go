package firecrawl

import (
	"context"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"testing"

	"github.com/firecrawl/firecrawl/apps/go-sdk/option"
)

func TestScrapeSendsJsonOptionsAsFormatObject(t *testing.T) {
	var gotBody map[string]interface{}

	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.Method != http.MethodPost || r.URL.Path != "/v2/scrape" {
			t.Fatalf("unexpected request: %s %s", r.Method, r.URL.Path)
		}
		if err := json.NewDecoder(r.Body).Decode(&gotBody); err != nil {
			t.Fatalf("decode request body: %v", err)
		}

		w.Header().Set("Content-Type", "application/json")
		w.WriteHeader(http.StatusOK)
		_, _ = w.Write([]byte(`{"success":true,"data":{"json":{"hello":"world"}}}`))
	}))
	defer server.Close()

	client, err := NewClient(
		option.WithAPIKey("fc-test"),
		option.WithAPIURL(server.URL),
	)
	if err != nil {
		t.Fatalf("NewClient: %v", err)
	}

	doc, err := client.Scrape(context.Background(), "https://example.com", &ScrapeOptions{
		Formats: []string{"json"},
		JsonOptions: &JsonOptions{
			Prompt: "Extract greeting",
			Schema: map[string]interface{}{
				"type": "object",
				"properties": map[string]interface{}{
					"hello": map[string]interface{}{"type": "string"},
				},
			},
		},
	})
	if err != nil {
		t.Fatalf("Scrape: %v", err)
	}
	if doc.JSON == nil {
		t.Fatalf("doc.JSON is nil")
	}

	if _, ok := gotBody["jsonOptions"]; ok {
		t.Fatalf("request body contains top-level jsonOptions: %#v", gotBody)
	}
	formats, ok := gotBody["formats"].([]interface{})
	if !ok || len(formats) != 1 {
		t.Fatalf("formats = %#v, want one json object", gotBody["formats"])
	}
	jsonFormat, ok := formats[0].(map[string]interface{})
	if !ok {
		t.Fatalf("formats[0] = %#v, want json object", formats[0])
	}
	if jsonFormat["type"] != "json" || jsonFormat["prompt"] != "Extract greeting" {
		t.Fatalf("json format = %#v", jsonFormat)
	}
	if _, ok := jsonFormat["schema"].(map[string]interface{}); !ok {
		t.Fatalf("json format missing schema: %#v", jsonFormat)
	}
}
