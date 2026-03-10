use serde::Deserialize;
use serde_json::Value;

/// Handles metadata fields that the API may return as either a string or an array of strings.
/// Arrays are joined with ", ".
pub(crate) fn deserialize_string_or_array<'de, D>(
    deserializer: D,
) -> Result<Option<String>, D::Error>
where
    D: serde::Deserializer<'de>,
{
    match Option::<Value>::deserialize(deserializer)? {
        None | Some(Value::Null) => Ok(None),
        Some(Value::String(s)) => Ok(Some(s)),
        Some(Value::Array(arr)) => {
            let strings: Vec<String> = arr
                .into_iter()
                .map(|v| match v {
                    Value::String(s) => s,
                    other => other.to_string(),
                })
                .collect();
            if strings.is_empty() {
                Ok(None)
            } else {
                Ok(Some(strings.join(", ")))
            }
        }
        Some(other) => Ok(Some(other.to_string())),
    }
}

#[cfg(test)]
mod tests {
    use serde::Deserialize;
    use serde_json::json;

    #[derive(Deserialize)]
    struct Helper {
        #[serde(default, deserialize_with = "super::deserialize_string_or_array")]
        field: Option<String>,
    }

    #[test]
    fn test_string_value() {
        let h: Helper = serde_json::from_value(json!({"field": "hello"})).unwrap();
        assert_eq!(h.field, Some("hello".to_string()));
    }

    #[test]
    fn test_array_value() {
        let h: Helper = serde_json::from_value(json!({"field": ["index", "follow"]})).unwrap();
        assert_eq!(h.field, Some("index, follow".to_string()));
    }

    #[test]
    fn test_null_value() {
        let h: Helper = serde_json::from_value(json!({"field": null})).unwrap();
        assert_eq!(h.field, None);
    }

    #[test]
    fn test_missing_field() {
        let h: Helper = serde_json::from_value(json!({})).unwrap();
        assert_eq!(h.field, None);
    }

    #[test]
    fn test_empty_array() {
        let h: Helper = serde_json::from_value(json!({"field": []})).unwrap();
        assert_eq!(h.field, None);
    }

    #[test]
    fn test_single_element_array() {
        let h: Helper = serde_json::from_value(json!({"field": ["noindex"]})).unwrap();
        assert_eq!(h.field, Some("noindex".to_string()));
    }

    #[test]
    fn test_serialization_roundtrip() {
        let h: Helper = serde_json::from_value(json!({"field": "index, follow"})).unwrap();
        assert_eq!(h.field, Some("index, follow".to_string()));
    }
}
