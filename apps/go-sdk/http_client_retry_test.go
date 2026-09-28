package firecrawl

import (
	"context"
	"errors"
	"fmt"
	"net/http"
	"net/http/httptest"
	"sync/atomic"
	"testing"
)

func TestAmbiguousWriteFailureIsNotRetried(t *testing.T) {
	tests := []struct {
		name string
		run  func(*httpClient) error
	}{
		{"POST", func(c *httpClient) error {
			_, err := c.post(context.Background(), "/v2/crawl", map[string]string{"url": "https://example.com"}, nil)
			return err
		}},
		{"PATCH", func(c *httpClient) error {
			_, err := c.patch(context.Background(), "/v2/monitor/id", map[string]string{"name": "updated"})
			return err
		}},
		{"DELETE", func(c *httpClient) error { _, err := c.delete(context.Background(), "/v2/crawl/id"); return err }},
		{"multipart POST", func(c *httpClient) error {
			_, err := c.postMultipart(context.Background(), "/v2/parse", nil, "file", "report.pdf", "application/pdf", []byte("pdf"))
			return err
		}},
	}

	for _, status := range []int{408, 409, 502, 503} {
		for _, test := range tests {
			t.Run(fmt.Sprintf("%s/%d", test.name, status), func(t *testing.T) {
				var calls atomic.Int32
				server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
					calls.Add(1)
					w.WriteHeader(status)
					_, _ = w.Write([]byte(`{"error":"gateway failed after accepting request"}`))
				}))
				defer server.Close()

				client := newHTTPClient("fc-test", server.URL, server.Client(), 3, 0, nil)
				if err := test.run(client); err == nil {
					t.Fatal("expected gateway error")
				}
				if got := calls.Load(); got != 1 {
					t.Fatalf("sent write %d times; want exactly one", got)
				}
			})
		}
	}
}

type failingTransport struct{ calls atomic.Int32 }

func (f *failingTransport) RoundTrip(*http.Request) (*http.Response, error) {
	f.calls.Add(1)
	return nil, errors.New("response lost")
}

func TestTransportFailureDoesNotReplayWrite(t *testing.T) {
	for _, test := range []struct {
		name string
		run  func(*httpClient) error
	}{
		{"POST", func(c *httpClient) error {
			_, err := c.post(context.Background(), "/v2/crawl", map[string]string{"url": "https://example.com"}, nil)
			return err
		}},
		{"PATCH", func(c *httpClient) error {
			_, err := c.patch(context.Background(), "/v2/monitor/id", map[string]string{"name": "updated"})
			return err
		}},
		{"DELETE", func(c *httpClient) error { _, err := c.delete(context.Background(), "/v2/crawl/id"); return err }},
		{"multipart POST", func(c *httpClient) error {
			_, err := c.postMultipart(context.Background(), "/v2/parse", nil, "file", "report.pdf", "application/pdf", []byte("pdf"))
			return err
		}},
	} {
		t.Run(test.name, func(t *testing.T) {
			transport := &failingTransport{}
			client := newHTTPClient("fc-test", "https://api.firecrawl.dev", &http.Client{Transport: transport}, 3, 0, nil)
			if err := test.run(client); err == nil {
				t.Fatal("expected transport error")
			}
			if got := transport.calls.Load(); got != 1 {
				t.Fatalf("sent write %d times; want exactly one", got)
			}
		})
	}
}

func TestReadStillRetriesBadGateway(t *testing.T) {
	var calls atomic.Int32
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if calls.Add(1) == 1 {
			w.WriteHeader(http.StatusBadGateway)
			return
		}
		_, _ = w.Write([]byte(`{"success":true}`))
	}))
	defer server.Close()

	client := newHTTPClient("fc-test", server.URL, server.Client(), 3, 0, nil)
	if _, err := client.get(context.Background(), "/v2/crawl/id"); err != nil {
		t.Fatal(err)
	}
	if got := calls.Load(); got != 2 {
		t.Fatalf("sent GET %d times; want retry after 502", got)
	}
}
