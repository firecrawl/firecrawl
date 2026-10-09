package firecrawl

import (
	"context"
	"encoding/json"
	"errors"
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
		Formats:              []string{"markdown"},
		OnlyMainContent:      Bool(true),
		RedactPII:            Bool(true),
		CheckPromptInjection: Bool(true),
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
	if !strings.Contains(gotOptions, `"checkPromptInjection":true`) {
		t.Errorf("options missing checkPromptInjection: %q", gotOptions)
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

func TestGetParseFormats(t *testing.T) {
	authCh := make(chan string, 1)
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.Method != http.MethodGet || r.URL.Path != "/v2/parse/formats" {
			t.Errorf("unexpected request: %s %s", r.Method, r.URL.Path)
		}
		authCh <- r.Header.Get("Authorization")
		w.Header().Set("Content-Type", "application/json")
		_, _ = w.Write([]byte(`{"success":true,"data":{"formats":[
			{"format":"pdf","kind":"document","extensions":[".pdf"],"mimeTypes":["application/pdf"],"available":true},
			{"format":"png","kind":"image","extensions":[".png"],"mimeTypes":["image/png"],"available":false},
			{"format":"mp3","kind":"audio","extensions":[".mp3"],"mimeTypes":["audio/mpeg"],"available":true,"maxSizeBytes":1024}
		]}}`))
	}))
	defer server.Close()

	client, err := NewClient(option.WithAPIKey("fc-test"), option.WithAPIURL(server.URL))
	if err != nil {
		t.Fatalf("NewClient: %v", err)
	}

	formats, err := client.GetParseFormats(context.Background())
	if err != nil {
		t.Fatalf("GetParseFormats: %v", err)
	}
	if gotAuth := <-authCh; gotAuth != "Bearer fc-test" {
		t.Errorf("Authorization = %q, want %q", gotAuth, "Bearer fc-test")
	}
	if len(formats) != 3 {
		t.Fatalf("formats = %d, want 3", len(formats))
	}

	pdf := formats[0]
	if pdf.Format != "pdf" || pdf.Kind != ParseFormatKindDocument || !pdf.Available {
		t.Errorf("pdf = %+v", pdf)
	}
	if len(pdf.Extensions) != 1 || pdf.Extensions[0] != ".pdf" {
		t.Errorf("pdf extensions = %v", pdf.Extensions)
	}
	if len(pdf.MimeTypes) != 1 || pdf.MimeTypes[0] != "application/pdf" {
		t.Errorf("pdf mimeTypes = %v", pdf.MimeTypes)
	}

	png := formats[1]
	if png.Kind != ParseFormatKindImage || png.Available {
		t.Errorf("png = %+v", png)
	}

	unknown := formats[2]
	if unknown.Kind != ParseFormatKind("audio") || unknown.Format != "mp3" || unknown.MimeTypes[0] != "audio/mpeg" {
		t.Errorf("unknown kind entry = %+v", unknown)
	}
}

func TestGetParseFormatsReturnsAuthenticationError(t *testing.T) {
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Content-Type", "application/json")
		w.WriteHeader(http.StatusUnauthorized)
		_, _ = w.Write([]byte(`{"success":false,"error":"Unauthorized: Invalid token"}`))
	}))
	defer server.Close()

	client, err := NewClient(option.WithAPIKey("fc-bad"), option.WithAPIURL(server.URL))
	if err != nil {
		t.Fatalf("NewClient: %v", err)
	}

	formats, err := client.GetParseFormats(context.Background())
	if formats != nil {
		t.Errorf("formats = %v, want nil", formats)
	}
	var authErr *AuthenticationError
	if !errors.As(err, &authErr) {
		t.Fatalf("err = %T %v, want *AuthenticationError", err, err)
	}
	if authErr.StatusCode != http.StatusUnauthorized || authErr.Message != "Unauthorized: Invalid token" {
		t.Errorf("authErr = %+v", authErr.FirecrawlError)
	}
}

func TestGetParseFormatsReturnsServerError(t *testing.T) {
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Content-Type", "application/json")
		w.WriteHeader(http.StatusInternalServerError)
		_, _ = w.Write([]byte(`{"success":false,"error":"boom"}`))
	}))
	defer server.Close()

	client, err := NewClient(option.WithAPIKey("fc-test"), option.WithAPIURL(server.URL), option.WithMaxRetries(0))
	if err != nil {
		t.Fatalf("NewClient: %v", err)
	}

	_, err = client.GetParseFormats(context.Background())
	var fcErr *FirecrawlError
	if !errors.As(err, &fcErr) || fcErr.StatusCode != http.StatusInternalServerError {
		t.Fatalf("err = %T %v, want *FirecrawlError with status 500", err, err)
	}
}

func TestGetParseFormatsRejectsMissingFormats(t *testing.T) {
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Content-Type", "application/json")
		_, _ = w.Write([]byte(`{"success":true,"data":null}`))
	}))
	defer server.Close()

	client, err := NewClient(option.WithAPIKey("fc-test"), option.WithAPIURL(server.URL))
	if err != nil {
		t.Fatalf("NewClient: %v", err)
	}

	_, err = client.GetParseFormats(context.Background())
	var fcErr *FirecrawlError
	if !errors.As(err, &fcErr) {
		t.Fatalf("err = %T %v, want *FirecrawlError", err, err)
	}
}
