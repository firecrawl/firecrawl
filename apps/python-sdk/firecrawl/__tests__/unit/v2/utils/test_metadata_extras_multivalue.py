import pytest

from firecrawl.v2.types import Document
from firecrawl.v2.utils.normalize import normalize_document_input


class TestMetadataMultiValue:
    def test_article_tag_list_coerced_to_string(self):
        raw = {
            "markdown": "# Body",
            "metadata": {
                "title": "Page",
                "articleTag": ["one", "two"],
            },
        }
        doc = Document(**normalize_document_input(raw))
        # typed access works and is joined as string
        assert doc.metadata is not None
        assert doc.metadata.article_tag == "one, two"
        # dict view shows string
        md = doc.metadata_dict
        assert md["article_tag"] == "one, two"
