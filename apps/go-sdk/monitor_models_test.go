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

func TestMonitorSearchTargetRoundTrips(t *testing.T) {
	max := 25
	target := MonitorSearchTarget{
		Type:           "search",
		Queries:        []string{"firecrawl pricing", "firecrawl changelog"},
		SearchWindow:   "24h",
		IncludeDomains: []string{"firecrawl.dev"},
		ExcludeDomains: []string{"example.com"},
		MaxResults:     &max,
	}

	data, err := json.Marshal(target)
	if err != nil {
		t.Fatalf("Marshal MonitorSearchTarget: %v", err)
	}

	var decoded MonitorSearchTarget
	if err := json.Unmarshal(data, &decoded); err != nil {
		t.Fatalf("Unmarshal MonitorSearchTarget: %v", err)
	}

	if decoded.Type != "search" || len(decoded.Queries) != 2 || decoded.SearchWindow != "24h" {
		t.Fatalf("target = %+v", decoded)
	}
	if decoded.MaxResults == nil || *decoded.MaxResults != 25 {
		t.Fatalf("maxResults = %v", decoded.MaxResults)
	}
	if decoded.ID != "" {
		t.Fatalf("expected omitted id, got %q", decoded.ID)
	}
}

func TestMonitorSearchTargetResultParses(t *testing.T) {
	payload := []byte(`{
		"targetId": "tgt_1",
		"type": "search",
		"searchCompleted": true,
		"resultCount": 10,
		"matches": 3,
		"summary": "Found 3 matching results.",
		"judgeDegraded": false,
		"degradedReason": null,
		"searchCredits": 1.5,
		"judgeCredits": 0.25,
		"resultsJudged": 8
	}`)

	var result MonitorSearchTargetResult
	if err := json.Unmarshal(payload, &result); err != nil {
		t.Fatalf("Unmarshal MonitorSearchTargetResult: %v", err)
	}

	if result.TargetID != "tgt_1" || result.Type != "search" {
		t.Fatalf("result = %+v", result)
	}
	if result.SearchCompleted == nil || !*result.SearchCompleted {
		t.Fatalf("searchCompleted = %v", result.SearchCompleted)
	}
	if result.ResultCount == nil || *result.ResultCount != 10 {
		t.Fatalf("resultCount = %v", result.ResultCount)
	}
	if result.Matches == nil || *result.Matches != 3 {
		t.Fatalf("matches = %v", result.Matches)
	}
	if result.JudgeDegraded == nil || *result.JudgeDegraded {
		t.Fatalf("judgeDegraded = %v", result.JudgeDegraded)
	}
	if result.DegradedReason != nil {
		t.Fatalf("degradedReason = %v", result.DegradedReason)
	}
	if result.SearchCredits == nil || *result.SearchCredits != 1.5 {
		t.Fatalf("searchCredits = %v", result.SearchCredits)
	}
	if result.ResultsJudged == nil || *result.ResultsJudged != 8 {
		t.Fatalf("resultsJudged = %v", result.ResultsJudged)
	}
}
