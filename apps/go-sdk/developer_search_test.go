package firecrawl

import (
	"context"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"

	"github.com/firecrawl/firecrawl/apps/go-sdk/option"
)

func TestDeveloperSearchPostsQueryAndOptions(t *testing.T) {
	captured := make(chan capturedRequest, 1)

	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		captured <- captureRequest(r)
		w.Header().Set("Content-Type", "application/json")
		w.WriteHeader(http.StatusOK)
		_, _ = w.Write([]byte(`{"success":true,"results":[{"id":"r1","url":"https://github.com/golang/go/issues/1","title":"retry","passages":[{"text":"use backoff","citation_url":"https://github.com/golang/go/issues/1#c1"}],"license":"BSD-3-Clause"}],"repos":[{"repo":"golang/go","indexed":true,"types":{"issue":true,"pullRequest":true,"readme":false}}]}`))
	}))
	defer server.Close()

	client, err := NewClient(option.WithAPIKey("fc-test"), option.WithAPIURL(server.URL))
	if err != nil {
		t.Fatalf("NewClient: %v", err)
	}

	resp, err := client.DeveloperSearch(context.Background(), "retry backoff", &DeveloperSearchOptions{
		K:        Int(5),
		Types:    []string{"issue"},
		Repos:    []string{"golang/go"},
		MinStars: Int(100),
	})
	if err != nil {
		t.Fatalf("DeveloperSearch: %v", err)
	}

	req := <-captured
	if req.method != http.MethodPost || req.path != "/v2/search/developer" {
		t.Errorf("unexpected request: %s %s", req.method, req.path)
	}
	for _, want := range []string{`"query":"retry backoff"`, `"k":5`, `"types":["issue"]`, `"repos":["golang/go"]`, `"min_stars":100`, `"origin":"go-sdk@` + Version + `"`} {
		if !strings.Contains(req.body, want) {
			t.Errorf("request body missing %s: %q", want, req.body)
		}
	}
	if len(resp.Results) != 1 || resp.Results[0].Passages[0].CitationURL == "" {
		t.Fatalf("unexpected results: %+v", resp.Results)
	}
	if string(resp.Results[0].License) != `"BSD-3-Clause"` {
		t.Errorf("license = %s", resp.Results[0].License)
	}
	if len(resp.Repos) != 1 || !resp.Repos[0].Types.PullRequest {
		t.Errorf("unexpected repos: %+v", resp.Repos)
	}
}

func TestDeveloperSearchRejectsEmptyQuery(t *testing.T) {
	client, err := NewClient(option.WithAPIKey("fc-test"), option.WithAPIURL("http://127.0.0.1:1"))
	if err != nil {
		t.Fatalf("NewClient: %v", err)
	}
	if _, err := client.DeveloperSearch(context.Background(), "  ", nil); err == nil {
		t.Fatal("expected an error for an empty query")
	}
}
