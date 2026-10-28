package firecrawl

import (
	"context"
	"errors"
	"fmt"
	"io"
	"net/http"
	"net/http/httptest"
	"sync"
	"sync/atomic"
	"testing"
	"time"

	"github.com/firecrawl/firecrawl/apps/go-sdk/option"
)

type responseReadTransport struct {
	base    http.RoundTripper
	started chan struct{}
}

func (t responseReadTransport) RoundTrip(r *http.Request) (*http.Response, error) {
	resp, err := t.base.RoundTrip(r)
	if err == nil {
		resp.Body = &responseReadBody{ReadCloser: resp.Body, started: t.started}
	}
	return resp, err
}

type responseReadBody struct {
	io.ReadCloser
	started chan struct{}
	once    sync.Once
}

func (b *responseReadBody) Read(p []byte) (int, error) {
	b.once.Do(func() { close(b.started) })
	return b.ReadCloser.Read(p)
}

func TestResponseBodyPreservesCallerContextError(t *testing.T) {
	for _, retries := range []int{0, 2} {
		for _, method := range []string{"scrape", "parse"} {
			for _, deadline := range []bool{false, true} {
				t.Run(fmt.Sprintf("%s/deadline=%v/retries=%d", method, deadline, retries), func(t *testing.T) {
					started := make(chan struct{})
					var calls atomic.Int32
					server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
						calls.Add(1)
						_, _ = io.Copy(io.Discard, r.Body)
						w.WriteHeader(http.StatusOK)
						w.(http.Flusher).Flush()
						// The client transport records when the response body is read.
						<-r.Context().Done()
					}))
					defer server.Close()
					httpClient := server.Client()
					httpClient.Transport = responseReadTransport{base: httpClient.Transport, started: started}
					client, err := NewClient(option.WithAPIURL(server.URL), option.WithHTTPClient(httpClient), option.WithMaxRetries(retries))
					if err != nil {
						t.Fatal(err)
					}
					ctx, cancel := context.WithCancel(context.Background())
					want := context.Canceled
					if deadline {
						cancel()
						ctx, cancel = context.WithTimeout(context.Background(), time.Second)
						want = context.DeadlineExceeded
					}
					defer cancel()
					result := make(chan error, 1)
					go func() {
						if method == "scrape" {
							_, err = client.Scrape(ctx, "https://example.com", nil)
						} else {
							_, err = client.Parse(ctx, NewParseFileFromBytes("fixture.pdf", []byte("pdf")), nil)
						}
						result <- err
					}()
					select {
					case <-started:
					case <-time.After(3 * time.Second):
						t.Fatal("client never started reading the response body")
					}
					if !deadline {
						cancel()
					}
					select {
					case err := <-result:
						if !errors.Is(err, want) {
							t.Fatalf("lost caller context identity: got %T %v, want %v", err, err, want)
						}
					case <-time.After(3 * time.Second):
						t.Fatal("body read ignored cancellation")
					}
					if calls.Load() != 1 {
						t.Fatalf("cancelled request sent %d times", calls.Load())
					}
				})
			}
		}
	}
}

func TestResponseBodyCancellationFixKeepsSuccess(t *testing.T) {
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		_, _ = w.Write([]byte(`{"success":true,"data":{"markdown":"complete"}}`))
	}))
	defer server.Close()
	client, err := NewClient(option.WithAPIURL(server.URL), option.WithHTTPClient(server.Client()), option.WithMaxRetries(0))
	if err != nil {
		t.Fatal(err)
	}
	for _, method := range []string{"scrape", "parse"} {
		var doc *Document
		if method == "scrape" {
			doc, err = client.Scrape(context.Background(), "https://example.com", nil)
		} else {
			doc, err = client.Parse(context.Background(), NewParseFileFromBytes("fixture.pdf", []byte("pdf")), nil)
		}
		if err != nil || doc.Markdown != "complete" {
			t.Fatalf("%s success changed: document=%+v error=%v", method, doc, err)
		}
	}
}

func TestResponseBodyCancellationFixKeepsMalformedJSONError(t *testing.T) {
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) { _, _ = w.Write([]byte(`{"success":`)) }))
	defer server.Close()
	client, err := NewClient(option.WithAPIURL(server.URL), option.WithHTTPClient(server.Client()), option.WithMaxRetries(0))
	if err != nil {
		t.Fatal(err)
	}
	for _, method := range []string{"scrape", "parse"} {
		if method == "scrape" {
			_, err = client.Scrape(context.Background(), "https://example.com", nil)
		} else {
			_, err = client.Parse(context.Background(), NewParseFileFromBytes("fixture.pdf", []byte("pdf")), nil)
		}
		var apiError *FirecrawlError
		if !errors.As(err, &apiError) || errors.Is(err, context.Canceled) || errors.Is(err, context.DeadlineExceeded) {
			t.Fatalf("%s malformed body classification changed: %T %v", method, err, err)
		}
	}
}
