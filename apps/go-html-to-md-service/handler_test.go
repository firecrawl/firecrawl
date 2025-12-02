package main

import (
	"bytes"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"testing"

	"github.com/gorilla/mux"
)

func TestHealthCheck(t *testing.T) {
	converter := NewConverter()
	handler := NewHandler(converter)

	router := mux.NewRouter()
	handler.RegisterRoutes(router)

	req, err := http.NewRequest("GET", "/health", nil)
	if err != nil {
		t.Fatal(err)
	}

	rr := httptest.NewRecorder()
	router.ServeHTTP(rr, req)

	if status := rr.Code; status != http.StatusOK {
		t.Errorf("handler returned wrong status code: got %v want %v",
			status, http.StatusOK)
	}

	var response HealthCheckResponse
	if err := json.Unmarshal(rr.Body.Bytes(), &response); err != nil {
		t.Errorf("failed to parse response: %v", err)
	}

	if response.Status != "healthy" {
		t.Errorf("handler returned unexpected status: got %v want %v",
			response.Status, "healthy")
	}

	if response.Service != "html-to-markdown" {
		t.Errorf("handler returned unexpected service: got %v want %v",
			response.Service, "html-to-markdown")
	}
}

func TestIndex(t *testing.T) {
	converter := NewConverter()
	handler := NewHandler(converter)

	router := mux.NewRouter()
	handler.RegisterRoutes(router)

	req, err := http.NewRequest("GET", "/", nil)
	if err != nil {
		t.Fatal(err)
	}

	rr := httptest.NewRecorder()
	router.ServeHTTP(rr, req)

	if status := rr.Code; status != http.StatusOK {
		t.Errorf("handler returned wrong status code: got %v want %v",
			status, http.StatusOK)
	}

	var response IndexResponse
	if err := json.Unmarshal(rr.Body.Bytes(), &response); err != nil {
		t.Errorf("failed to parse response: %v", err)
	}

	if response.Service != "HTML to Markdown Converter" {
		t.Errorf("handler returned unexpected service name")
	}

	if len(response.Endpoints) == 0 {
		t.Errorf("handler returned no endpoints")
	}
}

func TestConvertHTML_Success(t *testing.T) {
	converter := NewConverter()
	handler := NewHandler(converter)

	router := mux.NewRouter()
	handler.RegisterRoutes(router)

	testCases := []struct {
		name           string
		html           string
		expectedOutput string
	}{
		{
			name:           "Simple paragraph",
			html:           "<p>Hello, World!</p>",
			expectedOutput: "Hello, World!",
		},
		{
			name:           "Bold text",
			html:           "<p>This is <strong>bold</strong> text</p>",
			expectedOutput: "**bold**",
		},
		{
			name:           "Link",
			html:           "<a href='https://example.com'>Example</a>",
			expectedOutput: "[Example](https://example.com)",
		},
		{
			name: "Code block",
			html: "<pre><code>console.log('hello');</code></pre>",
		},
		{
			name:           "Inline code",
			html:           "<code>const x = 1;</code>",
			expectedOutput: "`const x = 1;`",
		},
	}

	for _, tc := range testCases {
		t.Run(tc.name, func(t *testing.T) {
			reqBody := ConvertRequest{
				HTML: tc.html,
			}
			jsonBody, _ := json.Marshal(reqBody)

			req, err := http.NewRequest("POST", "/convert", bytes.NewBuffer(jsonBody))
			if err != nil {
				t.Fatal(err)
			}
			req.Header.Set("Content-Type", "application/json")

			rr := httptest.NewRecorder()
			router.ServeHTTP(rr, req)

			if status := rr.Code; status != http.StatusOK {
				t.Errorf("handler returned wrong status code: got %v want %v",
					status, http.StatusOK)
			}

			var response ConvertResponse
			if err := json.Unmarshal(rr.Body.Bytes(), &response); err != nil {
				t.Errorf("failed to parse response: %v", err)
			}

			if !response.Success {
				t.Errorf("conversion was not successful")
			}

			if tc.expectedOutput != "" && response.Markdown == "" {
				t.Errorf("expected markdown output, got empty string")
			}

			// For simple checks, verify expected output is contained in response
			if tc.expectedOutput != "" {
				if !contains(response.Markdown, tc.expectedOutput) {
					t.Errorf("expected markdown to contain %q, got %q",
						tc.expectedOutput, response.Markdown)
				}
			}
		})
	}
}

func TestConvertHTML_EmptyHTML(t *testing.T) {
	converter := NewConverter()
	handler := NewHandler(converter)

	router := mux.NewRouter()
	handler.RegisterRoutes(router)

	reqBody := ConvertRequest{
		HTML: "",
	}
	jsonBody, _ := json.Marshal(reqBody)

	req, err := http.NewRequest("POST", "/convert", bytes.NewBuffer(jsonBody))
	if err != nil {
		t.Fatal(err)
	}
	req.Header.Set("Content-Type", "application/json")

	rr := httptest.NewRecorder()
	router.ServeHTTP(rr, req)

	if status := rr.Code; status != http.StatusBadRequest {
		t.Errorf("handler returned wrong status code: got %v want %v",
			status, http.StatusBadRequest)
	}

	var response ErrorResponse
	if err := json.Unmarshal(rr.Body.Bytes(), &response); err != nil {
		t.Errorf("failed to parse response: %v", err)
	}

	if response.Success {
		t.Errorf("expected success to be false")
	}
}

func TestConvertHTML_InvalidJSON(t *testing.T) {
	converter := NewConverter()
	handler := NewHandler(converter)

	router := mux.NewRouter()
	handler.RegisterRoutes(router)

	req, err := http.NewRequest("POST", "/convert", bytes.NewBuffer([]byte("invalid json")))
	if err != nil {
		t.Fatal(err)
	}
	req.Header.Set("Content-Type", "application/json")

	rr := httptest.NewRecorder()
	router.ServeHTTP(rr, req)

	if status := rr.Code; status != http.StatusBadRequest {
		t.Errorf("handler returned wrong status code: got %v want %v",
			status, http.StatusBadRequest)
	}
}

func TestConverter_ComplexHTML(t *testing.T) {
	converter := NewConverter()

	testHTML := `
	<div>
		<h1>Title</h1>
		<p>This is a paragraph with <strong>bold</strong> and <em>italic</em> text.</p>
		<ul>
			<li>Item 1</li>
			<li>Item 2</li>
		</ul>
		<pre><code class="language-javascript">console.log('hello');</code></pre>
	</div>
	`

	markdown, err := converter.ConvertHTMLToMarkdown(testHTML)
	if err != nil {
		t.Errorf("conversion failed: %v", err)
	}

	if markdown == "" {
		t.Errorf("expected non-empty markdown output")
	}

	// Verify key elements are present
	expectedElements := []string{"Title", "bold", "italic", "Item 1", "console.log"}
	for _, elem := range expectedElements {
		if !contains(markdown, elem) {
			t.Errorf("expected markdown to contain %q, but it didn't", elem)
		}
	}
}

// Helper function to check if a string contains a substring
func contains(s, substr string) bool {
	return bytes.Contains([]byte(s), []byte(substr))
}

