from firecrawl.types import VideoItem
from firecrawl.v2.types import Document
from firecrawl.v2.utils.normalize import normalize_document_input


def test_document_hydrates_video_items():
    raw = {
        "markdown": "# Video",
        "video": "https://storage.googleapis.com/firecrawl/video.mp4",
        "videos": [
            {
                "url": "https://cdn.example.com/product.mp4",
                "sourceURL": "https://example.com/product",
                "source": "script",
                "kind": "file",
                "provider": "cdn.example.com",
                "title": "Product video",
                "thumbnail": "https://cdn.example.com/poster.jpg",
                "description": "Product overview",
                "duration": "PT45S",
                "mimeType": "video/mp4",
                "width": 1920,
                "height": 1080,
                "metadata": {"resourceType": "Media"},
            }
        ],
    }

    doc = Document(**normalize_document_input(raw))

    assert doc.video == "https://storage.googleapis.com/firecrawl/video.mp4"
    assert doc.videos is not None
    assert isinstance(doc.videos[0], VideoItem)
    assert doc.videos[0].source_url == "https://example.com/product"
    assert doc.videos[0].mime_type == "video/mp4"
    assert doc.videos[0].thumbnail == "https://cdn.example.com/poster.jpg"
