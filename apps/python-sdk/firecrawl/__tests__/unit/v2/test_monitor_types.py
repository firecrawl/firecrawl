from firecrawl.v2.types import MonitorCreateRequest, MonitorPageJudgment, MonitorTarget


def test_monitor_search_target_parses_camelcase_fields():
    target = MonitorTarget.model_validate(
        {
            "type": "search",
            "queries": ["firecrawl launch"],
            "searchWindow": "24h",
            "includeDomains": ["firecrawl.dev"],
            "excludeDomains": ["spam.com"],
            "maxResults": 20,
        }
    )

    assert target.type == "search"
    assert target.queries == ["firecrawl launch"]
    assert target.search_window == "24h"
    assert target.include_domains == ["firecrawl.dev"]
    assert target.exclude_domains == ["spam.com"]
    assert target.max_results == 20


def test_monitor_create_request_serializes_search_target_to_camelcase():
    request = MonitorCreateRequest(
        name="Search monitor",
        schedule={"text": "every 30 minutes"},
        goal="Alert when Firecrawl launches a product",
        targets=[
            MonitorTarget(
                type="search",
                queries=["firecrawl launch"],
                search_window="24h",
                max_results=15,
            )
        ],
    )

    payload = request.model_dump(exclude_none=True, by_alias=True)
    target = payload["targets"][0]
    assert target["type"] == "search"
    assert target["queries"] == ["firecrawl launch"]
    assert target["searchWindow"] == "24h"
    assert target["maxResults"] == 15
    # internal-only fields are never emitted by the SDK
    assert "depth" not in target
    assert "alertMode" not in target


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
