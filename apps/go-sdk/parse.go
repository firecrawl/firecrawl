package firecrawl

import (
	"context"
	"encoding/json"
	"fmt"
	"mime"
	"os"
	"path/filepath"
	"strings"
)

// ParseFile is a binary upload payload for the `/v2/parse` endpoint.
//
// Supported file extensions: .html, .htm, .pdf, .docx, .doc, .odt, .rtf, .xlsx, .xls
type ParseFile struct {
	// Filename for the upload (e.g., "document.pdf"). Required.
	Filename string
	// Raw file bytes. Required (non-empty).
	Content []byte
	// Optional MIME type hint (e.g., "application/pdf").
	ContentType string
}

// NewParseFileFromPath reads a file from disk and returns a ParseFile ready for upload.
func NewParseFileFromPath(path string) (*ParseFile, error) {
	if path == "" {
		return nil, &FirecrawlError{Message: "file path is required"}
	}

	content, err := os.ReadFile(path)
	if err != nil {
		return nil, &FirecrawlError{Message: fmt.Sprintf("failed to read parse file %q: %v", path, err)}
	}

	filename := filepath.Base(path)
	contentType := mime.TypeByExtension(filepath.Ext(path))

	return &ParseFile{
		Filename:    filename,
		Content:     content,
		ContentType: contentType,
	}, nil
}

// NewParseFileFromBytes builds a ParseFile from in-memory bytes.
func NewParseFileFromBytes(filename string, content []byte) *ParseFile {
	return &ParseFile{
		Filename: filename,
		Content:  content,
	}
}

// ParseOptions configures a parse request.
//
// Parse does not support browser-rendering features (actions, waitFor, location,
// mobile) nor the screenshot, branding, product, menu, or changeTracking formats. The proxy
// field only accepts "auto" or "basic".
type ParseOptions struct {
	Formats             []string          `json:"-"`
	FormatOptions       []interface{}     `json:"-"`
	Headers             map[string]string `json:"headers,omitempty"`
	IncludeTags         []string          `json:"includeTags,omitempty"`
	ExcludeTags         []string          `json:"excludeTags,omitempty"`
	OnlyMainContent     *bool             `json:"onlyMainContent,omitempty"`
	Timeout             *int              `json:"timeout,omitempty"`
	Parsers             []interface{}     `json:"parsers,omitempty"`
	SkipTLSVerification *bool             `json:"skipTlsVerification,omitempty"`
	RemoveBase64Images  *bool             `json:"removeBase64Images,omitempty"`
	BlockAds            *bool             `json:"blockAds,omitempty"`
	Proxy               *string           `json:"proxy,omitempty"`
	Integration         *string           `json:"integration,omitempty"`
	RedactPII           *bool             `json:"redactPII,omitempty"`
	JsonOptions         *JsonOptions      `json:"jsonOptions,omitempty"`
}

// MarshalJSON preserves string formats while allowing object formats such as QuestionFormat.
func (o ParseOptions) MarshalJSON() ([]byte, error) {
	type parseOptions ParseOptions
	payload := struct {
		parseOptions
		Formats interface{} `json:"formats,omitempty"`
	}{
		parseOptions: parseOptions(o),
	}

	if len(o.FormatOptions) > 0 {
		payload.Formats = o.FormatOptions
	} else if len(o.Formats) > 0 {
		payload.Formats = o.Formats
	}

	return json.Marshal(payload)
}

// Parse uploads a file to the `/v2/parse` endpoint and returns the extracted document.
func (c *Client) Parse(ctx context.Context, file *ParseFile, opts *ParseOptions) (*Document, error) {
	if file == nil {
		return nil, &FirecrawlError{Message: "parse file is required"}
	}
	filename := strings.TrimSpace(file.Filename)
	if filename == "" {
		return nil, &FirecrawlError{Message: "filename cannot be empty"}
	}
	if len(file.Content) == 0 {
		return nil, &FirecrawlError{Message: "file content cannot be empty"}
	}

	optionsMap := map[string]interface{}{}
	mergeOptions(optionsMap, opts)

	optionsJSON, err := json.Marshal(optionsMap)
	if err != nil {
		return nil, &FirecrawlError{Message: fmt.Sprintf("failed to serialize parse options: %v", err)}
	}

	fields := map[string]string{"options": string(optionsJSON)}
	raw, err := c.http.postMultipart(ctx, "/v2/parse", fields, "file", filename, file.ContentType, file.Content)
	if err != nil {
		return nil, err
	}

	doc, err := extractDataAs[Document](raw)
	if err != nil {
		return nil, err
	}
	return doc, nil
}
