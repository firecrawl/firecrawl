import importlib
import warnings

import firecrawl.v2.types as types
from firecrawl.v2.types import MonitorPageJudgment, MonitorPageDiff, MonitorPageSnapshot


def test_monitor_page_types_import_without_json_shadow_warnings():
    with warnings.catch_warnings(record=True) as caught:
        warnings.simplefilter("always")
        importlib.reload(types)

    assert not [warning for warning in caught if "MonitorPageDiff" in str(warning.message)]
    assert not [warning for warning in caught if "MonitorPageSnapshot" in str(warning.message)]

    diff = MonitorPageDiff.model_validate({"text": "diff", "json": [{"type": "changed"}]})
    snapshot = MonitorPageSnapshot.model_validate({"json": {"price": "$12"}})

    assert diff.json == [{"type": "changed"}]
    assert snapshot.json == {"price": "$12"}


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
