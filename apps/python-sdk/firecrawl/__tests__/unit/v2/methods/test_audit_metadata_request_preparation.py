import json

import pytest
from pydantic import ValidationError

from firecrawl.v2.methods.agent import _prepare_agent_request
from firecrawl.v2.methods.aio.batch import _prepare as prepare_async_batch_request
from firecrawl.v2.methods.batch import prepare_batch_scrape_request
from firecrawl.v2.methods.map import _prepare_map_request
from firecrawl.v2.methods.parse import _prepare_parse_request
from firecrawl.v2.types import AuditMetadata, MapOptions, ParseOptions, ScrapeOptions
from firecrawl.v2.utils.validation import prepare_scrape_options


AUDIT_METADATA = AuditMetadata(username="alice@example.com")
SERIALIZED_AUDIT_METADATA = {"username": "alice@example.com"}


def test_scrape_and_batch_audit_metadata_request_preparation():
    options = ScrapeOptions(audit_metadata=AUDIT_METADATA)

    assert prepare_scrape_options(options)["auditMetadata"] == SERIALIZED_AUDIT_METADATA
    assert (
        prepare_batch_scrape_request(
            ["https://example.com"],
            audit_metadata=AUDIT_METADATA,
        )["auditMetadata"]
        == SERIALIZED_AUDIT_METADATA
    )
    assert (
        prepare_async_batch_request(
            ["https://example.com"],
            audit_metadata=AUDIT_METADATA,
        )["auditMetadata"]
        == SERIALIZED_AUDIT_METADATA
    )


def test_map_and_agent_audit_metadata_request_preparation():
    assert (
        _prepare_map_request(
            "https://example.com",
            MapOptions(audit_metadata=AUDIT_METADATA),
        )["auditMetadata"]
        == SERIALIZED_AUDIT_METADATA
    )
    assert (
        _prepare_agent_request(
            None,
            prompt="Extract the page",
            audit_metadata=AUDIT_METADATA,
        )["auditMetadata"]
        == SERIALIZED_AUDIT_METADATA
    )


def test_parse_audit_metadata_request_preparation():
    fields, _ = _prepare_parse_request(
        b"<html></html>",
        ParseOptions(audit_metadata=AUDIT_METADATA),
        filename="upload.html",
        content_type="text/html",
    )

    assert json.loads(fields["options"])["auditMetadata"] == SERIALIZED_AUDIT_METADATA


def test_audit_metadata_rejects_unsupported_fields():
    with pytest.raises(ValidationError):
        AuditMetadata(username="alice@example.com", session="session-123")
