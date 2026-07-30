//! Word field instruction parsing, shared by the doc and rtf providers.

/// Target of a HYPERLINK field instruction.
pub fn hyperlink_target(instruction: &str) -> Option<String> {
  let rest = instruction.trim_start();
  if !rest
    .get(..9)
    .is_some_and(|p| p.eq_ignore_ascii_case("HYPERLINK"))
  {
    return None;
  }
  let mut tokens = field_tokens(&rest[9..]);
  let mut anchor = false;
  while let Some(token) = tokens.next() {
    match token.as_str() {
      "\\l" => anchor = true,
      // switches whose argument is not the target
      "\\o" | "\\t" => {
        tokens.next();
      }
      t if t.starts_with('\\') => {}
      t => {
        return Some(if anchor {
          format!("#{t}")
        } else {
          t.to_string()
        });
      }
    }
  }
  None
}

/// Whitespace-separated tokens; quoted strings stay together, unquoted.
fn field_tokens(input: &str) -> impl Iterator<Item = String> + '_ {
  let mut chars = input.chars().peekable();
  std::iter::from_fn(move || {
    while chars.peek().is_some_and(|c| c.is_whitespace()) {
      chars.next();
    }
    match chars.peek() {
      None => None,
      Some('"') => {
        chars.next();
        let mut token = String::new();
        for c in chars.by_ref() {
          if c == '"' {
            break;
          }
          token.push(c);
        }
        Some(token)
      }
      Some(_) => {
        let mut token = String::new();
        while let Some(&c) = chars.peek() {
          if c.is_whitespace() {
            break;
          }
          token.push(c);
          chars.next();
        }
        Some(token)
      }
    }
  })
}
