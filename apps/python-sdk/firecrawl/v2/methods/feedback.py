"""Alexandria feedback functionality for Firecrawl v2."""

from typing import Any, Dict, Iterable, List, Optional, Union

from ..types import AlexandriaFeedbackRequest, AlexandriaFeedbackResponse
from ..utils import HttpClient, handle_response_error


ENDPOINT = "/v2/feedback"
MAX_FEEDBACK_TOKENS = 20


def collect_feedback_tokens(results: Iterable[Any]) -> List[str]:
    """Collect feedback tokens from Alexandria call results for a session rating.

    Skips results without a token, dedupes, and keeps the newest 20 (newest last).
    """
    tokens: List[str] = []
    for result in results:
        if isinstance(result, dict):
            token = result.get("feedbackToken") or result.get("feedback_token")
        else:
            token = getattr(result, "feedback_token", None)
        if not token:
            continue
        if token in tokens:
            tokens.remove(token)
        tokens.append(token)
    return tokens[-MAX_FEEDBACK_TOKENS:]


def prepare_alexandria_feedback_request(
    request: Union[AlexandriaFeedbackRequest, Dict[str, Any]],
) -> Dict[str, Any]:
    validated = AlexandriaFeedbackRequest.model_validate(request)
    payload = validated.model_dump(exclude_none=True, by_alias=True)
    payload["endpoint"] = "alexandria"
    return payload


def alexandria_feedback(
    client: HttpClient,
    request: Union[AlexandriaFeedbackRequest, Dict[str, Any]],
) -> AlexandriaFeedbackResponse:
    """Submit feedback for Alexandria calls."""
    payload = prepare_alexandria_feedback_request(request)
    response = client.post(ENDPOINT, payload)
    if response.status_code != 200:
        handle_response_error(response, "submit alexandria feedback")
    body = response.json()
    if not body.get("success"):
        handle_response_error(response, "submit alexandria feedback")
    return AlexandriaFeedbackResponse.model_validate(body)
