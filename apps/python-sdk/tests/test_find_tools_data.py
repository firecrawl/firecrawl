import pytest
from firecrawl.v2.types import FindToolsData


@pytest.mark.parametrize("level", ["categories", "providers", "groups", "tools"])
def test_accepts_every_disclosure_level(level):
    data = FindToolsData(level=level, items=[{"id": "news"}], total=1)
    assert data.level == level
    assert data.items[0]["id"] == "news"


def test_unfiltered_browse_returns_categories():
    data = FindToolsData(
        level="categories",
        items=[
            {
                "id": "news",
                "description": "Reported news",
                "next": {
                    "provider": "firecrawl",
                    "capability": "find-tools",
                    "options": {"categories": ["news"], "level": "providers"},
                },
            }
        ],
        total=30,
        next={"provider": "firecrawl", "capability": "find-tools", "options": {"offset": 1}},
    )
    assert data.total == 30
    assert data.items[0]["next"]["options"]["level"] == "providers"
