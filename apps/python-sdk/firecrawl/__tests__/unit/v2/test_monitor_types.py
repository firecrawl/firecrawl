from firecrawl.v2.types import MonitorPageJudgment


def test_monitor_page_judgment_parses_meaningful_changes():
    judgment = MonitorPageJudgment.model_validate(
        {
            "meaningful": True,
            "confidence": "high",
            "reason": "The tracked price changed.",
            "meaningfulChanges": [
                {
                    "type": "changed",
                    "before": "$10",
                    "after": "$12",
                    "reason": "Price increased.",
                }
            ],
        }
    )

    assert judgment.meaningful is True
    assert judgment.meaningful_changes[0].type == "changed"
