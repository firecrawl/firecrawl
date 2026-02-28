use serde::{Deserialize, Serialize};
use serde_json::Value;

// Handles metadata fields that the API may return as either a string or an array of strings.
// Arrays are joined with ", ".
fn deserialize_string_or_array<'de, D>(deserializer: D) -> Result<Option<String>, D::Error>
where
    D: serde::Deserializer<'de>,
{
    match Option::<Value>::deserialize(deserializer)? {
        None | Some(Value::Null) => Ok(None),
        Some(Value::String(s)) => Ok(Some(s)),
        Some(Value::Array(arr)) => {
            let strings: Vec<String> = arr
                .into_iter()
                .map(|v| match v {
                    Value::String(s) => s,
                    other => other.to_string(),
                })
                .collect();
            if strings.is_empty() {
                Ok(None)
            } else {
                Ok(Some(strings.join(", ")))
            }
        }
        Some(other) => Ok(Some(other.to_string())),
    }
}

#[serde_with::skip_serializing_none]
#[derive(Deserialize, Serialize, Debug, Default, Clone)]
#[serde(rename_all = "camelCase")]
pub struct DocumentMetadata {
    // firecrawl specific
    #[serde(rename = "sourceURL")]
    pub source_url: String,
    pub status_code: u16,
    pub error: Option<String>,

    // basic meta tags
    #[serde(default, deserialize_with = "deserialize_string_or_array")]
    pub title: Option<String>,
    #[serde(default, deserialize_with = "deserialize_string_or_array")]
    pub description: Option<String>,
    #[serde(default, deserialize_with = "deserialize_string_or_array")]
    pub language: Option<String>,
    #[serde(default, deserialize_with = "deserialize_string_or_array")]
    pub keywords: Option<String>,
    #[serde(default, deserialize_with = "deserialize_string_or_array")]
    pub robots: Option<String>,

    // og: namespace
    #[serde(default, deserialize_with = "deserialize_string_or_array")]
    pub og_title: Option<String>,
    #[serde(default, deserialize_with = "deserialize_string_or_array")]
    pub og_description: Option<String>,
    #[serde(default, deserialize_with = "deserialize_string_or_array")]
    pub og_url: Option<String>,
    #[serde(default, deserialize_with = "deserialize_string_or_array")]
    pub og_image: Option<String>,
    #[serde(default, deserialize_with = "deserialize_string_or_array")]
    pub og_audio: Option<String>,
    #[serde(default, deserialize_with = "deserialize_string_or_array")]
    pub og_determiner: Option<String>,
    #[serde(default, deserialize_with = "deserialize_string_or_array")]
    pub og_locale: Option<String>,
    pub og_locale_alternate: Option<Vec<String>>,
    #[serde(default, deserialize_with = "deserialize_string_or_array")]
    pub og_site_name: Option<String>,
    #[serde(default, deserialize_with = "deserialize_string_or_array")]
    pub og_video: Option<String>,

    // article: namespace
    #[serde(default, deserialize_with = "deserialize_string_or_array")]
    pub article_section: Option<String>,
    #[serde(default, deserialize_with = "deserialize_string_or_array")]
    pub article_tag: Option<String>,
    #[serde(default, deserialize_with = "deserialize_string_or_array")]
    pub published_time: Option<String>,
    #[serde(default, deserialize_with = "deserialize_string_or_array")]
    pub modified_time: Option<String>,

    // dc./dcterms. namespace
    #[serde(default, deserialize_with = "deserialize_string_or_array")]
    pub dcterms_keywords: Option<String>,
    #[serde(default, deserialize_with = "deserialize_string_or_array")]
    pub dc_description: Option<String>,
    #[serde(default, deserialize_with = "deserialize_string_or_array")]
    pub dc_subject: Option<String>,
    #[serde(default, deserialize_with = "deserialize_string_or_array")]
    pub dcterms_subject: Option<String>,
    #[serde(default, deserialize_with = "deserialize_string_or_array")]
    pub dcterms_audience: Option<String>,
    #[serde(default, deserialize_with = "deserialize_string_or_array")]
    pub dc_type: Option<String>,
    #[serde(default, deserialize_with = "deserialize_string_or_array")]
    pub dcterms_type: Option<String>,
    #[serde(default, deserialize_with = "deserialize_string_or_array")]
    pub dc_date: Option<String>,
    #[serde(default, deserialize_with = "deserialize_string_or_array")]
    pub dc_date_created: Option<String>,
    #[serde(default, deserialize_with = "deserialize_string_or_array")]
    pub dcterms_created: Option<String>,
}

#[serde_with::skip_serializing_none]
#[derive(Deserialize, Serialize, Debug, Default, Clone)]
#[serde(rename_all = "camelCase")]
pub struct Document {
    /// A list of the links on the page, present if `ScrapeFormats::Markdown` is present in `ScrapeOptions.formats`. (default)
    pub markdown: Option<String>,

    /// The HTML of the page, present if `ScrapeFormats::HTML` is present in `ScrapeOptions.formats`.
    ///
    /// This contains HTML that has non-content tags removed. If you need the original HTML, use `ScrapeFormats::RawHTML`.
    pub html: Option<String>,

    /// The raw HTML of the page, present if `ScrapeFormats::RawHTML` is present in `ScrapeOptions.formats`.
    ///
    /// This contains the original, untouched HTML on the page. If you only need human-readable content, use `ScrapeFormats::HTML`.
    pub raw_html: Option<String>,

    /// The URL to the screenshot of the page, present if `ScrapeFormats::Screenshot` or `ScrapeFormats::ScreenshotFullPage` is present in `ScrapeOptions.formats`.
    pub screenshot: Option<String>,

    /// A list of the links on the page, present if `ScrapeFormats::Links` is present in `ScrapeOptions.formats`.
    pub links: Option<Vec<String>>,

    /// The extracted data from the page, present if `ScrapeFormats::Extract` is present in `ScrapeOptions.formats`.
    /// If `ScrapeOptions.extract.schema` is `Some`, this `Value` is guaranteed to match the provided schema.
    pub extract: Option<Value>,

    /// The metadata from the page.
    pub metadata: DocumentMetadata,

    /// Can be present if `ScrapeFormats::Extract` is present in `ScrapeOptions.formats`.
    /// The warning message will contain any errors encountered during the extraction.
    pub warning: Option<String>,
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn test_metadata_string_values() {
        let json = json!({
            "sourceURL": "https://example.com",
            "statusCode": 200,
            "robots": "index, follow",
            "title": "Example"
        });
        let meta: DocumentMetadata = serde_json::from_value(json).unwrap();
        assert_eq!(meta.robots, Some("index, follow".to_string()));
        assert_eq!(meta.title, Some("Example".to_string()));
    }

    #[test]
    fn test_metadata_array_values() {
        let json = json!({
            "sourceURL": "https://example.com",
            "statusCode": 200,
            "robots": ["index", "follow"],
            "ogImage": ["https://img1.jpg", "https://img2.jpg"]
        });
        let meta: DocumentMetadata = serde_json::from_value(json).unwrap();
        assert_eq!(meta.robots, Some("index, follow".to_string()));
        assert_eq!(
            meta.og_image,
            Some("https://img1.jpg, https://img2.jpg".to_string())
        );
    }

    #[test]
    fn test_metadata_null_values() {
        let json = json!({
            "sourceURL": "https://example.com",
            "statusCode": 200,
            "ogImage": null,
            "robots": null
        });
        let meta: DocumentMetadata = serde_json::from_value(json).unwrap();
        assert_eq!(meta.og_image, None);
        assert_eq!(meta.robots, None);
    }

    #[test]
    fn test_metadata_missing_fields() {
        let json = json!({
            "sourceURL": "https://example.com",
            "statusCode": 200
        });
        let meta: DocumentMetadata = serde_json::from_value(json).unwrap();
        assert_eq!(meta.title, None);
        assert_eq!(meta.robots, None);
        assert_eq!(meta.og_image, None);
    }

    #[test]
    fn test_metadata_empty_array() {
        let json = json!({
            "sourceURL": "https://example.com",
            "statusCode": 200,
            "robots": []
        });
        let meta: DocumentMetadata = serde_json::from_value(json).unwrap();
        assert_eq!(meta.robots, None);
    }

    #[test]
    fn test_metadata_single_element_array() {
        let json = json!({
            "sourceURL": "https://example.com",
            "statusCode": 200,
            "robots": ["noindex"]
        });
        let meta: DocumentMetadata = serde_json::from_value(json).unwrap();
        assert_eq!(meta.robots, Some("noindex".to_string()));
    }

    #[test]
    fn test_metadata_serialization_roundtrip() {
        let json = json!({
            "sourceURL": "https://example.com",
            "statusCode": 200,
            "robots": "index, follow",
            "title": "Test"
        });
        let meta: DocumentMetadata = serde_json::from_value(json).unwrap();
        let serialized = serde_json::to_value(&meta).unwrap();
        assert_eq!(serialized["robots"], "index, follow");
        assert_eq!(serialized["title"], "Test");
    }

    #[test]
    fn test_full_document_with_array_metadata() {
        let json = json!({
            "markdown": "# Hello",
            "metadata": {
                "sourceURL": "https://example.com",
                "statusCode": 200,
                "title": "Example Page",
                "description": ["A great page", "with multiple descriptions"],
                "robots": ["index", "follow"],
                "ogImage": ["https://img.jpg"],
                "language": "en",
                "keywords": ["rust", "sdk", "firecrawl"]
            }
        });
        let doc: Document = serde_json::from_value(json).unwrap();
        assert_eq!(doc.markdown, Some("# Hello".to_string()));
        let meta = doc.metadata;
        assert_eq!(meta.title, Some("Example Page".to_string()));
        assert_eq!(
            meta.description,
            Some("A great page, with multiple descriptions".to_string())
        );
        assert_eq!(meta.robots, Some("index, follow".to_string()));
        assert_eq!(meta.og_image, Some("https://img.jpg".to_string()));
        assert_eq!(meta.language, Some("en".to_string()));
        assert_eq!(meta.keywords, Some("rust, sdk, firecrawl".to_string()));
    }
}
