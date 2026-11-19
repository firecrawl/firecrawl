package option

import (
	"reflect"
	"testing"
)

func TestWithHeaderReplacesCaseInsensitiveNames(t *testing.T) {
	for _, names := range [][]string{
		{"X-Request-ID", "x-request-id", "X-Request-Id"},
		{"authorization", "AUTHORIZATION", "Authorization"},
		{"User-Agent", "user-agent", "User-Agent"},
	} {
		t.Run(names[2], func(t *testing.T) {
			cfg := &RequestConfig{}
			WithHeader(names[0], "old")(cfg)
			WithHeader(names[1], "new")(cfg)
			want := map[string]string{names[2]: "new"}
			if !reflect.DeepEqual(cfg.ExtraHeaders, want) {
				t.Fatalf("headers = %#v, want %#v", cfg.ExtraHeaders, want)
			}
		})
	}
}

func TestWithHeaderPreservesOtherHeadersAndEmptyOverrides(t *testing.T) {
	cfg := &RequestConfig{}
	WithHeader("x-trace-id", "trace")(cfg)
	WithHeader("X-Request-ID", "old")(cfg)
	WithHeader("x-request-id", "")(cfg)
	want := map[string]string{"X-Trace-Id": "trace", "X-Request-Id": ""}
	if !reflect.DeepEqual(cfg.ExtraHeaders, want) {
		t.Fatalf("headers = %#v, want %#v", cfg.ExtraHeaders, want)
	}
}

func TestWithHeaderOptionsCanBeReusedAcrossClients(t *testing.T) {
	shared := WithHeader("x-trace-id", "shared")
	first, second := &RequestConfig{}, &RequestConfig{}
	shared(first)
	shared(second)
	WithHeader("X-Trace-ID", "first-only")(first)
	if got := second.ExtraHeaders["X-Trace-Id"]; got != "shared" {
		t.Fatalf("second client's header = %q, want shared", got)
	}
}
