package firecrawl

import (
	"encoding/json"
	"testing"
)

func TestDocumentParsesVideoItems(t *testing.T) {
	payload := []byte(`{
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
				"metadata": {"resourceType": "Media"}
			}
		]
	}`)

	var doc Document
	if err := json.Unmarshal(payload, &doc); err != nil {
		t.Fatalf("Unmarshal Document: %v", err)
	}

	if doc.Video != "https://storage.googleapis.com/firecrawl/video.mp4" {
		t.Fatalf("Video = %q", doc.Video)
	}
	if len(doc.Videos) != 1 {
		t.Fatalf("Videos length = %d, want 1", len(doc.Videos))
	}

	video := doc.Videos[0]
	if video.SourceURL != "https://example.com/product" || video.MimeType != "video/mp4" {
		t.Fatalf("Video item = %+v", video)
	}
	if video.Thumbnail != "https://cdn.example.com/poster.jpg" {
		t.Fatalf("Thumbnail = %q", video.Thumbnail)
	}
}
