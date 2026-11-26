use serde_json::Value;

use crate::strict_schema::{
  drop_value_iteratively, to_root_schema, to_root_schema_owned, type_includes,
};

const JSON_SCHEMA_TYPES: &[&str] = &[
  "string", "number", "integer", "boolean", "object", "array", "null",
];

const UNSUPPORTED_KEYWORDS: &[&str] = &[
  "allOf",
  "oneOf",
  "not",
  "if",
  "then",
  "else",
  "dependentRequired",
  "dependentSchemas",
];

fn is_json_schema_type(name: &str) -> bool {
  matches!(
    name,
    "string" | "number" | "integer" | "boolean" | "object" | "array" | "null"
  )
}

fn unsupported_keyword_rank(key: &str) -> Option<usize> {
  UNSUPPORTED_KEYWORDS.iter().position(|&kw| kw == key)
}

fn truncate_utf16_60(s: &str) -> String {
  let utf16_total: usize = s.chars().map(char::len_utf16).sum();
  if utf16_total <= 60 {
    return s.to_owned();
  }
  let mut out = String::with_capacity(60);
  let mut units = 0usize;
  for ch in s.chars() {
    let next_units = units.saturating_add(ch.len_utf16());
    if next_units > 57 {
      break;
    }
    out.push(ch);
    units = next_units;
  }
  out.push_str("...");
  out
}

fn describe_value(value: &Value) -> String {
  let json = serde_json::to_string(value).unwrap_or_else(|_| "undefined".to_owned());
  truncate_utf16_60(&json)
}

fn describe_opt(value: Option<&Value>) -> String {
  match value {
    Some(v) => describe_value(v),
    None => "undefined".to_owned(),
  }
}

enum PathSeg<'a> {
  Named(&'a str, &'a str),
  Items,
  AnyOf(usize),
}

fn format_at_from_segs(segs: &[PathSeg<'_>]) -> String {
  if segs.is_empty() {
    return String::new();
  }
  let mut out = String::from(" at \"");
  for (idx, seg) in segs.iter().enumerate() {
    if idx > 0 {
      out.push('.');
    }
    match seg {
      PathSeg::Named(prefix, key) => {
        out.push_str(prefix);
        out.push('.');
        out.push_str(key);
      }
      PathSeg::Items => out.push_str("items"),
      PathSeg::AnyOf(i) => {
        out.push_str("anyOf.");
        out.push_str(&i.to_string());
      }
    }
  }
  out.push('"');
  out
}

enum CheckFrame<'a> {
  Enter(&'a Value, Option<PathSeg<'a>>),
  Exit,
  AnyOfNotArray(&'a Value),
}

fn check_root_and_tree(root: &Value) -> Option<String> {
  let Some(root_map) = root.as_object() else {
    return Some(format!(
      "Invalid JSON schema: expected an object, got {}.",
      describe_value(root)
    ));
  };

  if !root_map.contains_key("$ref") {
    if root_map.contains_key("anyOf") {
      return Some(
        "Invalid JSON schema: the root must be an object or array schema, not \"anyOf\"."
          .to_owned(),
      );
    }
    if !type_includes(root_map.get("type"), "object")
      && !type_includes(root_map.get("type"), "array")
    {
      return Some(format!(
        "Invalid JSON schema: the root must be an object or array schema, got type {}.",
        describe_opt(root_map.get("type"))
      ));
    }
  }

  let mut stack: Vec<CheckFrame<'_>> = Vec::with_capacity(64);
  let mut path_segs: Vec<PathSeg<'_>> = Vec::with_capacity(16);
  stack.push(CheckFrame::Enter(root, None));

  while let Some(frame) = stack.pop() {
    match frame {
      CheckFrame::Exit => {
        path_segs.pop();
      }
      CheckFrame::AnyOfNotArray(other) => {
        let at = format_at_from_segs(&path_segs);
        return Some(format!(
          "Invalid JSON schema{at}: \"anyOf\" must be an array, got {}.",
          describe_value(other)
        ));
      }
      CheckFrame::Enter(node, seg) => {
        if let Some(s) = seg {
          path_segs.push(s);
          stack.push(CheckFrame::Exit);
        }

        let Some(map) = node.as_object() else {
          let at = format_at_from_segs(&path_segs);
          return Some(format!(
            "Invalid JSON schema{at}: expected a schema object, got {}.",
            describe_value(node)
          ));
        };

        // Single linear pass over the schema object's keys avoids repeated
        // IndexMap hashing per node (most schema nodes have 2-5 keys).
        let mut first_unsupported: Option<usize> = None;
        let mut is_reference = false;
        let mut has_enum_or_const = false;
        let mut type_opt: Option<&Value> = None;
        let mut any_of_opt: Option<&Value> = None;
        let mut items_opt: Option<&Value> = None;
        let mut props_opt: Option<&Value> = None;
        let mut addl_props_is_obj = false;
        let mut defs_opt: Option<&serde_json::Map<String, Value>> = None;
        let mut definitions_opt: Option<&serde_json::Map<String, Value>> = None;

        for (key, val) in map {
          match key.as_str() {
            "$ref" => is_reference = true,
            "enum" | "const" => has_enum_or_const = true,
            "type" => type_opt = Some(val),
            "anyOf" => any_of_opt = Some(val),
            "items" => items_opt = Some(val),
            "properties" => props_opt = Some(val),
            "additionalProperties" => addl_props_is_obj = val.is_object(),
            "$defs" => defs_opt = val.as_object(),
            "definitions" => definitions_opt = val.as_object(),
            other => {
              if let Some(rank) = unsupported_keyword_rank(other) {
                first_unsupported = Some(first_unsupported.map_or(rank, |prev| prev.min(rank)));
              }
            }
          }
        }

        if let Some(rank) = first_unsupported
          && let Some(&keyword) = UNSUPPORTED_KEYWORDS.get(rank)
        {
          let at = format_at_from_segs(&path_segs);
          return Some(format!(
            "Invalid JSON schema{at}: \"{keyword}\" is not supported for JSON extraction."
          ));
        }

        if !is_reference && type_opt.is_none() && any_of_opt.is_none() && !has_enum_or_const {
          let at = format_at_from_segs(&path_segs);
          return Some(format!("Invalid JSON schema{at}: missing \"type\"."));
        }

        if let Some(type_val) = type_opt {
          let invalid = match type_val {
            Value::Array(arr) => {
              arr.is_empty()
                || arr
                  .iter()
                  .any(|t| !t.as_str().is_some_and(is_json_schema_type))
            }
            Value::String(s) => !is_json_schema_type(s),
            _ => true,
          };
          if invalid {
            let at = format_at_from_segs(&path_segs);
            return Some(format!(
              "Invalid JSON schema{at}: \"type\" must be one of {}, got {}.",
              JSON_SCHEMA_TYPES.join(", "),
              describe_value(type_val)
            ));
          }
        }

        if !is_reference
          && type_includes(type_opt, "array")
          && !items_opt.is_some_and(Value::is_object)
        {
          let at = format_at_from_segs(&path_segs);
          return Some(match items_opt {
            None => format!("Invalid JSON schema{at}: arrays must define \"items\"."),
            Some(items_val) => format!(
              "Invalid JSON schema{at}: \"items\" must be a single schema object, got {}.",
              describe_value(items_val)
            ),
          });
        }

        if type_includes(type_opt, "object") && props_opt.is_none() && addl_props_is_obj {
          let at = format_at_from_segs(&path_segs);
          return Some(format!(
            "Invalid JSON schema{at}: objects must list their \"properties\"; a dictionary described only by \"additionalProperties\" is not supported for JSON extraction."
          ));
        }

        if let Some(props_val) = props_opt
          && !props_val.is_object()
        {
          let at = format_at_from_segs(&path_segs);
          return Some(format!(
            "Invalid JSON schema{at}: \"properties\" must be an object, got {}.",
            describe_value(props_val)
          ));
        }

        let any_of_is_bad = any_of_opt.is_some_and(|v| !v.is_array());
        if !any_of_is_bad {
          if let Some(defs) = definitions_opt {
            for (key, value) in defs.iter().rev() {
              stack.push(CheckFrame::Enter(
                value,
                Some(PathSeg::Named("definitions", key)),
              ));
            }
          }
          if let Some(defs) = defs_opt {
            for (key, value) in defs.iter().rev() {
              stack.push(CheckFrame::Enter(value, Some(PathSeg::Named("$defs", key))));
            }
          }
          if let Some(Value::Array(arr)) = any_of_opt {
            for (i, item) in arr.iter().enumerate().rev() {
              stack.push(CheckFrame::Enter(item, Some(PathSeg::AnyOf(i))));
            }
          }
        } else if let Some(other) = any_of_opt {
          stack.push(CheckFrame::AnyOfNotArray(other));
        }

        if let Some(items_val) = items_opt
          && items_val.is_object()
        {
          stack.push(CheckFrame::Enter(items_val, Some(PathSeg::Items)));
        }

        if let Some(Value::Object(props)) = props_opt {
          for (key, value) in props.iter().rev() {
            stack.push(CheckFrame::Enter(
              value,
              Some(PathSeg::Named("properties", key)),
            ));
          }
        }
      }
    }
  }

  None
}

/// Owned variant of `find_strict_schema_violation` that normalizes and drops
/// `schema` in place without cloning the full JSON tree.
pub fn find_strict_schema_violation_owned(schema: Value) -> Option<String> {
  if schema.is_null() {
    return None;
  }
  let root = to_root_schema_owned(schema);
  let violation = check_root_and_tree(&root);
  drop_value_iteratively(root);
  violation
}

/// Returns a human-readable description of the first construct in `schema`
/// rejected by OpenAI strict structured outputs, or `None` if valid.
pub fn find_strict_schema_violation(schema: &Value) -> Option<String> {
  if schema.is_null() {
    return None;
  }
  let root = to_root_schema(schema);
  let violation = check_root_and_tree(&root);
  drop_value_iteratively(root);
  violation
}
