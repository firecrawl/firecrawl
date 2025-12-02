import pytest

from firecrawl.v2.types import Document, DocumentMetadata
from firecrawl.v2.utils.normalize import normalize_document_input


class TestDocumentMetadataExtras:
    def test_metadata_extras_preserved_in_metadata_dict(self):
        raw = {
            "markdown": "# Hello",
            "metadata": {
                "title": "Example",
                # Known camelCase -> snake_case mapping
                "statusCode": "200",
                # Unknown keys that should be preserved as-is
                "twitter:card": "summary",
                "twitterCard": "summary_large_image",
                "theme-color": "#fff",
            },
        }

        doc = Document(**normalize_document_input(raw))
        md_dict = doc.metadata_dict
        # Known key mapped and coerced
        assert md_dict["status_code"] == 200
        assert md_dict["title"] == "Example"
        # Extras are preserved verbatim
        assert md_dict["twitter:card"] == "summary"
        assert md_dict["twitterCard"] == "summary_large_image"
        assert md_dict["theme-color"] == "#fff"

    def test_metadata_typed_from_plain_dict_preserves_extras(self):
        # Construct Document with raw dict metadata without normalization step
        doc = Document(
            markdown="# Hi",
            metadata={
                "ogTitle": "Hello",  # will be treated as extra without normalization
                "x-custom": "ok",
            },
        )

        md = doc.metadata_typed
        assert isinstance(md, DocumentMetadata)
        # Known fields aren't populated without normalization
        assert md.og_title is None
        # Extras are available on the underlying pydantic storage and in metadata_dict
        extras = getattr(md, "__pydantic_extra__", {}) or {}
        assert extras == {"ogTitle": "Hello", "x-custom": "ok"}
        assert doc.metadata_dict["ogTitle"] == "Hello"
        assert doc.metadata_dict["x-custom"] == "ok"

    def test_document_model_dump_includes_metadata_extras(self):
        raw = {
            "markdown": "# Body",
            "metadata": {
                "title": "Page",
                "twitter:site": "@site",
            },
        }
        doc = Document(**normalize_document_input(raw))
        dumped = doc.model_dump(exclude_none=True)
        assert "metadata" in dumped
        assert dumped["metadata"]["title"] == "Page"
        assert dumped["metadata"]["twitter:site"] == "@site"

    def test_unknown_list_metadata_preserved(self):
        raw = {
            "markdown": "# Body",
            "metadata": {
                "title": "Page",
                "x-list": [1, "a", 3],
            },
        }
        doc = Document(**normalize_document_input(raw))
        md = doc.metadata_dict
        assert md["x-list"] == [1, "a", 3]

    def test_metadata_typed_extras_property(self):
        md = DocumentMetadata(title="T", **{"x-foo": "bar"})
        # extras accessor should expose unknown keys
        assert md.extras == {"x-foo": "bar"}
