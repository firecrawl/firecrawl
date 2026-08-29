from firecrawl.v2.types import ExtractRequest
from firecrawl.v2.types import ThreatProtectionOptions


def test_extract_request_serializes_threat_protection():
    req = ExtractRequest(
        urls=["https://example.com"],
        prompt="extract",
        threat_protection=ThreatProtectionOptions(mode="normal"),
    )
    data = req.model_dump(by_alias=True, exclude_none=True)
    assert "threatProtection" in data
    assert data["threatProtection"]["mode"] == "normal"


def test_extract_request_without_threat_protection_excludes():
    req = ExtractRequest(urls=["https://example.com"], prompt="extract")
    data = req.model_dump(by_alias=True, exclude_none=True)
    assert "threatProtection" not in data
