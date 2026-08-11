from firecrawl.v2.types import Document


def test_document_hydrates_pdf_pages() -> None:
    document = Document.model_validate(
        {
            "markdown": "one\ntwo",
            "pages": [
                {"pageNumber": 1, "markdown": "one"},
                {"pageNumber": 2, "markdown": "two"},
            ],
        }
    )

    assert document.pages is not None
    assert [page.page_number for page in document.pages] == [1, 2]
    assert [page.markdown for page in document.pages] == ["one", "two"]
