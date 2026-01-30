"""
Shared validation functions for Firecrawl v2 API.
"""

from typing import Optional, Dict, Any, List
from ..types import ScrapeOptions, ScrapeFormats, ParseOptions


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


def normalize_schema_for_openai(schema: Any) -> Any:
    """
    Normalize a schema for OpenAI compatibility by handling recursive references.
    
    Args:
        schema: Schema to normalize
        
    Returns:
        Normalized schema
    """
    if not schema or not isinstance(schema, dict):
        return schema

    visited = set()

    def normalize_object(obj: Any) -> Any:
        if not isinstance(obj, dict):
            if isinstance(obj, list):
                return [normalize_object(item) for item in obj]
            return obj

        obj_id = id(obj)
        if obj_id in visited:
            return obj
        visited.add(obj_id)

        normalized = dict(obj)

        # Handle $ref recursion
        if "$ref" in normalized:
            visited.discard(obj_id)
            return normalized

        if "$defs" in normalized:
            defs = normalized.pop("$defs")
            processed_rest = {}
            
            for key, value in normalized.items():
                if isinstance(value, dict) and "$ref" not in value:
                    processed_rest[key] = normalize_object(value)
                else:
                    processed_rest[key] = value
            
            normalized_defs = {}
            for key, value in defs.items():
                normalized_defs[key] = normalize_object(value)
            
            result = {**processed_rest, "$defs": normalized_defs}
            visited.discard(obj_id)
            return result

        if (normalized.get("type") == "object" and 
            "properties" in normalized and 
            normalized.get("additionalProperties") is True):
            del normalized["additionalProperties"]

        if (normalized.get("type") == "object" and 
            "required" in normalized and 
            "properties" in normalized):
            if (isinstance(normalized["required"], list) and 
                isinstance(normalized["properties"], dict)):
                valid_required = [field for field in normalized["required"] 
                               if field in normalized["properties"]]
                if valid_required:
                    normalized["required"] = valid_required
                else:
                    del normalized["required"]
            else:
                del normalized["required"]

        for key, value in list(normalized.items()):
            if isinstance(value, dict) and "$ref" not in value:
                normalized[key] = normalize_object(value)
            elif isinstance(value, list):
                normalized[key] = [normalize_object(item) if isinstance(item, dict) else item for item in value]

        visited.discard(obj_id)
        return normalized

    return normalize_object(schema)


def validate_schema_for_openai(schema: Any) -> bool:
    """
    Validate schema for OpenAI compatibility.
    
    Args:
        schema: Schema to validate
        
    Returns:
        True if schema is valid, False otherwise
    """
    if not schema or not isinstance(schema, dict):
        return True

    visited = set()

    def has_invalid_structure(obj: Any) -> bool:
        if not isinstance(obj, dict):
            return False

        obj_id = id(obj)
        if obj_id in visited:
            return False
        visited.add(obj_id)

        if "$ref" in obj:
            visited.discard(obj_id)
            return False

        if (obj.get("type") == "object" and 
            "properties" not in obj and 
            "patternProperties" not in obj and 
            obj.get("additionalProperties") is True):
            visited.discard(obj_id)
            return True

        for value in obj.values():
            if isinstance(value, dict) and "$ref" not in value:
                if has_invalid_structure(value):
                    visited.discard(obj_id)
                    return True
            elif isinstance(value, list):
                for item in value:
                    if isinstance(item, dict) and "$ref" not in item:
                        if has_invalid_structure(item):
                            visited.discard(obj_id)
                            return True

        visited.discard(obj_id)
        return False

    return not has_invalid_structure(schema)


OPENAI_SCHEMA_ERROR_MESSAGE = (
    "Schema contains invalid structure for OpenAI: object type with no 'properties' defined "
    "but 'additionalProperties: true' (schema-less dictionary not supported by OpenAI). "
    "Please define specific properties for your object. Note: Recursive schemas using '$ref' are supported."
)


def _contains_recursive_ref(obj: Any, target_def_name: str, defs: Dict[str, Any], visited: Optional[set] = None) -> bool:
    """
    Check if an object contains a recursive reference to a specific definition.
    
    Args:
        obj: Object to check
        target_def_name: Name of the definition to check for recursion
        defs: Dictionary of definitions
        visited: Set of visited object keys to detect cycles
        
    Returns:
        True if recursive reference is found, False otherwise
    """
    if not obj or not isinstance(obj, (dict, list)):
        return False
    
    if visited is None:
        visited = set()
    
    import json
    obj_key = json.dumps(obj, sort_keys=True, default=str)
    if obj_key in visited:
        return False
    visited.add(obj_key)
    
    try:
        if isinstance(obj, dict):
            if "$ref" in obj and isinstance(obj["$ref"], str):
                ref_path = obj["$ref"].split("/")
                if len(ref_path) >= 3 and ref_path[0] == "#" and ref_path[1] == "$defs":
                    def_name = ref_path[-1]
                    if def_name == target_def_name:
                        return True
                    if def_name in defs:
                        return _contains_recursive_ref(defs[def_name], target_def_name, defs, visited)
            
            for value in obj.values():
                if _contains_recursive_ref(value, target_def_name, defs, visited):
                    return True
        
        elif isinstance(obj, list):
            for item in obj:
                if _contains_recursive_ref(item, target_def_name, defs, visited):
                    return True
    
    finally:
        visited.discard(obj_key)
    
    return False


def _check_for_circular_defs(defs: Dict[str, Any]) -> bool:
    """
    Check if $defs contain circular references.
    
    Args:
        defs: Dictionary of definitions to check
        
    Returns:
        True if circular references are found, False otherwise
    """
    if not defs:
        return False
    
    for def_name, def_value in defs.items():
        if _contains_recursive_ref(def_value, def_name, defs):
            return True
    
    return False


def resolve_refs(obj: Any, defs: Dict[str, Any], visited: Optional[set] = None, depth: int = 0) -> Any:
    """
    Resolve $ref references in a JSON schema object.
    
    Args:
        obj: Object to resolve references in
        defs: Dictionary of definitions
        visited: Set to track visited objects and prevent infinite recursion
        depth: Current recursion depth
        
    Returns:
        Object with resolved references
    """
    if not obj or not isinstance(obj, (dict, list)) or depth > 10:
        return obj
    
    if visited is None:
        visited = set()
    
    obj_id = id(obj)
    if obj_id in visited:
        return obj
    
    visited.add(obj_id)
    
    try:
        if isinstance(obj, dict):
            if "$ref" in obj and isinstance(obj["$ref"], str):
                ref_path = obj["$ref"].split("/")
                if len(ref_path) >= 3 and ref_path[0] == "#" and ref_path[1] == "$defs":
                    def_name = ref_path[-1]
                    if def_name in defs:
                        return resolve_refs(dict(defs[def_name]), defs, visited, depth + 1)
                return obj
            
            resolved = {}
            for key, value in obj.items():
                if key == "$defs":
                    continue  
                resolved[key] = resolve_refs(value, defs, visited, depth + 1)
            return resolved
        
        elif isinstance(obj, list):
            return [resolve_refs(item, defs, visited, depth + 1) for item in obj]
        
    finally:
        visited.discard(obj_id)
    
    return obj


def detect_recursive_schema(schema: Any) -> bool:
    """
    Detect if a schema contains recursive references.
    
    Args:
        schema: Schema to analyze
        
    Returns:
        True if schema has recursive patterns, False otherwise
    """
    if not schema or not isinstance(schema, dict):
        return False

    import json
    schema_string = json.dumps(schema)
    has_refs = (
        '"$ref"' in schema_string or
        "#/$defs/" in schema_string or
        "#/definitions/" in schema_string
    )
    has_defs = bool(schema.get("$defs") or schema.get("definitions"))
    
    return has_refs or has_defs


def select_model_for_schema(schema: Any = None) -> Dict[str, str]:
    """
    Select appropriate model based on schema complexity.
    
    Args:
        schema: Schema to analyze
        
    Returns:
        Dict with modelName and reason
    """
    if not schema:
        return {"modelName": "gpt-4o-mini", "reason": "no_schema"}
    
    if detect_recursive_schema(schema):
        return {"modelName": "gpt-4o", "reason": "recursive_schema_detected"}
    
    return {"modelName": "gpt-4o-mini", "reason": "simple_schema"}


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
            # Handle schema reference resolution similar to TypeScript implementation
            if isinstance(normalized_schema, dict):
                defs = normalized_schema.get("$defs", {})
                import json
                schema_string = json.dumps(normalized_schema)
                has_any_refs = (
                    normalized_schema.get("$defs") or
                    '"$ref"' in schema_string or
                    "#/$defs/" in schema_string
                )
                
                if has_any_refs:
                    try:
                        resolved_schema = resolve_refs(normalized_schema, defs)
                        resolved_string = json.dumps(resolved_schema)
                        has_remaining_refs = '"$ref"' in resolved_string or "#/$defs/" in resolved_string
                        
                        if not has_remaining_refs:
                            normalized_schema = resolved_schema
                            # Remove $defs after successful resolution
                            if isinstance(normalized_schema, dict) and "$defs" in normalized_schema:
                                del normalized_schema["$defs"]
                        # If refs remain, preserve original schema
                    except Exception:
                        # Failed to resolve refs, preserve original schema
                        pass
                else:
                    # No recursive references detected, resolve refs anyway
                    try:
                        normalized_schema = resolve_refs(normalized_schema, defs)
                        if isinstance(normalized_schema, dict) and "$defs" in normalized_schema:
                            del normalized_schema["$defs"]
                    except Exception:
                        pass
            
            # Apply OpenAI normalization and validation
            openai_normalized_schema = normalize_schema_for_openai(normalized_schema)
            if not validate_schema_for_openai(openai_normalized_schema):
                raise ValueError(OPENAI_SCHEMA_ERROR_MESSAGE)
            
            normalized['schema'] = openai_normalized_schema
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
            if key == "integration":
                scrape_data["integration"] = (str(value).strip() or None)
                continue
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
            elif key == "parsers":
                converted_parsers = []
                for parser in value:
                    if isinstance(parser, str):
                        converted_parsers.append(parser)
                    elif isinstance(parser, dict):
                        parser_data = dict(parser)
                        if "max_pages" in parser_data:
                            parser_data["maxPages"] = parser_data.pop("max_pages")
                        converted_parsers.append(parser_data)
                    else:
                        parser_data = parser.model_dump(exclude_none=True)
                        # Convert snake_case to camelCase for API
                        if "max_pages" in parser_data:
                            parser_data["maxPages"] = parser_data.pop("max_pages")
                        converted_parsers.append(parser_data)
                scrape_data["parsers"] = converted_parsers
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


def validate_parse_options(options: Optional[ParseOptions]) -> Optional[ParseOptions]:
    """
    Validate and normalize parse options.

    Args:
        options: Parsing options to validate

    Returns:
        Validated options or None

    Raises:
        ValueError: If options are invalid
    """
    if options is None:
        return None

    if options.timeout is not None and options.timeout <= 0:
        raise ValueError("Timeout must be positive")

    return options


def prepare_parse_options(options: Optional[ParseOptions]) -> Optional[Dict[str, Any]]:
    """
    Prepare ParseOptions for API submission with manual snake_case to camelCase conversion.

    Args:
        options: ParseOptions to prepare

    Returns:
        Dictionary ready for API submission or None if options is None
    """
    if options is None:
        return None

    validated_options = validate_parse_options(options)
    if validated_options is None:
        return None

    options_data = validated_options.model_dump(exclude_none=True)
    parse_data: Dict[str, Any] = {}

    field_mappings = {
        "include_tags": "includeTags",
        "exclude_tags": "excludeTags",
        "only_main_content": "onlyMainContent",
        "remove_base64_images": "removeBase64Images",
    }

    for snake_case, camel_case in field_mappings.items():
        if snake_case in options_data:
            parse_data[camel_case] = options_data.pop(snake_case)

    allowed_formats = {
        "markdown",
        "html",
        "rawHtml",
        "links",
        "images",
        "summary",
        "json",
        "attributes",
    }

    formats_value = options_data.pop("formats", None)
    if formats_value is not None:
        converted_formats: List[Any] = []
        for fmt in formats_value:
            if isinstance(fmt, str):
                fmt_type = _convert_format_string(fmt)
                if fmt_type == "json":
                    raise ValueError(
                        "json format must be an object with 'type', 'prompt', and 'schema' fields"
                    )
                if fmt_type not in allowed_formats:
                    raise ValueError(f"Unsupported parse format: {fmt_type}")
                converted_formats.append(fmt_type)
            elif isinstance(fmt, dict):
                fmt_type = _convert_format_string(fmt.get("type")) if fmt.get("type") else None
                if fmt_type not in allowed_formats:
                    raise ValueError(f"Unsupported parse format: {fmt_type}")
                if fmt_type == "json":
                    converted_formats.append(_validate_json_format({**fmt, "type": "json"}))
                else:
                    if fmt_type:
                        fmt["type"] = fmt_type
                    converted_formats.append(fmt)
            elif hasattr(fmt, "type"):
                fmt_type = _convert_format_string(fmt.type)
                if fmt_type not in allowed_formats:
                    raise ValueError(f"Unsupported parse format: {fmt_type}")
                if fmt_type == "json":
                    converted_formats.append(_validate_json_format(fmt.model_dump()))
                else:
                    converted_formats.append(fmt_type)
            else:
                converted_formats.append(fmt)

        if converted_formats:
            parse_data["formats"] = converted_formats

    parsers_value = options_data.pop("parsers", None)
    if parsers_value is not None:
        converted_parsers = []
        for parser in parsers_value:
            if isinstance(parser, str):
                converted_parsers.append(parser)
            elif isinstance(parser, dict):
                parser_data = dict(parser)
                if "max_pages" in parser_data:
                    parser_data["maxPages"] = parser_data.pop("max_pages")
                converted_parsers.append(parser_data)
            else:
                parser_data = parser.model_dump(exclude_none=True)
                if "max_pages" in parser_data:
                    parser_data["maxPages"] = parser_data.pop("max_pages")
                converted_parsers.append(parser_data)
        parse_data["parsers"] = converted_parsers

    for key, value in options_data.items():
        if value is not None:
            parse_data[key] = value

    return parse_data
