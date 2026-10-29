from urllib.parse import urlparse, urlunparse


def pin_to_api_origin(api_url: str, url: str) -> str:
    """Rewrite an absolute or protocol-relative URL onto api_url's scheme and host so credentials never leave it.

    Relative URLs are returned unchanged. Raises ValueError if api_url is not an absolute URL.
    """
    parsed = urlparse(url)
    if not parsed.netloc:
        return url
    base = urlparse(api_url)
    if not base.scheme or not base.netloc:
        raise ValueError(f"api_url must be an absolute URL, got {api_url!r}")
    return urlunparse((base.scheme, base.netloc, parsed.path or "/", parsed.params, parsed.query, ""))
