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

func TestScrapeOptionsEmbedsJsonOptionsInFormats(t *testing.T) {
	payload, err := json.Marshal(ScrapeOptions{
		Formats: []string{"markdown", "json"},
		JsonOptions: &JsonOptions{
			Prompt: "Extract greeting",
			Schema: map[string]interface{}{
				"type": "object",
				"properties": map[string]interface{}{
					"hello": map[string]interface{}{"type": "string"},
				},
			},
		},
	})
	if err != nil {
		t.Fatalf("Marshal ScrapeOptions: %v", err)
	}

	var body map[string]interface{}
	if err := json.Unmarshal(payload, &body); err != nil {
		t.Fatalf("Unmarshal payload: %v", err)
	}
	if _, ok := body["jsonOptions"]; ok {
		t.Fatalf("payload contains top-level jsonOptions: %s", payload)
	}

	formats, ok := body["formats"].([]interface{})
	if !ok || len(formats) != 2 {
		t.Fatalf("formats = %#v, want markdown plus json object", body["formats"])
	}
	if formats[0] != "markdown" {
		t.Fatalf("formats[0] = %#v, want markdown", formats[0])
	}
	jsonFormat, ok := formats[1].(map[string]interface{})
	if !ok {
		t.Fatalf("formats[1] = %#v, want json object", formats[1])
	}
	if jsonFormat["type"] != "json" || jsonFormat["prompt"] != "Extract greeting" {
		t.Fatalf("json format = %#v", jsonFormat)
	}
	if _, ok := jsonFormat["schema"].(map[string]interface{}); !ok {
		t.Fatalf("json format missing schema: %#v", jsonFormat)
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
