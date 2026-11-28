package firecrawl

import (
	"context"
	"net/http"
	"net/http/httptest"
	"testing"

	"github.com/firecrawl/firecrawl/apps/go-sdk/option"
)

func TestHeaderOptionOrderReachesJSONAndMultipartRequests(t *testing.T) {
	requests := make(chan http.Header, 3)
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		requests <- r.Header.Clone()
		w.Header().Set("Content-Type", "application/json")
		if r.URL.Path == "/v2/parse/formats" {
			_, _ = w.Write([]byte(`{"success":true,"data":{"formats":[]}}`))
			return
		}
		_, _ = w.Write([]byte(`{"success":true,"data":{"markdown":"ok"}}`))
	}))
	defer server.Close()

	client, err := NewClient(
		option.WithAPIURL(server.URL),
		option.WithAPIKey("default-key"),
		option.WithMaxRetries(0),
		option.WithHeader("Authorization", "Bearer old-key"),
		option.WithHeader("authorization", "Bearer final-key"),
		option.WithHeader("X-Request-ID", "old-id"),
		option.WithHeader("x-request-id", "final-id"),
	)
	if err != nil {
		t.Fatal(err)
	}

	for _, tc := range []struct {
		name string
		call func() error
	}{
		{"JSON POST", func() error {
			_, err := client.Scrape(context.Background(), "https://example.com", nil)
			return err
		}},
		{"JSON GET", func() error {
			_, err := client.GetParseFormats(context.Background())
			return err
		}},
		{"multipart POST", func() error {
			_, err := client.Parse(context.Background(), NewParseFileFromBytes("page.html", []byte("<p>ok</p>")), nil)
			return err
		}},
	} {
		t.Run(tc.name, func(t *testing.T) {
			if err := tc.call(); err != nil {
				t.Fatal(err)
			}
			headers := <-requests
			for key, want := range map[string]string{
				"Authorization": "Bearer final-key",
				"X-Request-Id":  "final-id",
			} {
				if got := headers.Values(key); len(got) != 1 || got[0] != want {
					t.Errorf("%s = %q, want [%q]", key, got, want)
				}
			}
		})
	}
}
