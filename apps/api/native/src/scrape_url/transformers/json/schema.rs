use serde_json::Value;

fn resolve_refs(schema: &Value, defs: &serde_json::Map<String, Value>, depth: u32) -> Value {
  if depth > 10 {
    return schema.clone();
  }

  match schema {
    Value::Object(map) => {
      if let Some(Value::String(reference)) = map.get("$ref") {
        let parts: Vec<&str> = reference.split('/').collect();
        if parts.first() == Some(&"#") && parts.get(1) == Some(&"$defs") {
          if let Some(def) = parts.last().and_then(|name| defs.get(*name)) {
            return resolve_refs(def, defs, depth + 1);
          }
        }
        return schema.clone();
      }

      map
        .iter()
        .filter(|(key, _)| *key != "$defs")
        .map(|(key, value)| (key.clone(), resolve_refs(value, defs, depth + 1)))
        .collect::<serde_json::Map<String, Value>>()
        .into()
    }
    Value::Array(items) => items
      .iter()
      .map(|item| resolve_refs(item, defs, depth + 1))
      .collect(),
    other => other.clone(),
  }
}

pub(super) fn resolve_schema_refs(schema: &Value) -> Value {
  let serialized = schema.to_string();
  let has_any_refs = schema.get("$defs").is_some()
    || serialized.contains("\"$ref\"")
    || serialized.contains("#/$defs/");

  let defs = match schema.get("$defs") {
    Some(Value::Object(defs)) => defs.clone(),
    _ => serde_json::Map::new(),
  };

  if !has_any_refs {
    return resolve_refs(schema, &defs, 0);
  }

  let resolved = resolve_refs(schema, &defs, 0);
  let resolved_serialized = resolved.to_string();
  if !resolved_serialized.contains("\"$ref\"") && !resolved_serialized.contains("#/$defs/") {
    resolved
  } else {
    schema.clone()
  }
}

pub(super) fn detect_recursive_schema(schema: &Value) -> bool {
  let serialized = schema.to_string();
  serialized.contains("\"$ref\"")
    || serialized.contains("#/$defs/")
    || serialized.contains("#/definitions/")
    || schema.get("$defs").is_some()
    || schema.get("definitions").is_some()
}

const UNSUPPORTED_SCHEMA_KEYS: &[&str] = &[
  "default",
  "patternProperties",
  "unevaluatedProperties",
  "propertyNames",
  "minProperties",
  "maxProperties",
  "minLength",
  "maxLength",
  "pattern",
  "format",
  "minimum",
  "maximum",
  "multipleOf",
  "unevaluatedItems",
  "contains",
  "minContains",
  "maxContains",
  "minItems",
  "maxItems",
  "uniqueItems",
];

fn remove_default_property(schema: &Value) -> Value {
  let Value::Object(map) = schema else {
    return schema.clone();
  };

  let mut out = serde_json::Map::with_capacity(map.len());
  for (key, value) in map {
    if UNSUPPORTED_SCHEMA_KEYS.contains(&key.as_str()) {
      continue;
    }
    out.insert(
      key.clone(),
      match value {
        Value::Array(items) => Value::Array(items.iter().map(remove_default_property).collect()),
        Value::Object(_) => remove_default_property(value),
        other => other.clone(),
      },
    );
  }
  Value::Object(out)
}

fn normalize_schema(x: &Value) -> Value {
  let Value::Object(map) = x else {
    return x.clone();
  };
  let mut map = map.clone();

  if let Some(Value::Object(defs)) = map.get_mut("$defs") {
    *defs = defs
      .iter()
      .map(|(name, schema)| (name.clone(), normalize_schema(schema)))
      .collect();
  }

  for key in ["anyOf", "oneOf", "allOf"] {
    if let Some(Value::Array(variants)) = map.get_mut(key) {
      *variants = variants.iter().map(normalize_schema).collect();
    }
  }

  if let Some(not) = map.get("not").cloned() {
    map.insert("not".to_string(), normalize_schema(&not));
  }

  match map.get("type").and_then(Value::as_str) {
    Some("object") => {
      let properties: serde_json::Map<String, Value> = match map.get("properties") {
        Some(Value::Object(properties)) => properties
          .iter()
          .map(|(k, v)| (k.clone(), normalize_schema(v)))
          .collect(),
        _ => serde_json::Map::new(),
      };
      let required = properties
        .keys()
        .cloned()
        .map(Value::String)
        .collect::<Vec<_>>();
      map.insert("properties".to_string(), Value::Object(properties));
      map.insert("required".to_string(), Value::Array(required));
      map.insert("additionalProperties".to_string(), Value::Bool(false));
      Value::Object(map)
    }
    Some("array") => {
      if let Some(items) = map.get("items").cloned() {
        map.insert("items".to_string(), normalize_schema(&items));
      }
      Value::Object(map)
    }
    _ => Value::Object(map),
  }
}

pub(super) fn normalize_user_schema(schema: &Value) -> Value {
  let stripped = remove_default_property(schema);

  let wrapped = if stripped.get("type").and_then(Value::as_str) == Some("array") {
    serde_json::json!({
      "type": "object",
      "properties": { "items": schema },
      "required": ["items"],
      "additionalProperties": false,
    })
  } else if stripped.is_object() && stripped.get("type").is_none() {
    let properties: serde_json::Map<String, Value> = stripped
      .as_object()
      .into_iter()
      .flatten()
      .map(|(k, v)| (k.clone(), remove_default_property(v)))
      .collect();
    let required = properties
      .keys()
      .cloned()
      .map(Value::String)
      .collect::<Vec<_>>();
    serde_json::json!({
      "type": "object",
      "properties": properties,
      "required": required,
      "additionalProperties": false,
    })
  } else {
    stripped
  };

  normalize_schema(&wrapped)
}
