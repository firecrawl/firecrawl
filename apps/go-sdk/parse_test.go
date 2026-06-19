package firecrawl

import (
	"context"
	"encoding/json"
	"io"
	"mime"
	"mime/multipart"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"

	"github.com/firecrawl/firecrawl/apps/go-sdk/option"
)

func TestParseSendsMultipartRequest(t *testing.T) {
	var (
		gotOptions  string
		gotFilename string
		gotFileBody string
		gotFileType string
	)

	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.Method != http.MethodPost || r.URL.Path != "/v2/parse" {
			t.Fatalf("unexpected request: %s %s", r.Method, r.URL.Path)
		}

		mediaType, params, err := mime.ParseMediaType(r.Header.Get("Content-Type"))
		if err != nil {
			t.Fatalf("parse content-type: %v", err)
		}
		if mediaType != "multipart/form-data" {
			t.Fatalf("expected multipart/form-data, got %q", mediaType)
		}

		mr := multipart.NewReader(r.Body, params["boundary"])
		for {
			part, err := mr.NextPart()
			if err == io.EOF {
				break
			}
			if err != nil {
				t.Fatalf("read part: %v", err)
			}
			data, _ := io.ReadAll(part)
			switch part.FormName() {
			case "options":
				gotOptions = string(data)
			case "file":
				gotFilename = part.FileName()
				gotFileBody = string(data)
				gotFileType = part.Header.Get("Content-Type")
			}
		}

		w.Header().Set("Content-Type", "application/json")
		w.WriteHeader(http.StatusOK)
		_, _ = w.Write([]byte(`{"success":true,"data":{"markdown":"# Hello"}}`))
	}))
	defer server.Close()

	client, err := NewClient(
		option.WithAPIKey("fc-test"),
		option.WithAPIURL(server.URL),
	)
	if err != nil {
		t.Fatalf("NewClient: %v", err)
	}

	file := NewParseFileFromBytes("upload.html", []byte("<html>hi</html>"))
	file.ContentType = "text/html"

	doc, err := client.Parse(context.Background(), file, &ParseOptions{
		Formats:         []string{"markdown"},
		OnlyMainContent: Bool(true),
		RedactPII:       Bool(true),
	})
	if err != nil {
		t.Fatalf("Parse: %v", err)
	}

	if doc.Markdown != "# Hello" {
		t.Errorf("markdown = %q, want %q", doc.Markdown, "# Hello")
	}
	if !strings.Contains(gotOptions, `"formats":["markdown"]`) {
		t.Errorf("options missing formats: %q", gotOptions)
	}
	if !strings.Contains(gotOptions, `"onlyMainContent":true`) {
		t.Errorf("options missing onlyMainContent: %q", gotOptions)
	}
	if !strings.Contains(gotOptions, `"redactPII":true`) {
		t.Errorf("options missing redactPII: %q", gotOptions)
	}
	if gotFilename != "upload.html" {
		t.Errorf("filename = %q, want upload.html", gotFilename)
	}
	if gotFileBody != "<html>hi</html>" {
		t.Errorf("file body = %q", gotFileBody)
	}
	if gotFileType != "text/html" {
		t.Errorf("file content-type = %q, want text/html", gotFileType)
	}
}

func TestParseRejectsEmptyFilename(t *testing.T) {
	client, err := NewClient(
		option.WithAPIKey("fc-test"),
		option.WithAPIURL("http://localhost:0"),
	)
	if err != nil {
		t.Fatalf("NewClient: %v", err)
	}

	_, err = client.Parse(context.Background(), &ParseFile{Filename: "  ", Content: []byte("x")}, nil)
	if err == nil {
		t.Fatalf("expected error for empty filename")
	}
}

func TestParseRejectsEmptyContent(t *testing.T) {
	client, err := NewClient(
		option.WithAPIKey("fc-test"),
		option.WithAPIURL("http://localhost:0"),
	)
	if err != nil {
		t.Fatalf("NewClient: %v", err)
	}

	_, err = client.Parse(context.Background(), &ParseFile{Filename: "doc.pdf"}, nil)
	if err == nil {
		t.Fatalf("expected error for empty content")
	}
}

func TestDocumentUnmarshalsMenu(t *testing.T) {
	raw := []byte(`{
		"markdown": "# Cafe",
		"menu": {
			"isMenu": true,
			"confidence": 0.92,
			"merchant": {"name": "Test Cafe", "type": "restaurant"},
			"currency": "USD",
			"sourceUrl": "https://example.com/menu",
			"sections": [
				{
					"id": "drinks",
					"name": "Drinks",
					"items": [
						{
							"id": "latte",
							"name": "Latte",
							"availability": {"inStock": true},
							"price": {"amount": 4.5, "currency": "USD"},
							"identifiers": {"merchantItemId": "sku-1"},
							"sourceUrl": "https://example.com/menu"
						}
					]
				}
			]
		}
	}`)

	var doc Document
	if err := json.Unmarshal(raw, &doc); err != nil {
		t.Fatalf("Unmarshal: %v", err)
	}

	if doc.Menu == nil {
		t.Fatalf("expected menu, got nil")
	}
	if !doc.Menu.IsMenu {
		t.Errorf("isMenu = false, want true")
	}
	if doc.Menu.Confidence != 0.92 {
		t.Errorf("confidence = %v, want 0.92", doc.Menu.Confidence)
	}
	if doc.Menu.Merchant.Name != "Test Cafe" {
		t.Errorf("merchant.name = %q, want %q", doc.Menu.Merchant.Name, "Test Cafe")
	}
	if len(doc.Menu.Sections) != 1 {
		t.Fatalf("sections = %d, want 1", len(doc.Menu.Sections))
	}
	items := doc.Menu.Sections[0].Items
	if len(items) != 1 {
		t.Fatalf("items = %d, want 1", len(items))
	}
	if items[0].Name != "Latte" {
		t.Errorf("item name = %q, want %q", items[0].Name, "Latte")
	}
	if !items[0].Availability.InStock {
		t.Errorf("item availability inStock = false, want true")
	}
}
