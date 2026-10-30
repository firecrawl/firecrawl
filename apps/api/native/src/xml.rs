//! Guards shared by the XML parsers in this crate.

/// roxmltree recurses once per nesting level and overflows the stack on
/// deeply nested input, which aborts the whole process instead of erroring.
/// This flat pass counts element nesting without parsing: comments, CDATA
/// sections, processing instructions and declarations (including a DOCTYPE
/// internal subset) are skipped, and self-closing elements add no depth.
///
/// Markup the scan cannot follow to its end, such as an unterminated tag,
/// comment or attribute value, also returns `true`: the depth of what follows
/// is unknown, so it must not reach the recursive parser.
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
        return true;
      };
      i += end + marker.len();
      continue;
    }
    if rest.starts_with("<!DOCTYPE") {
      let Some(end) = doctype_end(rest) else {
        return true;
      };
      i += end + 1;
      continue;
    }

    let Some(end) = unquoted_tag_end(rest) else {
      return true;
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

/// Index of the `>` closing the DOCTYPE declaration at the start of `decl`.
/// An internal subset (`[...]`) may hold comments and quoted literals, which
/// are skipped so their contents cannot end the declaration early or hide its
/// end.
fn doctype_end(decl: &str) -> Option<usize> {
  let bytes = decl.as_bytes();
  let mut quote: Option<u8> = None;
  let mut in_subset = false;
  let mut i = 0;
  while i < bytes.len() {
    let b = bytes[i];
    if let Some(q) = quote {
      if b == q {
        quote = None;
      }
      i += 1;
      continue;
    }
    if in_subset && decl[i..].starts_with("<!--") {
      i += decl[i..].find("-->")? + 3;
      continue;
    }
    match b {
      b'"' | b'\'' => quote = Some(b),
      b'[' => in_subset = true,
      b']' => in_subset = false,
      b'>' if !in_subset => return Some(i),
      _ => {}
    }
    i += 1;
  }
  None
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
  fn rejects_markup_it_cannot_follow() {
    assert!(exceeds_element_depth("<a><!-- never closed", 1));
    assert!(exceeds_element_depth("<a attr=\"unterminated", 1));
    assert!(exceeds_element_depth("<!DOCTYPE a [ <!ELEMENT a ANY> ", 1));
  }

  #[test]
  fn skips_a_doctype_internal_subset() {
    let doctype = "<!DOCTYPE a [ <!-- it's a comment with a quote --> <!ELEMENT a ANY> <!ATTLIST a x CDATA \"]>\"> ]>";
    assert!(!exceeds_element_depth(&format!("{doctype}<a><b/></a>"), 1));
    assert!(exceeds_element_depth(&format!("{doctype}{}", nested(2)), 1));
  }

  #[test]
  fn quote_in_a_doctype_comment_does_not_hide_deep_nesting() {
    let xml = format!("<!DOCTYPE a [ <!-- don't --> ]>{}", nested(40));
    assert!(exceeds_element_depth(&xml, 32));
  }
}
