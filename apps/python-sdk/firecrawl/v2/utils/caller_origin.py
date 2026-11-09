import functools
import os
import re
import sys
from typing import Optional

_SDK_ROOT = os.path.dirname(os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
_INSTALL_DIRS = ("site-packages", "dist-packages")


@functools.lru_cache(maxsize=None)
def _distributions() -> dict:
    from importlib import metadata

    if hasattr(metadata, "packages_distributions"):
        return dict(metadata.packages_distributions())
    mapping: dict = {}
    for dist in metadata.distributions():
        names = (dist.read_text("top_level.txt") or "").split()
        if not names:
            first = {f.parts[0] for f in dist.files or [] if f.parts}
            names = [
                part.split(".")[0]
                for part in first
                if part not in ("..", "__pycache__") and not part.endswith((".dist-info", ".egg-info"))
            ]
        for name in names:
            mapping.setdefault(name, []).append(dist.metadata["Name"])
    return mapping


def _is_sdk_file(filename: str) -> bool:
    if filename.startswith("<"):
        return False
    path = os.path.abspath(filename)
    return path.startswith(_SDK_ROOT + os.sep) and f"{os.sep}__tests__{os.sep}" not in path


def _caller_distribution() -> Optional[str]:
    frame = sys._getframe()
    while frame is not None and _is_sdk_file(frame.f_code.co_filename):
        frame = frame.f_back
    if frame is None:
        return None
    parts = os.path.abspath(frame.f_code.co_filename).split(os.sep)
    for index in range(len(parts) - 2, -1, -1):
        if parts[index] in _INSTALL_DIRS:
            top_level = parts[index + 1].split(".")[0]
            names = _distributions().get(top_level)
            return names[0] if names else None
    return None


def default_origin(version: str) -> str:
    """Return ``python-sdk@<version>``, or ``python-sdk.<package>@<version>`` when an installed package creates the client."""
    plain = f"python-sdk@{version}"
    try:
        if os.environ.get("FIRECRAWL_DISABLE_CALLER_ORIGIN") == "1":
            return plain
        name = _caller_distribution()
        slug = re.sub(r"[^a-z0-9]+", "-", name.lower()).strip("-")[:48].strip("-") if name else ""
        if not slug or "playground" in slug:
            return plain
        return f"python-sdk.{slug}@{version}"
    except Exception:
        return plain
