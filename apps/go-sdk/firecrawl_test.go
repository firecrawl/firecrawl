package firecrawl

import (
	"testing"
)

func TestRestructureJSONFormats(t *testing.T) {
	tests := []struct {
		name  string
		input map[string]interface{}
		want  map[string]interface{}
	}{
		{
			name: "embeds jsonOptions with schema and prompt into formats array",
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
			name: "embeds jsonOptions with schema only",
			input: map[string]interface{}{
				"formats": []interface{}{"json"},
				"jsonOptions": map[string]interface{}{
					"schema": map[string]interface{}{"type": "object"},
				},
			},
			want: map[string]interface{}{
				"formats": []interface{}{
					map[string]interface{}{
						"type":   "json",
						"schema": map[string]interface{}{"type": "object"},
					},
				},
			},
		},
		{
			name: "no-op when jsonOptions is absent",
			input: map[string]interface{}{
				"url":     "https://example.com",
				"formats": []interface{}{"markdown"},
			},
			want: map[string]interface{}{
				"url":     "https://example.com",
				"formats": []interface{}{"markdown"},
			},
		},
		{
			name: "removes jsonOptions when formats has no json entry",
			input: map[string]interface{}{
				"formats":     []interface{}{"markdown"},
				"jsonOptions": map[string]interface{}{"prompt": "test"},
			},
			want: map[string]interface{}{
				"formats": []interface{}{"markdown"},
			},
		},
		{
			name: "no-op when jsonOptions is absent, formats is empty",
			input: map[string]interface{}{
				"formats": []interface{}{},
			},
			want: map[string]interface{}{
				"formats": []interface{}{},
			},
		},
	}

	for _, tc := range tests {
		t.Run(tc.name, func(t *testing.T) {
			restructureJSONFormats(tc.input)

			// Check that jsonOptions is always removed
			if _, exists := tc.input["jsonOptions"]; exists {
				t.Errorf("jsonOptions should have been removed from body")
			}

			// Check formats match expected
			gotFormats, _ := tc.input["formats"].([]interface{})
			wantFormats, _ := tc.want["formats"].([]interface{})

			if len(gotFormats) != len(wantFormats) {
				t.Errorf("formats length mismatch: got %d, want %d", len(gotFormats), len(wantFormats))
				return
			}

			for i, gotEntry := range gotFormats {
				wantEntry := wantFormats[i]
				switch wantVal := wantEntry.(type) {
				case string:
					if gotVal, ok := gotEntry.(string); !ok || gotVal != wantVal {
						t.Errorf("formats[%d]: got %v, want %q", i, gotEntry, wantVal)
					}
				case map[string]interface{}:
					gotMap, ok := gotEntry.(map[string]interface{})
					if !ok {
						t.Errorf("formats[%d]: expected map, got %T", i, gotEntry)
						continue
					}
					for k, wantV := range wantVal {
						gotV, exists := gotMap[k]
						if !exists {
							t.Errorf("formats[%d][%q] missing", i, k)
							continue
						}
						if wantS, ok := wantV.(string); ok {
							if gotS, ok := gotV.(string); !ok || gotS != wantS {
								t.Errorf("formats[%d][%q]: got %v, want %q", i, k, gotV, wantS)
							}
						}
					}
				}
			}
		})
	}
}
