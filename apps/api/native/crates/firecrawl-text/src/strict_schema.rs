use serde_json::{Map, Value};

const ROOT_ANNOTATIONS: &[&str] = &["$schema", "$id", "$comment"];

fn is_root_annotation(key: &str) -> bool {
  ROOT_ANNOTATIONS.contains(&key)
}

fn lowercase_type_in_place(val: &mut Value) {
  match val {
    Value::String(s) => {
      if s.bytes().any(|b| b.is_ascii_uppercase()) || !s.is_ascii() {
        *s = s.to_lowercase();
      }
    }
    Value::Array(arr) => {
      for elem in arr.iter_mut() {
        if let Value::String(s) = elem
          && (s.bytes().any(|b| b.is_ascii_uppercase()) || !s.is_ascii())
        {
          *s = s.to_lowercase();
        }
      }
    }
    _ => {}
  }
}

/// Returns whether a JSON Schema `type` value matches `name`, handling both a
/// single string (`"object"`) and a type array (`["array", "null"]`).
pub fn type_includes(type_val: Option<&Value>, name: &str) -> bool {
  match type_val {
    Some(Value::String(s)) => s == name,
    Some(Value::Array(arr)) => arr.iter().any(|v| v.as_str() == Some(name)),
    _ => false,
  }
}

fn is_typeless_root_schema(node: &Map<String, Value>) -> bool {
  let Some(Value::Object(props)) = node.get("properties") else {
    return false;
  };
  if props.get("type").is_some_and(Value::is_string) {
    return false;
  }
  node.iter().all(|(key, value)| match key.as_str() {
    "$schema" | "$id" | "$comment" | "title" | "description" => value.is_string(),
    "required" => value.is_array(),
    "additionalProperties" => value.is_boolean(),
    "properties" | "$defs" | "definitions" => value.is_object(),
    _ => false,
  })
}

fn is_bare_root_map(node: &Value) -> bool {
  let Some(map) = node.as_object() else {
    return false;
  };
  !map.contains_key("type")
    && !map.contains_key("anyOf")
    && !map.contains_key("oneOf")
    && !map.contains_key("$ref")
    && !is_typeless_root_schema(map)
}

/// Normalize mechanical JSON Schema keywords in place without cloning the tree.
pub fn normalize_schema_keywords_in_place(root: &mut Value) {
  let mut stack: Vec<(&mut Value, bool)> = Vec::with_capacity(32);
  stack.push((root, true));

  while let Some((node, is_root)) = stack.pop() {
    let Some(map) = node.as_object_mut() else {
      continue;
    };

    if let Some(type_val) = map.get_mut("type") {
      lowercase_type_in_place(type_val);
    }

    if map.get("oneOf").is_some_and(Value::is_array)
      && !map.contains_key("anyOf")
      && let Some(one_of) = map.shift_remove("oneOf")
    {
      map.insert("anyOf".to_owned(), one_of);
    }

    if !map.contains_key("type") {
      if is_root {
        if is_typeless_root_schema(map) {
          map.insert("type".to_owned(), Value::String("object".to_owned()));
        }
      } else if map.get("properties").is_some_and(Value::is_object) {
        map.insert("type".to_owned(), Value::String("object".to_owned()));
      } else if map.get("items").is_some_and(Value::is_object) {
        map.insert("type".to_owned(), Value::String("array".to_owned()));
      }
    }

    let has_obj_properties = map.get("properties").is_some_and(Value::is_object);

    for (key, val) in map.iter_mut() {
      match key.as_str() {
        "properties" | "$defs" | "definitions" => {
          if let Some(child_map) = val.as_object_mut() {
            for (_, child_val) in child_map.iter_mut() {
              stack.push((child_val, false));
            }
          }
        }
        "items" if val.is_object() => {
          stack.push((val, false));
        }
        "anyOf" => {
          if let Some(arr) = val.as_array_mut() {
            for item in arr.iter_mut() {
              stack.push((item, false));
            }
          }
        }
        "additionalProperties" if val.is_object() => {
          if has_obj_properties {
            *val = Value::Bool(false);
          } else {
            stack.push((val, false));
          }
        }
        _ => {}
      }
    }
  }
}

/// Lowercases type names (`"String"` -> `"string"`), turns `oneOf` into `anyOf`,
/// and infers missing `type` from `properties`/`items`. Never mutates `schema`.
pub fn normalize_schema_keywords(schema: &Value) -> Value {
  let mut out = schema.clone();
  normalize_schema_keywords_in_place(&mut out);
  out
}

/// Owned variant of `to_root_schema` that transforms `schema` in place without
/// cloning the full JSON tree.
pub fn to_root_schema_owned(mut schema: Value) -> Value {
  if !is_bare_root_map(&schema) {
    normalize_schema_keywords_in_place(&mut schema);
    return schema;
  }
  let Value::Object(map) = schema else {
    return schema;
  };

  let has_defs = map
    .get("$defs")
    .and_then(Value::as_object)
    .is_some_and(|d| !d.get("type").is_some_and(Value::is_string));

  let mut properties = Map::with_capacity(map.len());
  let mut required = Vec::with_capacity(map.len());
  let mut saved_defs: Option<Value> = None;

  for (key, val) in map {
    if has_defs && key == "$defs" {
      saved_defs = Some(val);
      continue;
    }
    if is_root_annotation(&key) {
      continue;
    }
    required.push(Value::String(key.clone()));
    properties.insert(key, val);
  }

  let mut root_map = Map::with_capacity(5);
  root_map.insert("type".to_owned(), Value::String("object".to_owned()));
  root_map.insert("properties".to_owned(), Value::Object(properties));
  root_map.insert("required".to_owned(), Value::Array(required));
  root_map.insert("additionalProperties".to_owned(), Value::Bool(false));
  if let Some(defs) = saved_defs {
    root_map.insert("$defs".to_owned(), defs);
  }

  let mut wrapped = Value::Object(root_map);
  normalize_schema_keywords_in_place(&mut wrapped);
  wrapped
}

/// `normalize_schema_keywords`, plus wrapping a bare map of property names to
/// schemas into an object schema.
pub fn to_root_schema(schema: &Value) -> Value {
  to_root_schema_owned(schema.clone())
}

pub(crate) fn drop_value_iteratively(root: Value) {
  let mut stack = vec![root];
  while let Some(value) = stack.pop() {
    match value {
      Value::Array(elements) => stack.extend(elements),
      Value::Object(map) => stack.extend(map.into_values()),
      _ => {}
    }
  }
}
