"""
Shared validation functions for Firecrawl v2 API.
"""

from typing import Optional, Dict, Any, List
from ..types import ScrapeOptions, ScrapeFormats


def _convert_format_string(format_str: str) -> str:
    """
    Convert format string from snake_case to camelCase.
    
    Args:
        format_str: Format string in snake_case
        
    Returns:
        Format string in camelCase
    """
    format_mapping = {
        "raw_html": "rawHtml",
        "change_tracking": "changeTracking",
        "screenshot_full_page": "screenshot@fullPage"
    }
    return format_mapping.get(format_str, format_str)


def _normalize_schema(schema: Any) -> Optional[Dict[str, Any]]:
    """
    Normalize a schema object which may be a dict, Pydantic BaseModel subclass,
    or a Pydantic model instance into a plain dict.
    """
    try:
        # Pydantic v2 BaseModel subclass: has "model_json_schema"
        if hasattr(schema, "model_json_schema") and callable(schema.model_json_schema):
            return schema.model_json_schema()
        # Pydantic v2 BaseModel instance: has "model_dump" or "model_json_schema"
        if hasattr(schema, "model_dump") and callable(schema.model_dump):
            # Try to get JSON schema if available on the class
            mjs = getattr(schema.__class__, "model_json_schema", None)
            if callable(mjs):
                return schema.__class__.model_json_schema()
            # Fallback to data shape (not ideal, but better than dropping)
            return schema.model_dump()
        # Pydantic v1 BaseModel subclass: has "schema"
        if hasattr(schema, "schema") and callable(schema.schema):
            return schema.schema()
        # Pydantic v1 BaseModel instance
        if hasattr(schema, "dict") and callable(schema.dict):
            # Prefer class-level schema if present
            sch = getattr(schema.__class__, "schema", None)
            if callable(sch):
                return schema.__class__.schema()
            return schema.dict()
    except Exception:
        pass
    # Already a dict or unsupported type
    return schema if isinstance(schema, dict) else None


def _validate_json_format(format_obj: Any) -> Dict[str, Any]:
    """
    Validate and prepare json format object.
    
    Args:
        format_obj: Format object that should be json type
        
    Returns:
        Validated json format dict
        
    Raises:
        ValueError: If json format is missing required fields
    """
    if not isinstance(format_obj, dict):
        raise ValueError("json format must be an object with 'type', 'prompt', and 'schema' fields")
    
    if format_obj.get('type') != 'json':
        raise ValueError("json format must have type='json'")
    
    # prompt is optional in v2; only normalize when present
    # schema is recommended; if provided, normalize Pydantic forms
    schema = format_obj.get('schema')
    normalized = dict(format_obj)
    if schema is not None:
        normalized_schema = _normalize_schema(schema)
        if normalized_schema is not None:
            normalized['schema'] = normalized_schema
    return normalized


def validate_scrape_options(options: Optional[ScrapeOptions]) -> Optional[ScrapeOptions]:
    """
    Validate and normalize scrape options.
    
    Args:
        options: Scraping options to validate
        
    Returns:
        Validated options or None
        
    Raises:
        ValueError: If options are invalid
    """
    if options is None:
        return None
    
    # Validate timeout
    if options.timeout is not None and options.timeout <= 0:
        raise ValueError("Timeout must be positive")
    
    # Validate wait_for
    if options.wait_for is not None and options.wait_for < 0:
        raise ValueError("wait_for must be non-negative")
    
    return options


def prepare_scrape_options(options: Optional[ScrapeOptions]) -> Optional[Dict[str, Any]]:
    """
    Prepare ScrapeOptions for API submission with manual snake_case to camelCase conversion.
    
    Args:
        options: ScrapeOptions to prepare
        
    Returns:
        Dictionary ready for API submission or None if options is None
    """
    if options is None:
        return None
    
    # Validate options first
    validated_options = validate_scrape_options(options)
    if validated_options is None:
        return None
    
    # Apply default values for None fields
    default_values = {
        "only_main_content": True,
        "mobile": False,
        "skip_tls_verification": True,
        "remove_base64_images": True,
        "fast_mode": False,
        "block_ads": True,
        "max_age": 14400000,
        "store_in_cache": True
    }
    
    # Convert to dict and handle manual snake_case to camelCase conversion
    options_data = validated_options.model_dump(exclude_none=True)
    
    # Apply defaults for None fields
    for field, default_value in default_values.items():
        if field not in options_data:
            options_data[field] = default_value
    
    scrape_data = {}
    
    # Manual field mapping for snake_case to camelCase conversion
    field_mappings = {
        "include_tags": "includeTags",
        "exclude_tags": "excludeTags",
        "only_main_content": "onlyMainContent",
        "wait_for": "waitFor",
        "skip_tls_verification": "skipTlsVerification",
        "remove_base64_images": "removeBase64Images",
        "fast_mode": "fastMode",
        "use_mock": "useMock",
        "block_ads": "blockAds",
        "store_in_cache": "storeInCache",
        "max_age": "maxAge"
    }
    
    # Apply field mappings
    for snake_case, camel_case in field_mappings.items():
        if snake_case in options_data:
            scrape_data[camel_case] = options_data.pop(snake_case)
    
    # Handle special cases
    for key, value in options_data.items():
        if value is not None:
            if key == "formats":
                # Handle formats conversion
                converted_formats: List[Any] = []

                # Prefer using original object to detect ScrapeFormats vs list
                original_formats = getattr(options, 'formats', None)

                if isinstance(original_formats, ScrapeFormats):
                    # Include explicit list first
                    if original_formats.formats:
                        for fmt in original_formats.formats:
                            if isinstance(fmt, str):
                                if fmt == "json":
                                    raise ValueError("json format must be an object with 'type', 'prompt', and 'schema' fields")
                                converted_formats.append(_convert_format_string(fmt))
                            elif isinstance(fmt, dict):
                                fmt_type = _convert_format_string(fmt.get('type')) if fmt.get('type') else None
                                if fmt_type == 'json':
                                    validated_json = _validate_json_format({**fmt, 'type': 'json'})
                                    converted_formats.append(validated_json)
                                elif fmt_type == 'screenshot':
                                    # Normalize screenshot options
                                    normalized = {**fmt, 'type': 'screenshot'}
                                    if 'full_page' in normalized:
                                        normalized['fullPage'] = normalized.pop('full_page')
                                    # Normalize viewport if it's a model instance
                                    vp = normalized.get('viewport')
                                    if hasattr(vp, 'model_dump'):
                                        normalized['viewport'] = vp.model_dump(exclude_none=True)
                                    converted_formats.append(normalized)
                                else:
                                    if 'type' in fmt:
                                        fmt['type'] = fmt_type or fmt['type']
                                    converted_formats.append(fmt)
                            elif hasattr(fmt, 'type'):
                                if fmt.type == 'json':
                                    converted_formats.append(_validate_json_format(fmt.model_dump()))
                                else:
                                    converted_formats.append(_convert_format_string(fmt.type))
                            else:
                                converted_formats.append(fmt)

                    # Add booleans from ScrapeFormats
                    if original_formats.markdown:
                        converted_formats.append("markdown")
                    if original_formats.html:
                        converted_formats.append("html")
                    if original_formats.raw_html:
                        converted_formats.append("rawHtml")
                    if original_formats.summary:
                        converted_formats.append("summary")
                    if original_formats.links:
                        converted_formats.append("links")
                    if original_formats.screenshot:
                        converted_formats.append("screenshot")
                    if original_formats.change_tracking:
                        converted_formats.append("changeTracking")
                    # Note: We intentionally do not auto-include 'json' when boolean is set,
                    # because JSON requires an object with schema/prompt. The caller must
                    # supply the full json format object explicitly.
                elif isinstance(original_formats, list):
                    for fmt in original_formats:
                        if isinstance(fmt, str):
                            if fmt == "json":
                                raise ValueError("json format must be an object with 'type', 'prompt', and 'schema' fields")
                            converted_formats.append(_convert_format_string(fmt))
                        elif isinstance(fmt, dict):
                            fmt_type = _convert_format_string(fmt.get('type')) if fmt.get('type') else None
                            if fmt_type == 'json':
                                validated_json = _validate_json_format({**fmt, 'type': 'json'})
                                converted_formats.append(validated_json)
                            elif fmt_type == 'screenshot':
                                normalized = {**fmt, 'type': 'screenshot'}
                                if 'full_page' in normalized:
                                    normalized['fullPage'] = normalized.pop('full_page')
                                vp = normalized.get('viewport')
                                if hasattr(vp, 'model_dump'):
                                    normalized['viewport'] = vp.model_dump(exclude_none=True)
                                converted_formats.append(normalized)
                            else:
                                if 'type' in fmt:
                                    fmt['type'] = fmt_type or fmt['type']
                                converted_formats.append(fmt)
                        elif hasattr(fmt, 'type'):
                            if fmt.type == 'json':
                                converted_formats.append(_validate_json_format(fmt.model_dump()))
                            elif fmt.type == 'screenshot':
                                normalized = {'type': 'screenshot'}
                                if getattr(fmt, 'full_page', None) is not None:
                                    normalized['fullPage'] = fmt.full_page
                                if getattr(fmt, 'quality', None) is not None:
                                    normalized['quality'] = fmt.quality
                                vp = getattr(fmt, 'viewport', None)
                                if vp is not None:
                                    normalized['viewport'] = vp.model_dump(exclude_none=True) if hasattr(vp, 'model_dump') else vp
                                converted_formats.append(normalized)
                            else:
                                converted_formats.append(_convert_format_string(fmt.type))
                        else:
                            converted_formats.append(fmt)
                else:
                    # Fallback: try to iterate over value if it's a list-like
                    try:
                        for fmt in value:
                            converted_formats.append(fmt)
                    except TypeError:
                        pass

                if converted_formats:
                    scrape_data["formats"] = converted_formats
            elif key == "actions":
                # Handle actions conversion
                converted_actions = []
                for action in value:
                    if isinstance(action, dict):
                        # Convert action dict
                        converted_action = {}
                        for action_key, action_value in action.items():
                            if action_key == "full_page":
                                converted_action["fullPage"] = action_value
                            else:
                                converted_action[action_key] = action_value
                        converted_actions.append(converted_action)
                    else:
                        # Handle action objects
                        action_data = action.model_dump(exclude_none=True)
                        converted_action = {}
                        for action_key, action_value in action_data.items():
                            if action_key == "full_page":
                                converted_action["fullPage"] = action_value
                            else:
                                converted_action[action_key] = action_value
                        converted_actions.append(converted_action)
                scrape_data["actions"] = converted_actions
            elif key == "location":
                # Handle location conversion
                if isinstance(value, dict):
                    scrape_data["location"] = value
                else:
                    scrape_data["location"] = value.model_dump(exclude_none=True)
            else:
                # For fields that don't need conversion, use as-is
                scrape_data[key] = value
    
    return scrape_data 