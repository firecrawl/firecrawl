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

func TestScrapeOptionsJsonFormatWithJsonOptions(t *testing.T) {
	// When Formats contains "json" and JsonOptions is set, the serialized
	// output must embed the JSON config as a format object in the formats
	// array — matching what the v2 API expects.
	schema := map[string]interface{}{
		"type": "object",
		"properties": map[string]interface{}{
			"title": map[string]interface{}{"type": "string"},
		},
	}
	payload, err := json.Marshal(ScrapeOptions{
		Formats: []string{"markdown", "json"},
		JsonOptions: &JsonOptions{
			Prompt: "Extract the title",
			Schema: schema,
		},
	})
	if err != nil {
		t.Fatalf("Marshal ScrapeOptions: %v", err)
	}

	jsonBody := string(payload)

	// The formats array should contain "markdown" as a plain string and the
	// JSON format as an object with type, schema, and prompt fields.
	if strings.Contains(jsonBody, `"jsonOptions"`) {
		t.Fatalf("serialized body should NOT contain jsonOptions as a separate field: %s", jsonBody)
	}

	// Verify the formats array contains the JSON format object.
	var result map[string]interface{}
	if err := json.Unmarshal(payload, &result); err != nil {
		t.Fatalf("Unmarshal result: %v", err)
	}

	formats, ok := result["formats"].([]interface{})
	if !ok {
		t.Fatalf("formats is not an array: %v", result["formats"])
	}

	if len(formats) != 2 {
		t.Fatalf("expected 2 formats, got %d: %v", len(formats), formats)
	}

	// Find the JSON format object in the array.
	foundMarkdown := false
	foundJsonObj := false
	for _, f := range formats {
		switch v := f.(type) {
		case string:
			if v == "markdown" {
				foundMarkdown = true
			}
		case map[string]interface{}:
			if v["type"] == "json" {
				foundJsonObj = true
				if v["prompt"] != "Extract the title" {
					t.Errorf("json format prompt = %v, want %q", v["prompt"], "Extract the title")
				}
				if v["schema"] == nil {
					t.Errorf("json format schema is nil")
				}
			}
		}
	}

	if !foundMarkdown {
		t.Errorf("formats array missing plain string 'markdown': %s", jsonBody)
	}
	if !foundJsonObj {
		t.Errorf("formats array missing json format object with type/schema/prompt: %s", jsonBody)
	}
}

func TestScrapeOptionsJsonFormatWithoutJsonOptions(t *testing.T) {
	// When Formats contains "json" but JsonOptions is nil, the format should
	// remain a plain string.
	payload, err := json.Marshal(ScrapeOptions{
		Formats: []string{"json"},
	})
	if err != nil {
		t.Fatalf("Marshal ScrapeOptions: %v", err)
	}

	if !strings.Contains(string(payload), `"formats":["json"]`) {
		t.Fatalf("serialized string formats = %s, want plain string 'json'", payload)
	}
}

func TestScrapeOptionsJsonFormatViaFormatOptions(t *testing.T) {
	// Users can also use FormatOptions with the JsonFormat type directly.
	payload, err := json.Marshal(ScrapeOptions{
		FormatOptions: []interface{}{
			"markdown",
			JsonFormat{
				Prompt: "Extract data",
				Schema: map[string]interface{}{"type": "object"},
			},
		},
	})
	if err != nil {
		t.Fatalf("Marshal ScrapeOptions: %v", err)
	}

	jsonBody := string(payload)
	if !strings.Contains(jsonBody, `"type":"json"`) {
		t.Fatalf("serialized formats missing json type: %s", jsonBody)
	}
	if !strings.Contains(jsonBody, `"prompt":"Extract data"`) {
		t.Fatalf("serialized formats missing prompt: %s", jsonBody)
	}
}

func TestParseOptionsJsonFormatWithJsonOptions(t *testing.T) {
	// ParseOptions should also embed JsonOptions into the formats array.
	schema := map[string]interface{}{"type": "object"}
	payload, err := json.Marshal(ParseOptions{
		Formats: []string{"json"},
		JsonOptions: &JsonOptions{
			Prompt: "Extract data",
			Schema: schema,
		},
	})
	if err != nil {
		t.Fatalf("Marshal ParseOptions: %v", err)
	}

	jsonBody := string(payload)

	if strings.Contains(jsonBody, `"jsonOptions"`) {
		t.Fatalf("serialized body should NOT contain jsonOptions as a separate field: %s", jsonBody)
	}

	var result map[string]interface{}
	if err := json.Unmarshal(payload, &result); err != nil {
		t.Fatalf("Unmarshal result: %v", err)
	}

	formats, ok := result["formats"].([]interface{})
	if !ok {
		t.Fatalf("formats is not an array: %v", result["formats"])
	}

	found := false
	for _, f := range formats {
		if obj, ok := f.(map[string]interface{}); ok && obj["type"] == "json" {
			found = true
			if obj["prompt"] != "Extract data" {
				t.Errorf("json format prompt = %v", obj["prompt"])
			}
		}
	}
	if !found {
		t.Errorf("formats array missing json format object: %s", jsonBody)
	}
}
