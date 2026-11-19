package firecrawl

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net/http"
	"net/http/httptest"
	"sync"
	"sync/atomic"
	"testing"

	"github.com/firecrawl/firecrawl/apps/go-sdk/option"
)

type replayJSONValue struct {
	calls          int
	failAfterFirst bool
	failFirst      bool
}

func (v *replayJSONValue) MarshalJSON() ([]byte, error) {
	v.calls++
	if v.failFirst || (v.failAfterFirst && v.calls > 1) {
		return nil, errors.New("value cannot be serialized again")
	}
	return []byte(fmt.Sprintf(`{"sequence":%d}`, v.calls)), nil
}

func TestAlexandriaRetryReplaysSerializedJSON(t *testing.T) {
	for _, failAfterFirst := range []bool{false, true} {
		t.Run(fmt.Sprintf("second_marshal_error=%v", failAfterFirst), func(t *testing.T) {
			var mu sync.Mutex
			var payloads []string
			var ids []string
			server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
				raw, _ := io.ReadAll(r.Body)
				mu.Lock()
				payloads = append(payloads, string(raw))
				ids = append(ids, r.Header.Get("x-request-id"))
				first := len(payloads) == 1
				mu.Unlock()
				if first {
					w.WriteHeader(http.StatusServiceUnavailable)
					_, _ = w.Write([]byte(`{"error":"try again"}`))
					return
				}
				_, _ = w.Write([]byte(`{"scrape_id":"fixture","data":{"alexandria":[],"creditsCost":0}}`))
			}))
			defer server.Close()
			client, err := NewClient(option.WithAPIURL(server.URL), option.WithHTTPClient(server.Client()), option.WithMaxRetries(1), option.WithBackoffFactor(0))
			if err != nil {
				t.Fatal(err)
			}
			value := &replayJSONValue{failAfterFirst: failAfterFirst}
			result, err := client.ScrapeAlexandria(context.Background(), []AlexandriaCall{{Provider: "fixture", Capability: "query", Options: map[string]interface{}{"value": value}}}, &AlexandriaOptions{RequestID: "retry-fixture"})
			if err != nil || result == nil || result.RequestID != "retry-fixture" {
				t.Fatalf("retry did not complete: result=%+v error=%v", result, err)
			}
			mu.Lock()
			defer mu.Unlock()
			if len(payloads) != 2 || payloads[0] != payloads[1] || !json.Valid([]byte(payloads[1])) {
				t.Fatalf("retry changed serialized payload: %#v", payloads)
			}
			if ids[0] != "retry-fixture" || ids[1] != ids[0] {
				t.Fatalf("retry changed request ID: %#v", ids)
			}
			if value.calls != 1 {
				t.Fatalf("serialized value %d times, want once", value.calls)
			}
		})
	}
}

func TestAlexandriaInitialMarshalFailureDoesNotSend(t *testing.T) {
	var calls atomic.Int32
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) { calls.Add(1); _, _ = w.Write([]byte(`{}`)) }))
	defer server.Close()
	client, err := NewClient(option.WithAPIURL(server.URL), option.WithHTTPClient(server.Client()), option.WithMaxRetries(1), option.WithBackoffFactor(0))
	if err != nil {
		t.Fatal(err)
	}
	result, err := client.ScrapeAlexandria(context.Background(), []AlexandriaCall{{Provider: "fixture", Capability: "query", Options: map[string]interface{}{"value": &replayJSONValue{failFirst: true}}}}, &AlexandriaOptions{RequestID: "retry-fixture"})
	var wrapped *AlexandriaExecutionError
	if result != nil || !errors.As(err, &wrapped) || wrapped.RequestID != "retry-fixture" || calls.Load() != 0 {
		t.Fatalf("initial serialization failure sent payload or lost ID: result=%+v error=%v calls=%d", result, err, calls.Load())
	}
}
