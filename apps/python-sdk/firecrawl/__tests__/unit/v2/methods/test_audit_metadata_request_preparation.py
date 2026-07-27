import json

from firecrawl.v1.client import V1MapParams, V1ScrapeOptions
from firecrawl.v2.methods.agent import _prepare_agent_request
from firecrawl.v2.methods.aio.batch import _prepare as prepare_async_batch_request
from firecrawl.v2.methods.batch import prepare_batch_scrape_request
from firecrawl.v2.methods.map import _prepare_map_request
from firecrawl.v2.methods.parse import _prepare_parse_request
from firecrawl.v2.types import MapOptions, ParseOptions, ScrapeOptions
from firecrawl.v2.utils.validation import prepare_scrape_options


AUDIT_METADATA = {"requestId": "req-123", "actor": "sdk-test"}


def test_scrape_and_batch_audit_metadata_request_preparation():
    options = ScrapeOptions(audit_metadata=AUDIT_METADATA)

    assert prepare_scrape_options(options)["auditMetadata"] == AUDIT_METADATA
    assert (
        prepare_batch_scrape_request(
            ["https://example.com"],
            options=options,
        )["auditMetadata"]
        == AUDIT_METADATA
    )
    assert (
        prepare_async_batch_request(
            ["https://example.com"],
            audit_metadata=AUDIT_METADATA,
        )["auditMetadata"]
        == AUDIT_METADATA
    )


def test_map_and_agent_audit_metadata_request_preparation():
    assert (
        _prepare_map_request(
            "https://example.com",
            MapOptions(audit_metadata=AUDIT_METADATA),
        )["auditMetadata"]
        == AUDIT_METADATA
    )
    assert (
        _prepare_agent_request(
            None,
            prompt="Extract the page",
            audit_metadata=AUDIT_METADATA,
        )["auditMetadata"]
        == AUDIT_METADATA
    )


def test_parse_audit_metadata_request_preparation():
    fields, _ = _prepare_parse_request(
        b"<html></html>",
        ParseOptions(audit_metadata=AUDIT_METADATA),
        filename="upload.html",
        content_type="text/html",
    )

    assert json.loads(fields["options"])["auditMetadata"] == AUDIT_METADATA


def test_v1_models_serialize_audit_metadata():
    assert (
        V1ScrapeOptions(auditMetadata=AUDIT_METADATA)
        .model_dump(exclude_none=True)["auditMetadata"]
        == AUDIT_METADATA
    )
    assert (
        V1MapParams(auditMetadata=AUDIT_METADATA)
        .model_dump(exclude_none=True)["auditMetadata"]
        == AUDIT_METADATA
    )
