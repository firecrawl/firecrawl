package firecrawl

import (
	"context"
	"encoding/json"
	"io"
	"net/http"
	"net/http/httptest"
	"reflect"
	"strings"
	"testing"

	"github.com/firecrawl/firecrawl/apps/go-sdk/option"
)

// capturedRequest ferries the request the httptest handler received to the
// test goroutine over a channel. Plain shared variables would trip the race
// detector (the handler runs on its own goroutine), and t.Fatal inside the
// handler would Goexit without writing a response, surfacing as a connection
// error instead of the assertion message.
type capturedRequest struct {
	method string
	path   string
	query  string
	body   string
}

func captureRequest(r *http.Request) capturedRequest {
	c := capturedRequest{method: r.Method, path: r.URL.Path, query: r.URL.RawQuery}
	if r.Body != nil {
		data, _ := io.ReadAll(r.Body)
		c.body = string(data)
	}
	return c
}

func TestStartAgentSendsEffort(t *testing.T) {
	captured := make(chan capturedRequest, 1)

	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		captured <- captureRequest(r)

		w.Header().Set("Content-Type", "application/json")
		w.WriteHeader(http.StatusOK)
		_, _ = w.Write([]byte(`{"success":true,"id":"job-123"}`))
	}))
	defer server.Close()

	client, err := NewClient(
		option.WithAPIKey("fc-test"),
		option.WithAPIURL(server.URL),
	)
	if err != nil {
		t.Fatalf("NewClient: %v", err)
	}

	resp, err := client.StartAgent(context.Background(), &AgentOptions{
		Prompt: "find pricing",
		Model:  String("spark-2"),
		Effort: String("high"),
	})
	if err != nil {
		t.Fatalf("StartAgent: %v", err)
	}

	req := <-captured
	if req.method != http.MethodPost || req.path != "/v2/agent" {
		t.Errorf("unexpected request: %s %s", req.method, req.path)
	}
	if resp.ID != "job-123" {
		t.Errorf("id = %q, want job-123", resp.ID)
	}
	if !strings.Contains(req.body, `"effort":"high"`) {
		t.Errorf("request body missing effort: %q", req.body)
	}
	if !strings.Contains(req.body, `"model":"spark-2"`) {
		t.Errorf("request body missing model: %q", req.body)
	}
}

func TestStartAgentOmitsEffortWhenUnset(t *testing.T) {
	captured := make(chan capturedRequest, 1)

	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		captured <- captureRequest(r)

		w.Header().Set("Content-Type", "application/json")
		w.WriteHeader(http.StatusOK)
		_, _ = w.Write([]byte(`{"success":true,"id":"job-123"}`))
	}))
	defer server.Close()

	client, err := NewClient(
		option.WithAPIKey("fc-test"),
		option.WithAPIURL(server.URL),
	)
	if err != nil {
		t.Fatalf("NewClient: %v", err)
	}

	if _, err := client.StartAgent(context.Background(), &AgentOptions{Prompt: "find pricing"}); err != nil {
		t.Fatalf("StartAgent: %v", err)
	}

	req := <-captured
	if strings.Contains(req.body, `"effort"`) {
		t.Errorf("request body should omit effort: %q", req.body)
	}
}

func TestGetAgentTraceParsesEvents(t *testing.T) {
	captured := make(chan capturedRequest, 1)

	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		captured <- captureRequest(r)

		w.Header().Set("Content-Type", "application/json")
		w.WriteHeader(http.StatusOK)
		_, _ = w.Write([]byte(`{
			"success": true,
			"id": "job-123",
			"creditsUsed": 5,
			"events": [
				{
					"type": "run.started",
					"schemaVersion": 1,
					"eventId": "evt-1",
					"runId": "job-123",
					"occurredAt": "2026-08-26T10:00:00Z",
					"producerSequence": 1,
					"agent": {"id": "agent-1", "role": "primary", "name": "spark-2"}
				},
				{
					"type": "artifact.updated",
					"schemaVersion": 1,
					"eventId": "evt-2",
					"runId": "job-123",
					"occurredAt": "2026-08-26T10:00:05Z",
					"producerSequence": 2,
					"agent": {"id": "agent-1", "role": "primary", "name": "spark-2"},
					"artifact": {
						"kind": "json",
						"artifactId": "art-1",
						"path": "plans",
						"snapshotId": "snap-1",
						"change": "updated",
						"changedFields": ["plans"],
						"itemCount": 3,
						"sourceToolCallId": "tc-1"
					}
				}
			]
		}`))
	}))
	defer server.Close()

	client, err := NewClient(
		option.WithAPIKey("fc-test"),
		option.WithAPIURL(server.URL),
	)
	if err != nil {
		t.Fatalf("NewClient: %v", err)
	}

	trace, err := client.GetAgentTrace(context.Background(), "job-123", false)
	if err != nil {
		t.Fatalf("GetAgentTrace: %v", err)
	}

	req := <-captured
	if req.method != http.MethodGet || req.path != "/v2/agent/job-123/trace" {
		t.Errorf("unexpected request: %s %s", req.method, req.path)
	}
	if req.query != "" {
		t.Errorf("unexpected query params: %q", req.query)
	}
	if !trace.Success || trace.ID != "job-123" {
		t.Fatalf("trace = %+v", trace)
	}
	if trace.CreditsUsed == nil || *trace.CreditsUsed != 5 {
		t.Fatalf("creditsUsed = %v, want 5", trace.CreditsUsed)
	}
	if len(trace.Events) != 2 {
		t.Fatalf("events len = %d, want 2", len(trace.Events))
	}

	started := trace.Events[0]
	if started.Type != "run.started" || started.EventID != "evt-1" || started.RunID != "job-123" {
		t.Fatalf("run.started event = %+v", started)
	}
	if started.SchemaVersion != 1 || started.ProducerSequence != 1 || started.OccurredAt != "2026-08-26T10:00:00Z" {
		t.Fatalf("run.started base fields = %+v", started)
	}
	if started.Agent.ID != "agent-1" || started.Agent.Role != "primary" || started.Agent.Name != "spark-2" {
		t.Fatalf("run.started agent = %+v", started.Agent)
	}

	updated := trace.Events[1]
	if updated.Type != "artifact.updated" || updated.Artifact == nil {
		t.Fatalf("artifact.updated event = %+v", updated)
	}
	artifact := updated.Artifact
	if artifact.Kind != "json" || artifact.ArtifactID != "art-1" || artifact.SnapshotID != "snap-1" || artifact.Change != "updated" {
		t.Fatalf("artifact = %+v", artifact)
	}
	if artifact.Path != "plans" || artifact.SourceToolCallID != "tc-1" {
		t.Fatalf("artifact = %+v", artifact)
	}
	if len(artifact.ChangedFields) != 1 || artifact.ChangedFields[0] != "plans" {
		t.Fatalf("changedFields = %v", artifact.ChangedFields)
	}
	if artifact.ItemCount == nil || *artifact.ItemCount != 3 {
		t.Fatalf("itemCount = %v, want 3", artifact.ItemCount)
	}
}

func TestGetAgentTraceSendsLiveView(t *testing.T) {
	captured := make(chan capturedRequest, 1)

	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		captured <- captureRequest(r)

		w.Header().Set("Content-Type", "application/json")
		w.WriteHeader(http.StatusOK)
		_, _ = w.Write([]byte(`{
			"success": true,
			"id": "job-123",
			"events": [],
			"activeBrowserSessions": [
				{
					"id": "session-1",
					"liveViewUrl": "https://live.firecrawl.dev/session-1",
					"viewport": {"width": 1280, "height": 720}
				}
			]
		}`))
	}))
	defer server.Close()

	client, err := NewClient(
		option.WithAPIKey("fc-test"),
		option.WithAPIURL(server.URL),
	)
	if err != nil {
		t.Fatalf("NewClient: %v", err)
	}

	trace, err := client.GetAgentTrace(context.Background(), "job-123", true)
	if err != nil {
		t.Fatalf("GetAgentTrace: %v", err)
	}

	req := <-captured
	if req.method != http.MethodGet || req.path != "/v2/agent/job-123/trace" {
		t.Errorf("unexpected request: %s %s", req.method, req.path)
	}
	if req.query != "liveView=true" {
		t.Errorf("liveView query param = %q, want true", req.query)
	}
	if len(trace.ActiveBrowserSessions) != 1 {
		t.Fatalf("activeBrowserSessions len = %d, want 1", len(trace.ActiveBrowserSessions))
	}
	session := trace.ActiveBrowserSessions[0]
	if session.ID != "session-1" || session.LiveViewURL != "https://live.firecrawl.dev/session-1" {
		t.Fatalf("session = %+v", session)
	}
	if session.Viewport.Width != 1280 || session.Viewport.Height != 720 {
		t.Fatalf("viewport = %+v", session.Viewport)
	}
}

func TestGetAgentTraceRequiresJobID(t *testing.T) {
	client, err := NewClient(
		option.WithAPIKey("fc-test"),
		option.WithAPIURL("http://localhost:0"),
	)
	if err != nil {
		t.Fatalf("NewClient: %v", err)
	}

	if _, err := client.GetAgentTrace(context.Background(), "", false); err == nil {
		t.Fatalf("expected error for empty job ID")
	}
}

func TestGetAgentSnapshotParsesResponse(t *testing.T) {
	captured := make(chan capturedRequest, 1)

	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		captured <- captureRequest(r)

		w.Header().Set("Content-Type", "application/json")
		w.WriteHeader(http.StatusOK)
		_, _ = w.Write([]byte(`{
			"success": true,
			"id": "job-123",
			"snapshotId": "snap-1",
			"snapshot": "{\"plans\":[{\"name\":\"pro\",\"price\":\"$20\"}]}"
		}`))
	}))
	defer server.Close()

	client, err := NewClient(
		option.WithAPIKey("fc-test"),
		option.WithAPIURL(server.URL),
	)
	if err != nil {
		t.Fatalf("NewClient: %v", err)
	}

	snapshot, err := client.GetAgentSnapshot(context.Background(), "job-123", "snap-1")
	if err != nil {
		t.Fatalf("GetAgentSnapshot: %v", err)
	}

	req := <-captured
	if req.method != http.MethodGet || req.path != "/v2/agent/job-123/snapshots/snap-1" {
		t.Errorf("unexpected request: %s %s", req.method, req.path)
	}
	if !snapshot.Success || snapshot.ID != "job-123" || snapshot.SnapshotID != "snap-1" {
		t.Fatalf("snapshot = %+v", snapshot)
	}
	if !strings.Contains(snapshot.Snapshot, `"plans"`) {
		t.Errorf("snapshot content = %q", snapshot.Snapshot)
	}
}

func TestGetAgentSnapshotRequiresIDs(t *testing.T) {
	client, err := NewClient(
		option.WithAPIKey("fc-test"),
		option.WithAPIURL("http://localhost:0"),
	)
	if err != nil {
		t.Fatalf("NewClient: %v", err)
	}

	if _, err := client.GetAgentSnapshot(context.Background(), "", "snap-1"); err == nil {
		t.Fatalf("expected error for empty job ID")
	}
	if _, err := client.GetAgentSnapshot(context.Background(), "job-123", ""); err == nil {
		t.Fatalf("expected error for empty snapshot ID")
	}
}

func TestListAgentsParsesResponse(t *testing.T) {
	captured := make(chan capturedRequest, 1)

	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		captured <- captureRequest(r)

		w.Header().Set("Content-Type", "application/json")
		w.WriteHeader(http.StatusOK)
		_, _ = w.Write([]byte(`{
			"success": true,
			"agents": [{
				"id": "018f3c5e-0000-7000-8000-000000000000",
				"createdAt": "2026-08-31T12:00:00.000Z",
				"targetHint": "https://example.com",
				"origin": "api",
				"settings": {"hidden": false, "starred": true, "label": "prod"},
				"status": "completed",
				"options": {"urls": ["https://example.com"], "prompt": "find pricing", "model": "spark-1-pro"}
			}]
		}`))
	}))
	defer server.Close()

	client, err := NewClient(
		option.WithAPIKey("fc-test"),
		option.WithAPIURL(server.URL),
	)
	if err != nil {
		t.Fatalf("NewClient: %v", err)
	}

	resp, err := client.ListAgents(context.Background(), nil)
	if err != nil {
		t.Fatalf("ListAgents: %v", err)
	}

	req := <-captured
	if req.method != http.MethodGet || req.path != "/v2/agent" {
		t.Errorf("unexpected request: %s %s", req.method, req.path)
	}
	if req.query != "" {
		t.Errorf("query = %q, want empty", req.query)
	}
	if len(resp.Agents) != 1 {
		t.Fatalf("agents = %+v", resp.Agents)
	}
	agent := resp.Agents[0]
	if agent.ID != "018f3c5e-0000-7000-8000-000000000000" || agent.Status != "completed" {
		t.Errorf("agent = %+v", agent)
	}
	if !agent.Settings.Starred || agent.Settings.Label != "prod" {
		t.Errorf("settings = %+v", agent.Settings)
	}
	if agent.Options == nil || agent.Options.Prompt != "find pricing" {
		t.Errorf("options = %+v", agent.Options)
	}
	if resp.Next != "" {
		t.Errorf("next = %q, want empty", resp.Next)
	}
}

func TestListAgentsSendsBefore(t *testing.T) {
	captured := make(chan capturedRequest, 1)

	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		captured <- captureRequest(r)

		w.Header().Set("Content-Type", "application/json")
		w.WriteHeader(http.StatusOK)
		_, _ = w.Write([]byte(`{"success":true,"agents":[],"next":"https://api.firecrawl.dev/v2/agent?before=1756600000000"}`))
	}))
	defer server.Close()

	client, err := NewClient(
		option.WithAPIKey("fc-test"),
		option.WithAPIURL(server.URL),
	)
	if err != nil {
		t.Fatalf("NewClient: %v", err)
	}

	before := int64(1756600000000)
	resp, err := client.ListAgents(context.Background(), &ListAgentsOptions{Before: &before})
	if err != nil {
		t.Fatalf("ListAgents: %v", err)
	}

	req := <-captured
	if req.method != http.MethodGet || req.path != "/v2/agent" {
		t.Errorf("unexpected request: %s %s", req.method, req.path)
	}
	if req.query != "before=1756600000000" {
		t.Errorf("query = %q, want before=1756600000000", req.query)
	}
	if resp.Next != "https://api.firecrawl.dev/v2/agent?before=1756600000000" {
		t.Errorf("next = %q", resp.Next)
	}
}

func TestStartAgentSendsExchangeThreadAndMode(t *testing.T) {
	captured := make(chan capturedRequest, 1)

	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		captured <- captureRequest(r)

		w.Header().Set("Content-Type", "application/json")
		w.WriteHeader(http.StatusOK)
		_, _ = w.Write([]byte(`{"success":true,"id":"job-2","threadId":"11111111-1111-4111-8111-111111111111","threadTurn":2}`))
	}))
	defer server.Close()

	client, err := NewClient(
		option.WithAPIKey("fc-test"),
		option.WithAPIURL(server.URL),
	)
	if err != nil {
		t.Fatalf("NewClient: %v", err)
	}

	resp, err := client.StartAgent(context.Background(), &AgentOptions{
		Prompt:   "go ahead",
		ThreadID: String("11111111-1111-4111-8111-111111111111"),
		Mode:     String("chat"),
		Exchange: &AgentExchangeOptions{
			Enabled:         Bool(true),
			Toolkits:        &[]string{"acme-markets", "acme-companies"},
			MaxCalls:        Int(5),
			RequireApproval: Bool(true),
			Approve: &AgentExchangeApprove{
				ApprovalID: "22222222-2222-4222-8222-222222222222",
				CallIDs:    &[]string{"call-1", "call-2"},
				Always:     Bool(false),
			},
			Decline:         &AgentExchangeDecline{ApprovalID: "33333333-3333-4333-8333-333333333333"},
			OnTermsRequired: String("ask"),
		},
	})
	if err != nil {
		t.Fatalf("StartAgent: %v", err)
	}

	req := <-captured
	if req.method != http.MethodPost || req.path != "/v2/agent" {
		t.Errorf("unexpected request: %s %s", req.method, req.path)
	}
	var body map[string]interface{}
	if err := json.Unmarshal([]byte(req.body), &body); err != nil {
		t.Fatalf("decode body %q: %v", req.body, err)
	}
	var want map[string]interface{}
	if err := json.Unmarshal([]byte(`{
		"prompt": "go ahead",
		"threadId": "11111111-1111-4111-8111-111111111111",
		"mode": "chat",
		"exchange": {
			"enabled": true,
			"toolkits": ["acme-markets", "acme-companies"],
			"maxCalls": 5,
			"requireApproval": true,
			"approve": {
				"approvalId": "22222222-2222-4222-8222-222222222222",
				"callIds": ["call-1", "call-2"],
				"always": false
			},
			"decline": {"approvalId": "33333333-3333-4333-8333-333333333333"},
			"onTermsRequired": "ask"
		}
	}`), &want); err != nil {
		t.Fatalf("decode want: %v", err)
	}
	if !reflect.DeepEqual(body, want) {
		t.Errorf("body = %s", req.body)
	}
	if resp.ThreadID != "11111111-1111-4111-8111-111111111111" || resp.ThreadTurn != 2 {
		t.Errorf("resp = %+v", resp)
	}
}

func TestStartAgentOmitsUnsetExchangeFields(t *testing.T) {
	tests := []struct {
		name string
		opts *AgentOptions
		want string
	}{
		{
			name: "no exchange",
			opts: &AgentOptions{Prompt: "find pricing"},
			want: `{"prompt":"find pricing"}`,
		},
		{
			name: "partial exchange",
			opts: &AgentOptions{
				Prompt: "find pricing",
				Exchange: &AgentExchangeOptions{
					Enabled: Bool(true),
					Approve: &AgentExchangeApprove{ApprovalID: "22222222-2222-4222-8222-222222222222"},
				},
			},
			want: `{"prompt":"find pricing","exchange":{"enabled":true,"approve":{"approvalId":"22222222-2222-4222-8222-222222222222"}}}`,
		},
		{
			name: "explicit empty lists",
			opts: &AgentOptions{
				Prompt: "find pricing",
				Exchange: &AgentExchangeOptions{
					Toolkits: &[]string{},
					Approve: &AgentExchangeApprove{
						ApprovalID: "22222222-2222-4222-8222-222222222222",
						CallIDs:    &[]string{},
					},
				},
			},
			want: `{"prompt":"find pricing","exchange":{"toolkits":[],"approve":{"approvalId":"22222222-2222-4222-8222-222222222222","callIds":[]}}}`,
		},
	}

	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			captured := make(chan capturedRequest, 1)

			server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
				captured <- captureRequest(r)

				w.Header().Set("Content-Type", "application/json")
				w.WriteHeader(http.StatusOK)
				_, _ = w.Write([]byte(`{"success":true,"id":"job-123"}`))
			}))
			defer server.Close()

			client, err := NewClient(
				option.WithAPIKey("fc-test"),
				option.WithAPIURL(server.URL),
			)
			if err != nil {
				t.Fatalf("NewClient: %v", err)
			}

			if _, err := client.StartAgent(context.Background(), tt.opts); err != nil {
				t.Fatalf("StartAgent: %v", err)
			}

			req := <-captured
			if req.body != tt.want {
				t.Errorf("body = %s, want %s", req.body, tt.want)
			}
		})
	}
}

func TestGetAgentStatusParsesExchangeAndPendingApproval(t *testing.T) {
	captured := make(chan capturedRequest, 1)

	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		captured <- captureRequest(r)

		w.Header().Set("Content-Type", "application/json")
		w.WriteHeader(http.StatusOK)
		_, _ = w.Write([]byte(`{
			"success": true,
			"status": "completed",
			"expiresAt": "2026-10-07T00:00:00.000Z",
			"creditsUsed": 12,
			"threadId": "11111111-1111-4111-8111-111111111111",
			"threadTurn": 1,
			"mode": "chat",
			"message": "Two paid lookups need your approval.",
			"suggestions": [{"label": "Approve", "prompt": "Go ahead"}],
			"unknownTopLevel": {"ignored": true},
			"pendingApproval": {
				"id": "22222222-2222-4222-8222-222222222222",
				"kind": "calls",
				"reason": "paid provider call",
				"calls": [{
					"id": "call-1",
					"provider": "acme-markets",
					"capability": "earnings",
					"input": {"ticker": "AAPL"},
					"more": [{"ticker": "MSFT"}],
					"creditsEstimate": 10
				}, {
					"id": "call-2",
					"provider": "acme-companies",
					"capability": "company",
					"input": {"name": "Example"},
					"creditsEstimate": null
				}],
				"resolution": null,
				"unknownNested": 1
			},
			"exchange": {
				"enabled": true,
				"toolkits": ["acme-markets"],
				"requireApproval": true,
				"onTermsRequired": "ask",
				"paidCalls": 0,
				"creditsUsed": null,
				"skippedProviders": [{
					"provider": "acme-funding",
					"name": "Acme Funding",
					"capability": "funding",
					"adds": "funding rounds",
					"reason": "terms_required",
					"version": "2026-01",
					"termsUrl": "https://example.com/terms/acme-funding"
				}],
				"requiresAction": {
					"type": "accept_terms",
					"approvalId": "33333333-3333-4333-8333-333333333333",
					"providers": [{
						"provider": "acme-funding",
						"name": "Acme Funding",
						"version": "2026-01",
						"digest": null,
						"url": "https://example.com/terms/acme-funding",
						"show": {"provider": "firecrawl", "capability": "terms/show", "options": {"provider": "acme-funding"}},
						"accept": {"provider": "firecrawl", "capability": "terms/accept", "options": {"provider": "acme-funding", "version": "2026-01", "digest": null, "confirmed": true}}
					}]
				}
			}
		}`))
	}))
	defer server.Close()

	client, err := NewClient(
		option.WithAPIKey("fc-test"),
		option.WithAPIURL(server.URL),
	)
	if err != nil {
		t.Fatalf("NewClient: %v", err)
	}

	status, err := client.GetAgentStatus(context.Background(), "job-1")
	if err != nil {
		t.Fatalf("GetAgentStatus: %v", err)
	}

	req := <-captured
	if req.method != http.MethodGet || req.path != "/v2/agent/job-1" {
		t.Errorf("unexpected request: %s %s", req.method, req.path)
	}
	if status.ThreadID != "11111111-1111-4111-8111-111111111111" || status.ThreadTurn != 1 || status.Mode != "chat" {
		t.Errorf("thread fields = %+v", status)
	}
	if status.Message != "Two paid lookups need your approval." {
		t.Errorf("message = %q", status.Message)
	}
	if len(status.Suggestions) != 1 || status.Suggestions[0].Prompt != "Go ahead" {
		t.Errorf("suggestions = %+v", status.Suggestions)
	}

	pending := status.PendingApproval
	if pending == nil {
		t.Fatalf("pendingApproval missing")
	}
	if pending.ID != "22222222-2222-4222-8222-222222222222" || pending.Kind != "calls" || pending.Resolution != nil {
		t.Errorf("pendingApproval = %+v", pending)
	}
	if len(pending.Calls) != 2 {
		t.Fatalf("calls = %+v", pending.Calls)
	}
	first := pending.Calls[0]
	if first.ID != "call-1" || first.Provider != "acme-markets" || first.Capability != "earnings" {
		t.Errorf("call = %+v", first)
	}
	if first.Input["ticker"] != "AAPL" || len(first.More) != 1 || first.More[0]["ticker"] != "MSFT" {
		t.Errorf("call payload = %+v", first)
	}
	if first.CreditsEstimate == nil || *first.CreditsEstimate != 10 {
		t.Errorf("creditsEstimate = %v", first.CreditsEstimate)
	}
	if pending.Calls[1].CreditsEstimate != nil {
		t.Errorf("null creditsEstimate = %v", *pending.Calls[1].CreditsEstimate)
	}

	exchange := status.Exchange
	if exchange == nil {
		t.Fatalf("exchange missing")
	}
	if !exchange.Enabled || !exchange.RequireApproval || exchange.OnTermsRequired != "ask" || exchange.PaidCalls != 0 || exchange.CreditsUsed != nil {
		t.Errorf("exchange = %+v", exchange)
	}
	if !reflect.DeepEqual(exchange.Toolkits, []string{"acme-markets"}) {
		t.Errorf("toolkits = %v", exchange.Toolkits)
	}
	wantSkipped := []AgentSkippedProvider{{
		Provider:   "acme-funding",
		Name:       "Acme Funding",
		Capability: "funding",
		Adds:       "funding rounds",
		Reason:     "terms_required",
		Version:    "2026-01",
		TermsURL:   "https://example.com/terms/acme-funding",
	}}
	if !reflect.DeepEqual(exchange.SkippedProviders, wantSkipped) {
		t.Errorf("skippedProviders = %+v", exchange.SkippedProviders)
	}

	action := exchange.RequiresAction
	if action == nil || action.Type != "accept_terms" || action.ApprovalID != "33333333-3333-4333-8333-333333333333" || len(action.Providers) != 1 {
		t.Fatalf("requiresAction = %+v", action)
	}
	provider := action.Providers[0]
	if provider.Provider != "acme-funding" || provider.Version != "2026-01" || provider.Digest != "" || provider.URL != "https://example.com/terms/acme-funding" {
		t.Errorf("provider = %+v", provider)
	}
	if provider.Show.Capability != "terms/show" || provider.Show.Options["provider"] != "acme-funding" {
		t.Errorf("show = %+v", provider.Show)
	}
	if provider.Accept.Provider != "firecrawl" || provider.Accept.Capability != "terms/accept" || provider.Accept.Options["confirmed"] != true {
		t.Errorf("accept = %+v", provider.Accept)
	}
}
