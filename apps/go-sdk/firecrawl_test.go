package firecrawl

import (
	"encoding/json"
	"testing"
)

func TestRestructureJSONFormats(t *testing.T) {
	tests := []struct {
		name  string
		input map[string]interface{}
		want  map[string]interface{}
	}{
		{
			name: "restructures json format with schema and prompt",
			input: map[string]interface{}{
				"url":     "https://example.com",
				"formats": []interface{}{"markdown", "json"},
				"jsonOptions": map[string]interface{}{
					"prompt": "extract data",
					"schema": map[string]interface{}{"type": "object"},
				},
			},
			want: map[string]interface{}{
				"url": "https://example.com",
				"formats": []interface{}{
					"markdown",
					map[string]interface{}{
						"type":   "json",
						"prompt": "extract data",
						"schema": map[string]interface{}{"type": "object"},
					},
				},
			},
		},
		{
			name: "no jsonOptions leaves body unchanged",
			input: map[string]interface{}{
				"url":     "https://example.com",
				"formats": []interface{}{"markdown", "html"},
			},
			want: map[string]interface{}{
				"url":     "https://example.com",
				"formats": []interface{}{"markdown", "html"},
			},
		},
		{
			name: "no formats key leaves body unchanged",
			input: map[string]interface{}{
				"url": "https://example.com",
			},
			want: map[string]interface{}{
				"url": "https://example.com",
			},
		},
	}

	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			restructureJSONFormats(tt.input)
			gotJSON, _ := json.Marshal(tt.input)
			wantJSON, _ := json.Marshal(tt.want)
			if string(gotJSON) != string(wantJSON) {
				t.Errorf("restructureJSONFormats()\ngot:  %s\nwant: %s", gotJSON, wantJSON)
			}
		})
	}
}

func TestMergeOptionsAndRestructure(t *testing.T) {
	opts := &ScrapeOptions{
		Formats: []string{"markdown", "json"},
		JsonOptions: &JsonOptions{
			Prompt: "extract the title",
			Schema: map[string]interface{}{"type": "object"},
		},
	}

	body := map[string]interface{}{"url": "https://example.com"}
	mergeOptions(body, opts)
	restructureJSONFormats(body)

	if _, exists := body["jsonOptions"]; exists {
		t.Error("jsonOptions key should be removed from body")
	}

	formats, ok := body["formats"].([]interface{})
	if !ok {
		t.Fatal("formats should be a slice")
	}
	if len(formats) != 2 {
		t.Fatalf("expected 2 format entries, got %d", len(formats))
	}
	if formats[0].(string) != "markdown" {
		t.Errorf("first format should be 'markdown', got %v", formats[0])
	}

	jsonFmt, ok := formats[1].(map[string]interface{})
	if !ok {
		t.Fatal("second format should be a map")
	}
	if jsonFmt["type"] != "json" {
		t.Errorf("expected type 'json', got %v", jsonFmt["type"])
	}
	if jsonFmt["prompt"] != "extract the title" {
		t.Errorf("expected prompt 'extract the title', got %v", jsonFmt["prompt"])
	}
}
