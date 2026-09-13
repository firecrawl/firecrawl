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
			w.Write([]byte(`{"success":true,"warning":"contextual lookup unavailable","data":{"tools":[{"id":"p/a","provider":"p","capability":"a","name":"Tool","description":"Example","creditsCost":2,"perRecord":false,"options":[{"name":"q","type":"string"}],"response":{"fields":[]},"examples":{"go":"example"},"matchedBy":["semantic","domain"],"matchedUrls":["https://example.com"]},{"id":"benzinga/calendar/ratings","provider":"benzinga","capability":"calendar/ratings","name":"Analyst ratings","description":"Ratings","creditsCost":5,"perRecord":false,"label":"Ratings","whenToUse":"Analyst ratings for a ticker","returns":{"about":"Ratings"},"discovery":{"urls":[]},"attribution":{"required":true},"options":[{"name":"tickers","type":"string"}],"response":{"fields":[]},"matchedBy":["semantic"],"matchedUrls":[]}]}}`))
			return
		}
		if body["alexandria"].([]interface{})[0].(map[string]interface{})["provider"] == "benzinga" {
			w.WriteHeader(403)
			w.Write([]byte(`{"success":false,"code":"THIRD_PARTY_DATA_TERMS_REQUIRED","error":"An organization admin must accept the benzinga provider's terms","requiresAction":{"type":"accept_terms","terms":"benzinga","version":"C-1.0.0-draft","url":"https://www.firecrawl.dev/app/alexandria/benzinga"}}`))
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
	if search.Warning != "contextual lookup unavailable" || len(search.Tools) != 2 || len(search.Tools[0].MatchedBy) != 2 || search.Tools[0].Options[0]["name"] != "q" {
		t.Fatalf("lost contract: %+v", search)
	}
	if search.Tools[1].Examples != nil || search.Tools[1].Label != "Ratings" || search.Tools[1].WhenToUse != "Analyst ratings for a ticker" {
		t.Fatalf("lost production contract: %+v", search.Tools[1])
	}
	_, termsErr := client.ScrapeAlexandria(context.Background(), []AlexandriaCall{{Provider: "benzinga", Capability: "calendar/ratings"}}, &AlexandriaOptions{RequestID: "terms-1"})
	var termsExecutionErr *AlexandriaExecutionError
	var termsAPIErr *FirecrawlError
	if !errors.As(termsErr, &termsExecutionErr) || termsExecutionErr.RequestID != "terms-1" || !errors.As(termsErr, &termsAPIErr) {
		t.Fatalf("lost terms error identity: %v", termsErr)
	}
	if termsAPIErr.StatusCode != 403 || termsAPIErr.ErrorCode != "THIRD_PARTY_DATA_TERMS_REQUIRED" || termsAPIErr.RequiresAction == nil {
		t.Fatalf("lost terms error details: %+v", termsAPIErr)
	}
	if action := termsAPIErr.RequiresAction; action.Type != "accept_terms" || action.Terms != "benzinga" || action.Version != "C-1.0.0-draft" || action.URL != "https://www.firecrawl.dev/app/alexandria/benzinga" {
		t.Fatalf("lost requiresAction: %+v", action)
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
