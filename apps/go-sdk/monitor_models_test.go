package firecrawl

import (
	"encoding/json"
	"testing"
)

func TestMonitorPageJudgmentParsesMeaningfulChanges(t *testing.T) {
	payload := []byte(`{
		"meaningful": true,
		"confidence": "high",
		"reason": "The tracked price changed.",
		"meaningfulChanges": [
			{
				"type": "changed",
				"before": "$10",
				"after": "$12",
				"reason": "Price increased."
			}
		]
	}`)

	var judgment MonitorPageJudgment
	if err := json.Unmarshal(payload, &judgment); err != nil {
		t.Fatalf("Unmarshal MonitorPageJudgment: %v", err)
	}

	if !judgment.Meaningful || judgment.Confidence != "high" {
		t.Fatalf("judgment = %+v", judgment)
	}
	if len(judgment.MeaningfulChanges) != 1 {
		t.Fatalf("meaningfulChanges length = %d, want 1", len(judgment.MeaningfulChanges))
	}
	change := judgment.MeaningfulChanges[0]
	if change.Type != "changed" || change.Before == nil || *change.Before != "$10" || change.After == nil || *change.After != "$12" {
		t.Fatalf("meaningful change = %+v", change)
	}
}
