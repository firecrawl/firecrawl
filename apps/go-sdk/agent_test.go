package firecrawl

import (
	"context"
	"io"
	"net/http"
	"net/http/httptest"
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
