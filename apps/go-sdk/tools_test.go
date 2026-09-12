package firecrawl

import (
	"context"
	"encoding/json"
	"errors"
	"net/http"
	"net/http/httptest"
	"testing"

	"github.com/firecrawl/firecrawl/apps/go-sdk/option"
)

func TestToolDiscoveryAndExecution(t *testing.T) {
	var ids []string
	var bodies []map[string]interface{}
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		var body map[string]interface{}
		if err := json.NewDecoder(r.Body).Decode(&body); err != nil {
			t.Error(err)
		}
		bodies = append(bodies, body)
		w.Header().Set("Content-Type", "application/json")
		if r.URL.Path == "/v2/search" {
			w.Write([]byte(`{"success":true,"warning":"contextual lookup unavailable","data":{"tools":[{"id":"p/a","provider":"p","capability":"a","name":"Tool","description":"Example","creditsCost":2,"perRecord":false,"options":[{"name":"q","type":"string"}],"response":{"fields":[]},"examples":{"go":"example"},"matchedBy":["semantic","domain"],"matchedUrls":["https://example.com"]}]}}`))
			return
		}
		if body["alexandria"].([]interface{})[0].(map[string]interface{})["provider"] == "firecrawl" {
			w.Write([]byte(`{"success":true,"data":{"alexandria":[{"error":{"code":"invalid_options","message":"Invalid lookup"}}],"creditsCost":0}}`))
			return
		}
		ids = append(ids, r.Header.Get("x-request-id"))
		if len(ids) == 1 {
			w.WriteHeader(502)
			w.Write([]byte(`{"error":"retry"}`))
			return
		}
		w.Write([]byte(`{"success":true,"scrape_id":"scrape-1","data":{"alexandria":[{"provider":"p","capability":"a","creditsCost":2,"data":{"nested":[1,2]}},{"provider":"p","capability":"b","error":{"code":"unavailable","message":"unavailable"}}],"creditsCost":2}}`))
	}))
	defer server.Close()
	client, err := NewClient(option.WithAPIKey("fc-test"), option.WithAPIURL(server.URL))
	if err != nil {
		t.Fatal(err)
	}
	enabled := true
	search, err := client.Search(context.Background(), "tools", &SearchOptions{Sources: []interface{}{"alexandria"}, DomainTools: &enabled})
	if err != nil {
		t.Fatal(err)
	}
	if search.Warning != "contextual lookup unavailable" || len(search.Tools) != 1 || len(search.Tools[0].MatchedBy) != 2 || search.Tools[0].Options[0]["name"] != "q" {
		t.Fatalf("lost contract: %+v", search)
	}
	result, err := client.ScrapeAlexandria(context.Background(), []AlexandriaCall{{Provider: "p", Capability: "a"}}, &AlexandriaOptions{RequestID: "retry-1"})
	if err != nil {
		t.Fatal(err)
	}
	if result.RequestID != "retry-1" || result.CreditsCost != 2 || !result.Alexandria[1].Failed() {
		t.Fatalf("lost result: %+v", result)
	}
	if len(ids) != 2 || ids[0] != "retry-1" || ids[1] != ids[0] {
		t.Fatalf("retry IDs: %v", ids)
	}
	_, lookupErr := client.FindTools(context.Background(), nil)
	var executionErr *AlexandriaExecutionError
	var apiErr *FirecrawlError
	if !errors.As(lookupErr, &executionErr) || executionErr.RequestID == "" || !errors.As(lookupErr, &apiErr) || apiErr.ErrorCode != "invalid_options" {
		t.Fatalf("lost lookup error identity: %v", lookupErr)
	}
	if _, err := client.Search(context.Background(), "   ", nil); err == nil {
		t.Fatal("empty query accepted")
	}
	if _, ok := bodies[1]["requestId"]; ok {
		t.Fatal("requestId leaked into body")
	}
}
