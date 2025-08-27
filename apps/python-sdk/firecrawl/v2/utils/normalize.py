"""
Normalization helpers for v2 API payloads to avoid relying on Pydantic aliases.
"""

from typing import Any, Dict, List
from ..types import DocumentMetadata


def _map_metadata_keys(md: Dict[str, Any]) -> Dict[str, Any]:
    """
    Convert API v2 camelCase metadata keys to snake_case expected by DocumentMetadata.
    Leaves unknown keys as-is.
    """
    mapping = {
        # OpenGraph
        "ogTitle": "og_title",
        "ogDescription": "og_description",
        "ogUrl": "og_url",
        "ogImage": "og_image",
        "ogAudio": "og_audio",
        "ogDeterminer": "og_determiner",
        "ogLocale": "og_locale",
        "ogLocaleAlternate": "og_locale_alternate",
        "ogSiteName": "og_site_name",
        "ogVideo": "og_video",
        # Dublin Core and misc
        "dcTermsCreated": "dc_terms_created",
        "dcDateCreated": "dc_date_created",
        "dcDate": "dc_date",
        "dcTermsType": "dc_terms_type",
        "dcType": "dc_type",
        "dcTermsAudience": "dc_terms_audience",
        "dcTermsSubject": "dc_terms_subject",
        "dcSubject": "dc_subject",
        "dcDescription": "dc_description",
        "dcTermsKeywords": "dc_terms_keywords",
        "modifiedTime": "modified_time",
        "publishedTime": "published_time",
        "articleTag": "article_tag",
        "articleSection": "article_section",
        # Response-level
        "sourceURL": "source_url",
        "statusCode": "status_code",
        "scrapeId": "scrape_id",
        "numPages": "num_pages",
        "contentType": "content_type",
        "proxyUsed": "proxy_used",
        "cacheState": "cache_state",
        "cachedAt": "cached_at",
        "creditsUsed": "credits_used",
    }

    out: Dict[str, Any] = {}
    for k, v in md.items():
        snake = mapping.get(k, k)
        out[snake] = v

    # Light coercions where server may send strings/lists
    if isinstance(out.get("status_code"), str):
        try:
            out["status_code"] = int(out["status_code"])  # type: ignore
        except ValueError:
            pass

    # Generic rule: if a value is a list, join with ", " for string-like fields,
    # except for explicit fields we preserve as lists.
    preserve_list_fields: List[str] = [
        "og_locale_alternate",
    ]
    for f, val in list(out.items()):
        if isinstance(val, list) and f not in preserve_list_fields:
            try:
                out[f] = ", ".join(str(x) for x in val)
            except Exception:
                # Fallback: keep original list if join fails
                pass

    return out


def normalize_document_input(doc: Dict[str, Any]) -> Dict[str, Any]:
    """
    Normalize a raw Document dict from the API into the Python SDK's expected shape:
    - Convert top-level keys rawHtml->raw_html, changeTracking->change_tracking
    - Convert metadata keys from camelCase to snake_case
    """
    normalized = dict(doc)

    if "rawHtml" in normalized and "raw_html" not in normalized:
        normalized["raw_html"] = normalized.pop("rawHtml")

    if "changeTracking" in normalized and "change_tracking" not in normalized:
        normalized["change_tracking"] = normalized.pop("changeTracking")

    md = normalized.get("metadata")
    if isinstance(md, dict):
        mapped = _map_metadata_keys(md)
        # Construct a concrete DocumentMetadata so downstream has a typed object
        try:
            normalized["metadata"] = DocumentMetadata(**mapped)
        except Exception:
            # Fallback to mapped dict if model construction fails for any reason
            normalized["metadata"] = mapped

    return normalized


