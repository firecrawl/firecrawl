"""Maps v1-style SDK calls (v1 method names, ``params`` dicts, camelCase options) onto the v2 client."""

import re
import warnings
from functools import lru_cache
from typing import Any, Callable, Dict, Optional

from pydantic import BaseModel, computed_field, model_validator

from .. import types as v2_types
from ..types import ScrapeOptions as V2ScrapeOptions

_RENAMED_OPTIONS = {
    "max_depth": "max_discovery_depth",
    "allow_backward_links": "crawl_entire_domain",
}

_warned = False


def warn_v1_usage() -> None:
    """Emit the v1-style call deprecation warning, once per process."""
    global _warned
    if _warned:
        return
    _warned = True
    warnings.warn(
        "firecrawl: v1-style calls (scrape_url, crawl_url, batch_scrape_urls, params=..., "
        "camelCase options) are deprecated and mapped to the v2 API. Use scrape(), crawl(), "
        "batch_scrape() and the other v2 methods with keyword arguments instead.",
        DeprecationWarning,
        stacklevel=4,
    )


def _snake_case(key: str) -> str:
    return re.sub(r"(?<=[a-z0-9])([A-Z])", r"_\1", key).lower()


class ScrapeOptions(V2ScrapeOptions):
    """v2 ScrapeOptions that also accepts the camelCase field names firecrawl-py 2.x used."""

    @model_validator(mode="before")
    @classmethod
    def _accept_camel_case(cls, data: Any) -> Any:
        if not isinstance(data, dict):
            return data
        known = set(cls.model_fields) | {f.alias for f in cls.model_fields.values() if f.alias}
        legacy = [key for key in data if key not in known and _snake_case(key) in cls.model_fields]
        if not legacy:
            return data
        warn_v1_usage()
        return {(_snake_case(key) if key in legacy else key): value for key, value in data.items()}


ScrapeOptions.model_rebuild(_types_namespace=vars(v2_types))


def to_v2_kwargs(params: Optional[Dict[str, Any]], kwargs: Dict[str, Any]) -> Dict[str, Any]:
    """Merge a v1 ``params`` dict into keyword arguments and rename v1 keys to their v2 names."""
    converted: Dict[str, Any] = {}
    for key, value in {**(params or {}), **kwargs}.items():
        name = _snake_case(key)
        name = _RENAMED_OPTIONS.get(name, name)
        if name == "ignore_sitemap":
            name, value = "sitemap", "skip" if value else "include"
        if name == "sitemap_only":
            if not value:
                continue
            name, value = "sitemap", "only"
        if name == "scrape_options" and isinstance(value, dict):
            value = ScrapeOptions(**value)
        converted[name] = value
    return converted


def _success(self: Any) -> bool:
    return True


class _V1Result:
    """Dict-style reads and a ``success`` field, as v1 results had."""

    def __getitem__(self, key: str) -> Any:
        name = _snake_case(key)
        cls = type(self)
        if name not in cls.model_fields and name not in cls.model_computed_fields and name not in (self.model_extra or {}):
            raise KeyError(key)
        return as_v1_result(getattr(self, name))

    def get(self, key: str, default: Any = None) -> Any:
        try:
            return self[key]
        except KeyError:
            return default


@lru_cache(maxsize=None)
def _v1_result_class(cls: type) -> type:
    namespace: Dict[str, Any] = {"__module__": cls.__module__, "__qualname__": cls.__qualname__}
    if "success" not in cls.model_fields:
        namespace["success"] = computed_field(property(_success))
    return type(cls.__name__, (_V1Result, cls), namespace)


def as_v1_result(value: Any) -> Any:
    """Return a v2 result that also reads like a v1 result; other values pass through."""
    if isinstance(value, list):
        return [as_v1_result(item) for item in value]
    if not isinstance(value, BaseModel) or isinstance(value, _V1Result):
        return value
    return _v1_result_class(type(value)).model_construct(_fields_set=value.model_fields_set, **dict(value))


def call_v1(method: Callable[..., Any], *args: Any, params: Optional[Dict[str, Any]] = None, **kwargs: Any) -> Any:
    """Run a v2 method for a v1-style call."""
    warn_v1_usage()
    return as_v1_result(method(*args, **to_v2_kwargs(params, kwargs)))


async def acall_v1(method: Callable[..., Any], *args: Any, params: Optional[Dict[str, Any]] = None, **kwargs: Any) -> Any:
    """Await a v2 async method for a v1-style call."""
    warn_v1_usage()
    return as_v1_result(await method(*args, **to_v2_kwargs(params, kwargs)))
