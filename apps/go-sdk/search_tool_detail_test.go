package firecrawl

import (
	"context"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"testing"

	"github.com/firecrawl/firecrawl/apps/go-sdk/option"
)

func TestSearchConfiguredToolDetailReachesHTTP(t *testing.T) {
	for _, detail := range []string{"compact", "summary", "full"} {
		t.Run(detail, func(t *testing.T) {
			captured := make(chan map[string]json.RawMessage, 1)
			server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
				var body map[string]json.RawMessage
				if err := json.NewDecoder(r.Body).Decode(&body); err != nil {
					t.Error(err)
				}
				captured <- body
				_, _ = w.Write([]byte(`{"success":true,"data":{"web":[],"tools":[{"provider":"owned","capability":"query","name":"fixture","options":[{"name":"query","type":"string"}]}]}}`))
			}))
			defer server.Close()
			client, err := NewClient(option.WithAPIKey("owned-fixture"), option.WithAPIURL(server.URL), option.WithHTTPClient(server.Client()), option.WithMaxRetries(0))
			if err != nil {
				t.Fatal(err)
			}
			var opts SearchOptions
			// Search configuration commonly comes from JSON; unsupported fields used to be silently dropped.
			if err := json.Unmarshal([]byte(`{"sources":["alexandria"],"domainTools":false,"toolDetail":"`+detail+`"}`), &opts); err != nil {
				t.Fatal(err)
			}
			result, err := client.Search(context.Background(), "owned query", &opts)
			if err != nil {
				t.Fatal(err)
			}
			body := <-captured
			if string(body["toolDetail"]) != `"`+detail+`"` {
				t.Fatalf("tool detail was dropped: %+v", body)
			}
			if string(body["domainTools"]) != "false" || string(body["sources"]) != `["alexandria"]` {
				t.Fatalf("existing options changed: %+v", body)
			}
			if len(result.Tools) != 1 || result.Tools[0].Provider != "owned" || len(result.Tools[0].Options) != 1 {
				t.Fatalf("tool contract lost: %+v", result.Tools)
			}
		})
	}
}

func TestSearchUnsetToolDetailKeepsServerDefault(t *testing.T) {
	raw, err := json.Marshal(SearchOptions{DomainTools: Bool(false)})
	if err != nil {
		t.Fatal(err)
	}
	var opts map[string]json.RawMessage
	if err := json.Unmarshal(raw, &opts); err != nil {
		t.Fatal(err)
	}
	if _, present := opts["toolDetail"]; present {
		t.Fatalf("unset detail overrides server default: %s", raw)
	}
	if string(opts["domainTools"]) != "false" {
		t.Fatalf("explicit false changed: %s", raw)
	}
}
