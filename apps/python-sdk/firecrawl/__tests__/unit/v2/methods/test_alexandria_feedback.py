from unittest.mock import Mock

import httpx
import pytest

from firecrawl import AsyncFirecrawl, Firecrawl, collect_feedback_tokens
from firecrawl.v2.types import AlexandriaScrapeResult

REQUEST = {
    "rating": "good",
    "requested_website": {"url": "https://example.com", "requested_functionality": "Find episodes"},
    "rationale": "Returned what was needed",
}
FEEDBACK_RESPONSE = {"success": True, "feedbackId": "feedback-1", "creditsRefunded": 0}
SCRAPE_DATA = {
    "alexandria": [
        {"provider": "particle", "capability": "a/b", "creditsCost": 15, "feedbackToken": "token-ok", "data": {}},
        {
            "provider": "x",
            "capability": "b",
            "feedbackToken": "token-error",
            "error": {"code": "unavailable", "message": "Unavailable"},
        },
        {"provider": "y", "capability": "c", "creditsCost": 1, "data": {}},
    ],
    "creditsCost": 15,
}
FIND_TOOLS_DATA = {
    "alexandria": [
        {
            "provider": "firecrawl",
            "capability": "find-tools",
            "creditsCost": 0,
            "feedbackToken": "meta-token",
            "data": {"level": "providers", "items": [], "total": 0, "next": None},
        }
    ],
    "creditsCost": 0,
}


def response(status, data):
    result = Mock(status_code=status)
    result.json.return_value = data
    return result


def test_scrape_result_keeps_feedback_token():
    result = AlexandriaScrapeResult(**SCRAPE_DATA["alexandria"][0])
    assert result.feedback_token == "token-ok"
    assert AlexandriaScrapeResult(**SCRAPE_DATA["alexandria"][2]).feedback_token is None


@pytest.mark.parametrize("async_client", [False, True])
@pytest.mark.asyncio
async def test_scrape_and_find_tools_surface_tokens(async_client, monkeypatch):
    def payload(body):
        provider = body["alexandria"][0]["provider"]
        data = FIND_TOOLS_DATA if provider == "firecrawl" else SCRAPE_DATA
        return {"success": True, "scrape_id": "scrape-1", "data": data}

    calls = [{"provider": "particle", "capability": "a/b"}]
    if async_client:
        client = AsyncFirecrawl(api_key="fc-test")
        try:
            async def post(url, **kwargs):
                return httpx.Response(200, json=payload(kwargs["json"]))

            monkeypatch.setattr(client._v2_client.async_http_client._client, "post", post)
            scraped = await client.scrape(alexandria=calls)
            found = await client.find_tools()
        finally:
            await client._v2_client.async_http_client.close()
    else:
        monkeypatch.setattr("requests.post", lambda url, **kwargs: response(200, payload(kwargs["json"])))
        client = Firecrawl(api_key="fc-test")
        scraped = client.scrape(alexandria=calls)
        found = client.find_tools()
    assert [item.feedback_token for item in scraped.alexandria] == ["token-ok", "token-error", None]
    assert found.feedback_token == "meta-token"


def test_collect_feedback_tokens_dedupes_and_keeps_newest_twenty():
    results = [AlexandriaScrapeResult(feedbackToken="dup"), AlexandriaScrapeResult()]
    results += [AlexandriaScrapeResult(feedbackToken=f"t{i}") for i in range(25)]
    results.append(AlexandriaScrapeResult(feedbackToken="dup"))
    collected = collect_feedback_tokens(results)
    assert len(collected) == 20
    assert collected[0] == "t6"
    assert collected[-2:] == ["t24", "dup"]
    assert collect_feedback_tokens([AlexandriaScrapeResult()]) == []


def test_collect_feedback_tokens_accepts_plain_dicts():
    results = [{"feedbackToken": "a"}, {"feedback_token": "b"}, {}, {"feedbackToken": "a"}]
    assert collect_feedback_tokens(results) == ["b", "a"]


def test_alexandria_feedback_accepts_token_of_exactly_1024_chars(monkeypatch):
    sent = []
    monkeypatch.setattr(
        "requests.post", lambda url, **kwargs: sent.append(kwargs["json"]) or response(200, FEEDBACK_RESPONSE)
    )
    Firecrawl(api_key="fc-test").alexandria_feedback({**REQUEST, "tokens": ["x" * 1024]})
    assert len(sent[0]["tokens"][0]) == 1024


def test_alexandria_feedback_requires_functionality_for_new_capability_request(monkeypatch):
    post = Mock(return_value=response(200, FEEDBACK_RESPONSE))
    monkeypatch.setattr("requests.post", post)
    entry = {"name": "episodes", "provider": "particle", "issue": "new_capability_request", "why": "Needed"}
    client = Firecrawl(api_key="fc-test")
    with pytest.raises(ValueError, match="requested_functionality is required"):
        client.alexandria_feedback({**REQUEST, "capability_feedback": [entry]})
    post.assert_not_called()
    client.alexandria_feedback(
        {**REQUEST, "capability_feedback": [{**entry, "requested_functionality": "Dates"}]}
    )
    assert post.call_args.kwargs["json"]["capabilityFeedback"][0]["requestedFunctionality"] == "Dates"


def test_alexandria_feedback_trims_text_and_rejects_blank(monkeypatch):
    post = Mock(return_value=response(200, FEEDBACK_RESPONSE))
    monkeypatch.setattr("requests.post", post)
    client = Firecrawl(api_key="fc-test")
    with pytest.raises(ValueError):
        client.alexandria_feedback({**REQUEST, "rationale": "   "})
    post.assert_not_called()
    client.alexandria_feedback({**REQUEST, "rationale": "  ok  "})
    assert post.call_args.kwargs["json"]["rationale"] == "ok"


@pytest.mark.parametrize("async_client", [False, True])
@pytest.mark.asyncio
async def test_alexandria_feedback_posts_tokens_and_call_ratings(async_client, monkeypatch):
    sent = []
    body = {**FEEDBACK_RESPONSE, "rejectedTokens": 1}
    request = {
        **REQUEST,
        "objective": "Find episodes",
        "tokens": ["a", "b"],
        "call_ratings": [{"token": "c", "rating": "bad"}],
        "provider_feedback": [{"name": "particle", "issue": "insufficient_coverage", "why": "Gaps"}],
    }
    if async_client:
        client = AsyncFirecrawl(api_key="fc-test")
        try:
            async def post(url, **kwargs):
                sent.append((url, kwargs["json"]))
                return httpx.Response(200, json=body)

            monkeypatch.setattr(client._v2_client.async_http_client._client, "post", post)
            result = await client.alexandria_feedback(request)
        finally:
            await client._v2_client.async_http_client.close()
    else:
        def post(url, **kwargs):
            sent.append((url, kwargs["json"]))
            return response(200, body)

        monkeypatch.setattr("requests.post", post)
        result = Firecrawl(api_key="fc-test").alexandria_feedback(request)
    url, payload = sent[0]
    assert url.endswith("/v2/feedback")
    assert payload["endpoint"] == "alexandria"
    assert payload["rating"] == "good"
    assert payload["requestedWebsite"] == {"url": "https://example.com", "requestedFunctionality": "Find episodes"}
    assert payload["rationale"] == "Returned what was needed"
    assert payload["objective"] == "Find episodes"
    assert payload["tokens"] == ["a", "b"]
    assert payload["callRatings"] == [{"token": "c", "rating": "bad"}]
    assert payload["providerFeedback"] == [{"name": "particle", "issue": "insufficient_coverage", "why": "Gaps"}]
    assert isinstance(payload["origin"], str) and payload["origin"]
    assert result.rejected_tokens == 1
    assert result.feedback_id == "feedback-1"


def test_alexandria_feedback_without_tokens_omits_them(monkeypatch):
    sent = []
    monkeypatch.setattr(
        "requests.post", lambda url, **kwargs: sent.append(kwargs["json"]) or response(200, FEEDBACK_RESPONSE)
    )
    result = Firecrawl(api_key="fc-test").alexandria_feedback(REQUEST)
    assert "tokens" not in sent[0]
    assert "callRatings" not in sent[0]
    assert result.rejected_tokens is None


def test_alexandria_feedback_accepts_camel_case_and_exactly_twenty(monkeypatch):
    sent = []
    monkeypatch.setattr(
        "requests.post", lambda url, **kwargs: sent.append(kwargs["json"]) or response(200, FEEDBACK_RESPONSE)
    )
    Firecrawl(api_key="fc-test").alexandria_feedback(
        {
            "rating": "partial",
            "requestedWebsite": {"url": "https://example.com", "requestedFunctionality": "x"},
            "rationale": "y",
            "tokens": [f"t{i}" for i in range(20)],
            "callRatings": [{"token": f"c{i}", "rating": "good"} for i in range(20)],
        }
    )
    assert len(sent[0]["tokens"]) == 20
    assert len(sent[0]["callRatings"]) == 20


@pytest.mark.parametrize(
    "override",
    [
        {"tokens": [f"t{i}" for i in range(21)]},
        {"call_ratings": [{"token": f"c{i}", "rating": "good"} for i in range(21)]},
        {"tokens": [""]},
        {"tokens": ["x" * 1025]},
        {"call_ratings": [{"token": "a", "rating": "great"}]},
        {"rating": "great"},
    ],
)
def test_alexandria_feedback_validates_before_dispatch(override, monkeypatch):
    post = Mock()
    monkeypatch.setattr("requests.post", post)
    with pytest.raises(ValueError):
        Firecrawl(api_key="fc-test").alexandria_feedback({**REQUEST, **override})
    post.assert_not_called()


def test_alexandria_feedback_raises_on_api_error(monkeypatch):
    monkeypatch.setattr(
        "requests.post", lambda url, **kwargs: response(400, {"success": False, "error": "Invalid request"})
    )
    with pytest.raises(Exception) as caught:
        Firecrawl(api_key="fc-test").alexandria_feedback(REQUEST)
    assert caught.value.status_code == 400
