from urllib.parse import urlparse, urlunparse


def pin_to_api_origin(
    api_url: str, url: str, *, preserve_api_path: bool = False
) -> str:
    """Keep absolute or protocol-relative URLs on the configured API origin.

    Clients that use the base path for relative requests may also preserve it
    for absolute API cursors. Relative URLs are returned unchanged.
    """
    parsed = urlparse(url)
    if not parsed.netloc:
        return url
    base = urlparse(api_url)
    if not base.scheme or not base.netloc:
        raise ValueError(f"api_url must be an absolute URL, got {api_url!r}")

    path = parsed.path or "/"
    prefix = base.path.rstrip("/") if preserve_api_path else ""
    api_paths = ("/v1/", "/v2/")
    # Server-generated cursors start at the API route. A proxy may also mount
    # at /v2, so the prefix alone does not identify an already-prefixed cursor.
    if (
        prefix
        and path.startswith(api_paths)
        and not path.startswith(tuple(prefix + api_path for api_path in api_paths))
    ):
        path = prefix + path

    return urlunparse((base.scheme, base.netloc, path, parsed.params, parsed.query, ""))
