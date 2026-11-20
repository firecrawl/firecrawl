package main

import (
	"bytes"
	"encoding/json"
	"io"
	"net/http"
	"net/http/httptest"
	"strconv"
	"strings"
	"testing"

	"github.com/gorilla/mux"
)

func TestConvertHTMLJSONWire(t *testing.T) {
	converter := NewConverter()
	router := mux.NewRouter()
	NewHandler(converter).RegisterRoutes(router)
	server := httptest.NewServer(router)
	t.Cleanup(server.Close)

	cases := []struct {
		name string
		html string
	}{
		{"plain", "<p>Hello, world.</p>"},
		{"ampersand", "<p>Research &amp; Development</p>"},
		{"code", "<pre><code>if (x &lt; y &amp;&amp; y &gt; 0) {\n  print(\"ok\");\n}</code></pre>"},
		{"query_link", `<a href="https://example.org/search?a=1&amp;b=2">Results</a>`},
		{"unicode", "<p>中文 🧪 café \u2028 next \u2029 paragraph</p>"},
		{"json_controls", "<pre><code>quote \" path \\ tab\t next\nline</code></pre>"},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			expected, err := converter.ConvertHTMLToMarkdown(tc.html)
			if err != nil {
				t.Fatal(err)
			}
			payload, err := json.Marshal(ConvertRequest{HTML: tc.html})
			if err != nil {
				t.Fatal(err)
			}
			request, err := http.NewRequest(http.MethodPost, server.URL+"/convert", bytes.NewReader(payload))
			if err != nil {
				t.Fatal(err)
			}
			request.Header.Set("Content-Type", "application/json")
			request.Header.Set("X-Zero-Data-Retention", "true")
			response, err := server.Client().Do(request)
			if err != nil {
				t.Fatal(err)
			}
			defer response.Body.Close()
			wire, err := io.ReadAll(response.Body)
			if err != nil {
				t.Fatal(err)
			}
			if response.StatusCode != http.StatusOK || response.Header.Get("Content-Type") != "application/json" {
				t.Fatalf("unexpected HTTP response: status=%d content-type=%q", response.StatusCode, response.Header.Get("Content-Type"))
			}
			var decoded ConvertResponse
			if err := json.Unmarshal(wire, &decoded); err != nil {
				t.Fatal(err)
			}
			if !decoded.Success || decoded.Markdown != expected {
				t.Fatalf("JSON round trip changed the conversion: got %#v, want %q", decoded, expected)
			}
			legacy, err := json.Marshal(ConvertResponse{Markdown: expected, Success: true})
			if err != nil {
				t.Fatal(err)
			}
			// A literal &, <, or > uses one byte rather than a six-byte HTML escape.
			characters := strings.Count(expected, "&") + strings.Count(expected, "<") + strings.Count(expected, ">")
			wantBytes := len(legacy) + 1 - 5*characters
			if len(wire) != wantBytes {
				t.Errorf("JSON response uses %d bytes; want %d without HTML-only escapes", len(wire), wantBytes)
			}
		})
	}
}

func BenchmarkConvertHTMLJSON(b *testing.B) {
	fixtures := []struct {
		name string
		html string
	}{
		{"prose", "<p>A document with ordinary words and punctuation.</p>\n"},
		{"links", `<p><a href="https://example.org/search?category=books&amp;page=2&amp;sort=recent">Search results</a></p>`},
		{"code", "<pre><code>if (item &lt; limit &amp;&amp; limit &gt; 0) {\n  result &amp;= item;\n}</code></pre>\n"},
	}
	for _, fixture := range fixtures {
		for _, repeats := range []int{128, 2048} {
			b.Run(fixture.name+"/"+strconv.Itoa(repeats), func(b *testing.B) {
				html := strings.Repeat(fixture.html, repeats)
				payload, err := json.Marshal(ConvertRequest{HTML: html})
				if err != nil {
					b.Fatal(err)
				}
				handler := NewHandler(NewConverter())
				b.ReportAllocs()
				b.SetBytes(int64(len(payload)))
				b.ResetTimer()
				responseBytes := 0
				for i := 0; i < b.N; i++ {
					request := httptest.NewRequest(http.MethodPost, "/convert", bytes.NewReader(payload))
					request.Header.Set("X-Zero-Data-Retention", "true")
					response := httptest.NewRecorder()
					handler.ConvertHTML(response, request)
					if response.Code != http.StatusOK {
						b.Fatalf("HTTP %d: %s", response.Code, response.Body)
					}
					responseBytes = response.Body.Len()
				}
				b.ReportMetric(float64(responseBytes), "response-B")
			})
		}
	}
}
