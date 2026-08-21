package firecrawl

import (
	"encoding/json"
	"strings"
	"testing"
)

func TestScrapeOptionsSerializesQueryFormatMode(t *testing.T) {
	payload, err := json.Marshal(ScrapeOptions{
		FormatOptions: []interface{}{
			QueryFormat{
				Prompt: "What is Firecrawl?",
				Mode:   QueryModeDirectQuote,
			},
		},
	})
	if err != nil {
		t.Fatalf("Marshal ScrapeOptions: %v", err)
	}

	jsonBody := string(payload)
	for _, want := range []string{
		`"formats":[{"type":"query","prompt":"What is Firecrawl?","mode":"directQuote"}]`,
	} {
		if !strings.Contains(jsonBody, want) {
			t.Fatalf("serialized query format = %s, want to contain %s", jsonBody, want)
		}
	}
}

func TestScrapeOptionsSerializesQuestionAndHighlightsFormats(t *testing.T) {
	payload, err := json.Marshal(ScrapeOptions{
		FormatOptions: []interface{}{
			QuestionFormat{Question: "What is Firecrawl?"},
			HighlightsFormat{Query: "What is Firecrawl?"},
		},
	})
	if err != nil {
		t.Fatalf("Marshal ScrapeOptions: %v", err)
	}

	jsonBody := string(payload)
	for _, want := range []string{
		`{"type":"question","question":"What is Firecrawl?"}`,
		`{"type":"highlights","query":"What is Firecrawl?"}`,
	} {
		if !strings.Contains(jsonBody, want) {
			t.Fatalf("serialized formats = %s, want to contain %s", jsonBody, want)
		}
	}
}

func TestScrapeOptionsPreservesStringFormats(t *testing.T) {
	payload, err := json.Marshal(ScrapeOptions{
		Formats: []string{"markdown", "video"},
	})
	if err != nil {
		t.Fatalf("Marshal ScrapeOptions: %v", err)
	}

	if !strings.Contains(string(payload), `"formats":["markdown","video"]`) {
		t.Fatalf("serialized string formats = %s", payload)
	}
}

func TestScrapeOptionsSerializesPDFParserPagesAndBlocks(t *testing.T) {
	pages := true
	blocks := true
	pageMarkers := true
	payload, err := json.Marshal(ScrapeOptions{
		Parsers: []interface{}{
			PDFParser{Type: "pdf", Mode: "auto", Pages: &pages, Blocks: &blocks, PageMarkers: &pageMarkers},
		},
	})
	if err != nil {
		t.Fatalf("Marshal ScrapeOptions: %v", err)
	}

	want := `"parsers":[{"type":"pdf","mode":"auto","pages":true,"blocks":true,"pageMarkers":true}]`
	if !strings.Contains(string(payload), want) {
		t.Fatalf("serialized parsers = %s, want to contain %s", payload, want)
	}
}

func TestDocumentDeserializesPages(t *testing.T) {
	raw := []byte(`{
		"markdown": "# Annual Report 2025",
		"pages": [
			{"pageNumber": 1, "markdown": "# Cover"},
			{"pageNumber": 2, "markdown": "## Intro"}
		]
	}`)

	var doc Document
	if err := json.Unmarshal(raw, &doc); err != nil {
		t.Fatalf("Unmarshal Document: %v", err)
	}
	if len(doc.Pages) != 2 {
		t.Fatalf("pages len = %d, want 2", len(doc.Pages))
	}
	if doc.Pages[0].PageNumber != 1 || doc.Pages[0].Markdown != "# Cover" {
		t.Fatalf("page 0 = %+v", doc.Pages[0])
	}
	if doc.Pages[1].PageNumber != 2 || doc.Pages[1].Markdown != "## Intro" {
		t.Fatalf("page 1 = %+v", doc.Pages[1])
	}
}

func TestDocumentDeserializesBlocks(t *testing.T) {
	raw := []byte(`{
		"markdown": "# Annual Report 2025",
		"blocks": [{
			"pageNumber": 1,
			"width": 1700,
			"height": 2200,
			"status": "ok",
			"items": [{
				"id": "p1.b0",
				"type": "title",
				"label": "doc_title",
				"bbox": [0.118, 0.054, 0.882, 0.092],
				"content": "# Annual Report 2025",
				"markdownSpan": [0, 21],
				"readingOrder": 0,
				"source": "native_text",
				"confidence": {"layout": 0.97, "ocr": null}
			}]
		}]
	}`)

	var doc Document
	if err := json.Unmarshal(raw, &doc); err != nil {
		t.Fatalf("Unmarshal Document: %v", err)
	}
	if len(doc.Blocks) != 1 {
		t.Fatalf("blocks len = %d, want 1", len(doc.Blocks))
	}
	page := doc.Blocks[0]
	if page.PageNumber != 1 || page.Status != "ok" || len(page.Items) != 1 {
		t.Fatalf("page = %+v", page)
	}
	item := page.Items[0]
	if item.ID != "p1.b0" || item.Type != "title" || item.ReadingOrder != 0 {
		t.Fatalf("item = %+v", item)
	}
	if item.Confidence.Layout == nil || *item.Confidence.Layout != 0.97 {
		t.Fatalf("layout confidence = %+v", item.Confidence.Layout)
	}
}

func TestScrapeOptionsSerializesRedactPII(t *testing.T) {
	payload, err := json.Marshal(ScrapeOptions{
		RedactPII: Bool(true),
	})
	if err != nil {
		t.Fatalf("Marshal ScrapeOptions: %v", err)
	}

	if !strings.Contains(string(payload), `"redactPII":true`) {
		t.Fatalf("serialized redactPII = %s", payload)
	}
}

func TestSearchOptionsSerializesHighlights(t *testing.T) {
	payload, err := json.Marshal(SearchOptions{Highlights: Bool(false)})
	if err != nil {
		t.Fatalf("Marshal SearchOptions: %v", err)
	}

	if !strings.Contains(string(payload), `"highlights":false`) {
		t.Fatalf("serialized search options = %s", payload)
	}
}

func TestAuditMetadataSerializesAcrossRequestOptions(t *testing.T) {
	metadata := &AuditMetadata{Username: "alice@example.com"}
	for name, options := range map[string]interface{}{
		"scrape": ScrapeOptions{AuditMetadata: metadata},
		"map":    MapOptions{AuditMetadata: metadata},
		"agent":  AgentOptions{Prompt: "find pricing", AuditMetadata: metadata},
		"parse":  ParseOptions{AuditMetadata: metadata},
	} {
		t.Run(name, func(t *testing.T) {
			payload, err := json.Marshal(options)
			if err != nil {
				t.Fatalf("Marshal options: %v", err)
			}
			if !strings.Contains(string(payload), `"auditMetadata":{"username":"alice@example.com"}`) {
				t.Fatalf("serialized options = %s", payload)
			}
		})
	}
}
