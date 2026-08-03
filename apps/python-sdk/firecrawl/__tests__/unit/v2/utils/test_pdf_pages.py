from firecrawl.v2.types import Document
from firecrawl.v2.utils.normalize import normalize_document_input


def test_document_parses_physical_pdf_pages_from_api_shape():
    document = Document.model_validate(
        normalize_document_input(
            {
                "markdown": "whole document",
                "pages": [
                    {"pageNumber": 1, "markdown": "one"},
                    {"pageNumber": 2, "markdown": "two"},
                ],
                "metadata": {"numPages": 2},
            }
        )
    )

    assert document.pages is not None
    assert [page.page_number for page in document.pages] == [1, 2]
    assert document.pages[0].markdown == "one"
