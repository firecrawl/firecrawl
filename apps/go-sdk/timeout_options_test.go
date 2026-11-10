package firecrawl

import (
	"context"
	"fmt"
	"github.com/firecrawl/firecrawl/apps/go-sdk/option"
	"net/http"
	"net/http/httptest"
	"testing"
	"time"
)

func TestTimeoutOptionComposesWithoutMutatingCustomClient(t *testing.T) {
	for _, timeoutFirst := range []bool{true, false} {
		t.Run(fmt.Sprintf("timeout-first=%v", timeoutFirst), func(t *testing.T) {
			transport := http.DefaultTransport.(*http.Transport).Clone()
			defer transport.CloseIdleConnections()
			custom := &http.Client{Transport: transport, Timeout: time.Second}
			server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
				select {
				case <-r.Context().Done():
					return
				case <-time.After(200 * time.Millisecond):
				}
				fmt.Fprint(w, `{"success":true,"data":{"markdown":"fixture"}}`)
			}))
			defer server.Close()
			options := []option.RequestOption{option.WithAPIKey("fc-fixture"), option.WithAPIURL(server.URL)}
			if timeoutFirst {
				options = append(options, option.WithTimeout(20*time.Millisecond), option.WithHTTPClient(custom))
			} else {
				options = append(options, option.WithHTTPClient(custom), option.WithTimeout(20*time.Millisecond))
			}
			client, err := NewClient(options...)
			if err != nil {
				t.Fatal(err)
			}
			if custom.Timeout != time.Second {
				t.Errorf("constructing SDK mutated caller client timeout: %v", custom.Timeout)
			}
			if client.http.client.Transport != transport {
				t.Fatal("lost custom transport")
			}
			_, err = client.Scrape(context.Background(), "https://example.com", nil)
			if err == nil {
				t.Fatal("timeout option was ignored after custom client option")
			}
		})
	}
}
func TestCustomClientWithoutTimeoutOptionRemainsShared(t *testing.T) {
	custom := &http.Client{Timeout: time.Second}
	client, err := NewClient(option.WithHTTPClient(custom))
	if err != nil {
		t.Fatal(err)
	}
	if client.http.client != custom {
		t.Fatal("custom client replaced without override")
	}
}
