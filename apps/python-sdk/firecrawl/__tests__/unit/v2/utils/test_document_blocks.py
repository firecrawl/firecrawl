from firecrawl.v2.types import Document, PdfPage, PdfPageBlocks
from firecrawl.v2.utils.normalize import normalize_document_input


class TestDocumentBlocks:
    def test_blocks_hydrate_from_api_camel_case(self):
        raw = {
            "markdown": "# Annual Report 2025",
            "blocks": [
                {
                    "pageNumber": 1,
                    "width": 1700,
                    "height": 2200,
                    "status": "ok",
                    "items": [
                        {
                            "id": "p1.b0",
                            "type": "title",
                            "label": "doc_title",
                            "bbox": [0.118, 0.054, 0.882, 0.092],
                            "content": "# Annual Report 2025",
                            "markdownSpan": [0, 21],
                            "readingOrder": 0,
                            "source": "native_text",
                            "confidence": {"layout": 0.97, "ocr": None},
                        }
                    ],
                }
            ],
        }

        doc = Document(**normalize_document_input(raw))
        assert doc.blocks is not None
        assert len(doc.blocks) == 1
        page = doc.blocks[0]
        assert isinstance(page, PdfPageBlocks)
        assert page.page_number == 1
        assert page.width == 1700
        assert page.status == "ok"
        item = page.items[0]
        assert item.id == "p1.b0"
        assert item.type == "title"
        assert item.markdown_span == [0, 21]
        assert item.reading_order == 0
        assert item.confidence.layout == 0.97
        assert item.confidence.ocr is None

    def test_blocks_absent_when_not_requested(self):
        doc = Document(**normalize_document_input({"markdown": "# Hello"}))
        assert doc.blocks is None
        assert doc.pages is None


class TestDocumentPages:
    def test_pages_hydrate_from_api_camel_case(self):
        raw = {
            "markdown": "# Annual Report 2025",
            "pages": [
                {"pageNumber": 1, "markdown": "# Cover"},
                {"pageNumber": 2, "markdown": "## Intro"},
            ],
        }

        doc = Document(**normalize_document_input(raw))
        assert doc.pages is not None
        assert len(doc.pages) == 2
        assert isinstance(doc.pages[0], PdfPage)
        assert doc.pages[0].page_number == 1
        assert doc.pages[0].markdown == "# Cover"
        assert doc.pages[1].page_number == 2
        assert doc.pages[1].markdown == "## Intro"
