"""Async Alexandria feedback functionality for Firecrawl v2."""

from typing import Any, Dict, Union

from ...types import AlexandriaFeedbackRequest, AlexandriaFeedbackResponse
from ...utils.error_handler import handle_response_error
from ...utils.http_client_async import AsyncHttpClient
from ..feedback import ENDPOINT, prepare_alexandria_feedback_request


async def alexandria_feedback(
    client: AsyncHttpClient,
    request: Union[AlexandriaFeedbackRequest, Dict[str, Any]],
) -> AlexandriaFeedbackResponse:
    """Submit feedback for Alexandria calls asynchronously."""
    payload = prepare_alexandria_feedback_request(request)
    response = await client.post(ENDPOINT, payload)
    if response.status_code != 200:
        handle_response_error(response, "submit alexandria feedback")
    body = response.json()
    if not body.get("success"):
        handle_response_error(response, "submit alexandria feedback")
    return AlexandriaFeedbackResponse.model_validate(body)
