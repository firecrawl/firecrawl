//! Guards shared by the XML parsers in this crate.

/// roxmltree recurses once per nesting level and overflows the stack on
/// deeply nested input, which aborts the whole process instead of erroring.
/// This flat pass counts element nesting without parsing: comments, CDATA
/// sections, processing instructions and declarations are skipped, and
/// self-closing elements add no depth. Malformed input returns `false` and is
/// left for the real parser to reject.
pub(crate) fn exceeds_element_depth(xml: &str, limit: usize) -> bool {
  let mut depth = 0usize;
  let mut i = 0;
  while let Some(offset) = xml[i..].find('<') {
    i += offset;
    let rest = &xml[i..];
    let skip_to = if rest.starts_with("<!--") {
      Some("-->")
    } else if rest.starts_with("<![CDATA[") {
      Some("]]>")
    } else if rest.starts_with("<?") {
      Some("?>")
    } else {
      None
    };
    if let Some(marker) = skip_to {
      let Some(end) = rest.find(marker) else {
        return false;
      };
      i += end + marker.len();
      continue;
    }

    let Some(end) = unquoted_tag_end(rest) else {
      return false;
    };
    let tag = &rest[..end];
    if tag.starts_with("</") {
      depth = depth.saturating_sub(1);
    } else if !tag.starts_with("<!") && !tag.ends_with('/') {
      depth += 1;
      if depth > limit {
        return true;
      }
    }
    i += end + 1;
  }
  false
}

/// Index of the `>` closing the tag at the start of `tag`, ignoring any inside quoted attribute values.
fn unquoted_tag_end(tag: &str) -> Option<usize> {
  let mut quote = None;
  for (i, b) in tag.bytes().enumerate() {
    match quote {
      Some(q) if b == q => quote = None,
      Some(_) => {}
      None if b == b'"' || b == b'\'' => quote = Some(b),
      None if b == b'>' => return Some(i),
      None => {}
    }
  }
  None
}

#[cfg(test)]
mod tests {
  use super::*;

  fn nested(depth: usize) -> String {
    format!("{}x{}", "<a>".repeat(depth), "</a>".repeat(depth))
  }

  #[test]
  fn counts_element_nesting() {
    assert!(!exceeds_element_depth(&nested(3), 3));
    assert!(exceeds_element_depth(&nested(4), 3));
  }

  #[test]
  fn ignores_non_elements_and_quoted_brackets() {
    let xml = "<?xml version=\"1.0\"?><!DOCTYPE a><!-- <a><a><a> --><a><![CDATA[<a><a>]]><b/><c attr=\"<a><a>\" other='>'/></a>";
    assert!(!exceeds_element_depth(xml, 1));
  }

  #[test]
  fn leaves_malformed_input_to_the_parser() {
    assert!(!exceeds_element_depth("<a><!-- never closed", 1));
    assert!(!exceeds_element_depth("<a attr=\"unterminated", 0));
  }
}
