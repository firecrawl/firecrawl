//! Cleaned HTML to markdown, written for what an LLM reads: every code block
//! fenced (with its language when the page says it), every data table kept as
//! a table, layout tables unwrapped, permalink anchors and inline data images
//! dropped, and no padding that only costs tokens.

use kuchikiki::{parse_html, traits::TendrilSink, NodeRef};

const SKIPPED: &[&str] = &[
  "script", "style", "noscript", "template", "svg", "head", "iframe", "canvas", "object", "embed",
  "select", "textarea", "input", "link", "meta", "title", "audio", "video", "source", "track",
  "map", "area", "math",
];

const BLOCKS: &[&str] = &[
  "address",
  "article",
  "aside",
  "blockquote",
  "body",
  "center",
  "dd",
  "details",
  "dialog",
  "div",
  "dl",
  "dt",
  "fieldset",
  "figcaption",
  "figure",
  "footer",
  "form",
  "h1",
  "h2",
  "h3",
  "h4",
  "h5",
  "h6",
  "header",
  "hgroup",
  "hr",
  "html",
  "li",
  "main",
  "nav",
  "ol",
  "p",
  "pre",
  "section",
  "summary",
  "table",
  "tbody",
  "td",
  "tfoot",
  "th",
  "thead",
  "tr",
  "ul",
  "caption",
];

fn tag_of(node: &NodeRef) -> Option<&str> {
  node.as_element().map(|e| e.name.local.as_ref())
}

fn attr(node: &NodeRef, name: &str) -> Option<String> {
  node
    .as_element()
    .and_then(|e| e.attributes.borrow().get(name).map(str::to_string))
}

fn is_block(name: &str) -> bool {
  BLOCKS.contains(&name)
}

fn is_skipped(name: &str) -> bool {
  SKIPPED.contains(&name)
}

/// Collapse every run of whitespace to one space.
fn collapse_ws(text: &str, out: &mut String) {
  let mut last_space = out.ends_with(' ') || out.ends_with('\n');
  for ch in text.chars() {
    if ch.is_whitespace() {
      if !last_space {
        out.push(' ');
        last_space = true;
      }
    } else {
      out.push(ch);
      last_space = false;
    }
  }
}

/// Tidy one paragraph of inline output: no spaces around line breaks, no
/// doubled spaces, trimmed.
fn normalize_inline(text: &str) -> String {
  let mut out = String::with_capacity(text.len());
  for (i, line) in text.split('\n').enumerate() {
    if i > 0 {
      out.push('\n');
    }
    let mut last_space = true;
    for ch in line.trim().chars() {
      if ch == ' ' {
        if !last_space {
          out.push(' ');
        }
        last_space = true;
      } else {
        out.push(ch);
        last_space = false;
      }
    }
  }
  let trimmed = out.trim_matches(|c: char| c == '\n' || c == ' ');
  // Collapse blank lines left by stray <br> runs.
  let mut result = String::with_capacity(trimmed.len());
  let mut newline_run = 0;
  for ch in trimmed.chars() {
    if ch == '\n' {
      newline_run += 1;
      if newline_run > 1 {
        continue;
      }
    } else {
      newline_run = 0;
    }
    result.push(ch);
  }
  result
}

/// Stop plain text from being read as a heading, quote or list item.
fn escape_line_starts(paragraph: &str) -> String {
  let mut out = String::with_capacity(paragraph.len() + 4);
  for (i, line) in paragraph.split('\n').enumerate() {
    if i > 0 {
      out.push('\n');
    }
    let bytes = line.as_bytes();
    let needs = match bytes.first() {
      Some(b'#') => line.trim_start_matches('#').starts_with(' '),
      Some(b'>') => true,
      Some(b'-') | Some(b'+') => bytes.get(1) == Some(&b' '),
      Some(c) if c.is_ascii_digit() => {
        let digits = line.chars().take_while(|c| c.is_ascii_digit()).count();
        matches!(bytes.get(digits), Some(b'.') | Some(b')')) && bytes.get(digits + 1) == Some(&b' ')
      }
      _ => false,
    };
    if needs {
      out.push('\\');
    }
    out.push_str(line);
  }
  out
}

fn wrap(marker: &str, inner: &str) -> String {
  let trimmed = inner.trim();
  if trimmed.is_empty() {
    return inner.to_string();
  }
  let lead = if inner.starts_with(char::is_whitespace) {
    " "
  } else {
    ""
  };
  let trail = if inner.ends_with(char::is_whitespace) {
    " "
  } else {
    ""
  };
  format!("{lead}{marker}{trimmed}{marker}{trail}")
}

fn code_span(text: &str) -> String {
  let text = text.replace('\n', " ");
  let text = text.trim();
  if text.is_empty() {
    return String::new();
  }
  if text.contains('`') {
    format!("`` {text} ``")
  } else {
    format!("`{text}`")
  }
}

fn inline_children(node: &NodeRef) -> String {
  let mut out = String::new();
  for child in node.children() {
    inline(&child, &mut out);
  }
  out
}

fn is_permalink_text(text: &str) -> bool {
  matches!(text.trim(), "¶" | "#" | "§" | "🔗" | "" | "🔖" | "¤")
}

fn inline(node: &NodeRef, out: &mut String) {
  if let Some(text) = node.as_text() {
    collapse_ws(&text.borrow(), out);
    return;
  }
  let Some(name) = tag_of(node) else {
    // Documents, comments, doctypes.
    if node.as_document().is_some() {
      for child in node.children() {
        inline(&child, out);
      }
    }
    return;
  };
  if is_skipped(name) {
    return;
  }
  match name {
    "br" => out.push('\n'),
    "a" => {
      let text = normalize_inline(&inline_children(node)).replace('\n', " ");
      let href = attr(node, "href").unwrap_or_default();
      let href = href.trim();
      let has_image = text.contains("![");
      if !has_image && is_permalink_text(&text) {
        return;
      }
      let lower = href.to_ascii_lowercase();
      if href.is_empty() || lower.starts_with("javascript:") || href == "#" {
        out.push_str(&text);
      } else {
        let href = href
          .replace(' ', "%20")
          .replace('(', "%28")
          .replace(')', "%29");
        out.push_str(&format!("[{text}]({href})"));
      }
    }
    "img" => {
      let src = attr(node, "src").unwrap_or_default();
      let src = src.trim();
      if src.is_empty() || src.starts_with("data:") {
        return;
      }
      let alt = attr(node, "alt").unwrap_or_default();
      let alt = alt.replace(['\n', '[', ']'], " ");
      let src = src
        .replace(' ', "%20")
        .replace('(', "%28")
        .replace(')', "%29");
      out.push_str(&format!("![{}]({src})", alt.trim()));
    }
    "strong" | "b" => out.push_str(&wrap("**", &inline_children(node))),
    "em" | "i" | "cite" | "dfn" | "var" => out.push_str(&wrap("*", &inline_children(node))),
    "del" | "s" | "strike" => out.push_str(&wrap("~~", &inline_children(node))),
    "code" | "kbd" | "samp" | "tt" => {
      let lead = out.ends_with(|c: char| c.is_alphanumeric());
      if lead {
        out.push(' ');
      }
      out.push_str(&code_span(&node.text_contents()));
    }
    "pre" => {
      out.push('\n');
      out.push_str(&code_block(node));
      out.push('\n');
    }
    _ if is_block(name) => {
      // A block inside inline content (a div inside a link, say).
      if !out.ends_with(' ') && !out.is_empty() {
        out.push(' ');
      }
      for child in node.children() {
        inline(&child, out);
      }
      if !out.ends_with(' ') {
        out.push(' ');
      }
    }
    _ => {
      for child in node.children() {
        inline(&child, out);
      }
    }
  }
}

fn clean_language(token: &str) -> Option<String> {
  let token = token.trim_matches(|c: char| !(c.is_ascii_alphanumeric() || c == '+' || c == '#'));
  if token.is_empty() || token.len() > 24 {
    return None;
  }
  let lower = token.to_ascii_lowercase();
  if matches!(
    lower.as_str(),
    "none"
      | "text"
      | "plain"
      | "plaintext"
      | "default"
      | "notranslate"
      | "highlight"
      | "code"
      | "wrap"
      | "nohighlight"
  ) {
    return None;
  }
  if lower
    .chars()
    .all(|c| c.is_ascii_alphanumeric() || matches!(c, '+' | '#' | '-' | '_'))
  {
    Some(lower)
  } else {
    None
  }
}

fn language_from_classes(classes: &str) -> Option<String> {
  for token in classes.split_whitespace() {
    for prefix in [
      "language-",
      "lang-",
      "highlight-source-",
      "highlight-",
      "brush:",
      "sourceCode-",
      "hljs-language-",
    ] {
      if let Some(rest) = token.strip_prefix(prefix) {
        if let Some(lang) = clean_language(rest) {
          return Some(lang);
        }
      }
    }
  }
  None
}

fn code_language(pre: &NodeRef) -> Option<String> {
  let mut candidates: Vec<NodeRef> = vec![pre.clone()];
  if let Some(code) = pre.children().find(|c| tag_of(c) == Some("code")) {
    candidates.push(code);
  }
  let mut up = pre.parent();
  for _ in 0..3 {
    match up {
      Some(p) => {
        candidates.push(p.clone());
        up = p.parent();
      }
      None => break,
    }
  }
  for node in candidates {
    for name in ["class", "data-lang", "data-language", "lang"] {
      if let Some(value) = attr(&node, name) {
        let found = if name == "class" {
          language_from_classes(&value)
        } else if name == "lang" {
          // `lang` on an ancestor is usually the page's human language.
          None
        } else {
          clean_language(&value)
        };
        if found.is_some() {
          return found;
        }
      }
    }
  }
  None
}

/// Text of a `<pre>`, keeping line breaks written as `<br>`.
fn pre_text(node: &NodeRef, out: &mut String) {
  for child in node.children() {
    if let Some(text) = child.as_text() {
      out.push_str(&text.borrow());
    } else if let Some(name) = tag_of(&child) {
      if name == "br" {
        out.push('\n');
      } else if !is_skipped(name) {
        pre_text(&child, out);
      }
    }
  }
}

fn code_block(pre: &NodeRef) -> String {
  let mut text = String::new();
  pre_text(pre, &mut text);
  let text = text.replace("\r\n", "\n");
  let text = text.trim_matches('\n').trim_end();
  if text.trim().is_empty() {
    return String::new();
  }
  let lang = code_language(pre).unwrap_or_default();
  let fence = if text.contains("```") { "````" } else { "```" };
  format!("{fence}{lang}\n{text}\n{fence}")
}

fn heading(node: &NodeRef, level: usize) -> String {
  let text = normalize_inline(&inline_children(node)).replace('\n', " ");
  if text.is_empty() {
    return String::new();
  }
  format!("{} {}", "#".repeat(level), text)
}

fn indent_continuation(text: &str, width: usize) -> String {
  let pad = " ".repeat(width);
  let mut out = String::with_capacity(text.len());
  for (i, line) in text.split('\n').enumerate() {
    if i > 0 {
      out.push('\n');
      if !line.is_empty() {
        out.push_str(&pad);
      }
    }
    out.push_str(line);
  }
  out
}

fn list(node: &NodeRef, ordered: bool) -> String {
  let mut number: usize = attr(node, "start")
    .and_then(|s| s.trim().parse().ok())
    .unwrap_or(1);
  let mut items: Vec<String> = Vec::new();
  for child in node.children() {
    let Some(name) = tag_of(&child) else { continue };
    match name {
      "li" => {
        let parts = blocks(&child);
        if parts.is_empty() {
          continue;
        }
        // Keep an item and its nested list tight; separate real paragraphs.
        let mut body = String::new();
        for (i, part) in parts.iter().enumerate() {
          if i > 0 {
            let nested_list =
              part.starts_with("- ") || part.starts_with(|c: char| c.is_ascii_digit());
            body.push_str(if nested_list { "\n" } else { "\n\n" });
          }
          body.push_str(part);
        }
        let marker = if ordered {
          let m = format!("{number}. ");
          number += 1;
          m
        } else {
          "- ".to_string()
        };
        let width = marker.len();
        items.push(format!("{marker}{}", indent_continuation(&body, width)));
      }
      "ul" | "ol" => {
        // A list nested directly in a list, without its own <li>.
        let nested = list(&child, name == "ol");
        if !nested.is_empty() {
          match items.last_mut() {
            Some(last) => {
              last.push('\n');
              last.push_str(&indent_continuation(&format!("  {nested}"), 2));
            }
            None => items.push(nested),
          }
        }
      }
      _ => {}
    }
  }
  items.join("\n")
}

fn quote(node: &NodeRef) -> String {
  let inner = blocks(node).join("\n\n");
  if inner.is_empty() {
    return String::new();
  }
  inner
    .split('\n')
    .map(|line| {
      if line.is_empty() {
        ">".to_string()
      } else {
        format!("> {line}")
      }
    })
    .collect::<Vec<_>>()
    .join("\n")
}

struct Row {
  cells: Vec<NodeRef>,
  header: bool,
}

fn collect_rows(node: &NodeRef, in_head: bool, rows: &mut Vec<Row>, caption: &mut Option<String>) {
  for child in node.children() {
    match tag_of(&child) {
      Some("thead") => collect_rows(&child, true, rows, caption),
      Some("tbody") | Some("tfoot") => collect_rows(&child, false, rows, caption),
      Some("caption") => {
        let text = normalize_inline(&inline_children(&child)).replace('\n', " ");
        if !text.is_empty() {
          *caption = Some(text);
        }
      }
      Some("tr") => {
        let cells: Vec<NodeRef> = child
          .children()
          .filter(|c| matches!(tag_of(c), Some("td") | Some("th")))
          .collect();
        if cells.is_empty() {
          continue;
        }
        let all_th = cells.iter().all(|c| tag_of(c) == Some("th"));
        rows.push(Row {
          cells,
          header: in_head || all_th,
        });
      }
      _ => {}
    }
  }
}

fn cell_span(cell: &NodeRef) -> usize {
  attr(cell, "colspan")
    .and_then(|s| s.trim().parse::<usize>().ok())
    .unwrap_or(1)
    .clamp(1, 50)
}

fn cell_text(cell: &NodeRef) -> String {
  let text = blocks(cell).join(" ");
  let text = text.replace('\n', " ").replace('|', "\\|");
  normalize_inline(&text)
}

fn has_nested_table(node: &NodeRef) -> bool {
  node
    .descendants()
    .skip(1)
    .any(|d| tag_of(&d) == Some("table"))
}

fn table(node: &NodeRef) -> String {
  let mut rows = Vec::new();
  let mut caption = None;
  collect_rows(node, false, &mut rows, &mut caption);
  if rows.is_empty() {
    return blocks(node).join("\n\n");
  }
  let columns = rows
    .iter()
    .map(|r| r.cells.iter().map(cell_span).sum::<usize>())
    .max()
    .unwrap_or(0);

  // One column, tables inside tables, or header-less tables holding whole
  // blocks of prose are page layout, not data.
  let has_header = rows.iter().any(|r| r.header)
    || rows
      .iter()
      .any(|r| r.cells.iter().any(|c| tag_of(c) == Some("th")));
  let presentational = matches!(
    attr(node, "role").as_deref(),
    Some("presentation") | Some("none")
  );
  let prose_cells = !has_header
    && rows.iter().any(|r| {
      r.cells.iter().any(|c| {
        c.descendants().skip(1).any(|d| {
          matches!(
            tag_of(&d),
            Some("p")
              | Some("ul")
              | Some("ol")
              | Some("pre")
              | Some("blockquote")
              | Some("h1")
              | Some("h2")
              | Some("h3")
              | Some("h4")
          )
        }) || c.text_contents().len() > 400
      })
    });
  if columns <= 1 || has_nested_table(node) || presentational || prose_cells {
    let mut parts = Vec::new();
    for row in &rows {
      for cell in &row.cells {
        let text = blocks(cell).join("\n\n");
        if !text.is_empty() {
          parts.push(text);
        }
      }
    }
    return parts.join("\n\n");
  }

  let render = |row: &Row| -> String {
    let mut line = String::from("|");
    let mut used = 0;
    for cell in &row.cells {
      let span = cell_span(cell);
      line.push(' ');
      line.push_str(&cell_text(cell));
      line.push_str(" |");
      for _ in 1..span {
        line.push_str(" |");
      }
      used += span;
    }
    for _ in used..columns {
      line.push_str(" |");
    }
    line
  };

  let mut out = String::new();
  if let Some(c) = caption {
    out.push_str(&format!("**{c}**\n\n"));
  }
  let mut body = rows.iter();
  match rows.first() {
    Some(first) if first.header => {
      out.push_str(&render(first));
      body.next();
    }
    _ => {
      out.push('|');
      for _ in 0..columns {
        out.push_str(" |");
      }
    }
  }
  out.push_str("\n|");
  for _ in 0..columns {
    out.push_str(" --- |");
  }
  for row in body {
    out.push('\n');
    out.push_str(&render(row));
  }
  out
}

fn render_block(node: &NodeRef, name: &str) -> String {
  match name {
    "h1" => heading(node, 1),
    "h2" => heading(node, 2),
    "h3" => heading(node, 3),
    "h4" => heading(node, 4),
    "h5" => heading(node, 5),
    "h6" => heading(node, 6),
    "pre" => code_block(node),
    "blockquote" => quote(node),
    "ul" => list(node, false),
    "ol" => list(node, true),
    "table" => table(node),
    "hr" => "---".to_string(),
    "summary" => {
      let text = normalize_inline(&inline_children(node)).replace('\n', " ");
      if text.is_empty() {
        String::new()
      } else {
        format!("**{text}**")
      }
    }
    _ => blocks(node).join("\n\n"),
  }
}

/// Render a container's children as a list of blocks.
fn blocks(parent: &NodeRef) -> Vec<String> {
  let mut out: Vec<String> = Vec::new();
  let mut run = String::new();
  let flush = |run: &mut String, out: &mut Vec<String>| {
    if !run.is_empty() {
      let paragraph = normalize_inline(run);
      if !paragraph.is_empty() {
        out.push(escape_line_starts(&paragraph));
      }
      run.clear();
    }
  };
  for child in parent.children() {
    if child.as_text().is_some() {
      inline(&child, &mut run);
      continue;
    }
    let Some(name) = tag_of(&child) else {
      if child.as_document().is_some() {
        flush(&mut run, &mut out);
        out.extend(blocks(&child));
      }
      continue;
    };
    if is_skipped(name) {
      continue;
    }
    if is_block(name) {
      flush(&mut run, &mut out);
      let rendered = render_block(&child, name);
      if !rendered.is_empty() {
        out.push(rendered);
      }
    } else if contains_block(&child) {
      // An inline or custom element (a link card, <turbo-frame>, <my-app>)
      // wrapping real blocks: keep the blocks instead of flattening them.
      flush(&mut run, &mut out);
      let inner = blocks(&child);
      if name == "a" && inner.len() == 1 && !inner[0].contains('\n') {
        let href = attr(&child, "href").unwrap_or_default();
        let href = href.trim();
        if !href.is_empty() && !href.starts_with('#') && !inner[0].contains("](") {
          let href = href
            .replace(' ', "%20")
            .replace('(', "%28")
            .replace(')', "%29");
          let (marks, text) = match inner[0].find(|c: char| c != '#' && c != ' ') {
            Some(i) if inner[0].starts_with('#') => inner[0].split_at(i),
            _ => ("", inner[0].as_str()),
          };
          out.push(format!("{marks}[{text}]({href})"));
          continue;
        }
      }
      out.extend(inner);
    } else {
      inline(&child, &mut run);
    }
  }
  flush(&mut run, &mut out);
  out
}

/// True when an element that is not itself a block has a block somewhere
/// inside it.
fn contains_block(node: &NodeRef) -> bool {
  node.children().any(|child| match tag_of(&child) {
    Some(name) if is_skipped(name) => false,
    Some(name) if is_block(name) => true,
    Some(_) => contains_block(&child),
    None => false,
  })
}

/// Collapse runs of blank lines and trailing spaces, leaving fenced code
/// untouched.
fn tidy(md: &str) -> String {
  let mut out = String::with_capacity(md.len());
  let mut blank_run = 0usize;
  let mut fence: Option<&str> = None;
  for line in md.lines() {
    let trimmed_start = line.trim_start();
    match fence {
      Some(open) => {
        if trimmed_start.starts_with(open) && trimmed_start.trim_end().len() == open.len() {
          fence = None;
        }
        out.push_str(line);
        out.push('\n');
        blank_run = 0;
        continue;
      }
      None => {
        if trimmed_start.starts_with("````") {
          fence = Some("````");
        } else if trimmed_start.starts_with("```") {
          fence = Some("```");
        }
        if fence.is_some() {
          out.push_str(line);
          out.push('\n');
          blank_run = 0;
          continue;
        }
      }
    }
    let line = line.trim_end();
    if line.is_empty() {
      blank_run += 1;
      if blank_run > 1 {
        continue;
      }
    } else {
      blank_run = 0;
    }
    out.push_str(line);
    out.push('\n');
  }
  out.trim().to_string()
}

pub fn html_to_markdown(html: &str) -> String {
  document_to_markdown(&parse_html().one(html))
}

/// Markdown for an already-parsed document.
pub fn document_to_markdown(document: &NodeRef) -> String {
  tidy(&blocks(document).join("\n\n"))
}

#[cfg(test)]
mod tests {
  use super::*;

  fn md(html: &str) -> String {
    html_to_markdown(html)
  }

  #[test]
  fn headings_paragraphs_inline() {
    let out = md("<h1>Title</h1><p>Hello <strong>bold</strong>, <em>em</em>, <code>x = 1</code> and <a href=\"https://x.dev/a\">a link</a>.</p><h2>Sub <a class=\"headerlink\" href=\"#sub\">¶</a></h2>");
    assert_eq!(
      out,
      "# Title\n\nHello **bold**, *em*, `x = 1` and [a link](https://x.dev/a).\n\n## Sub"
    );
  }

  #[test]
  fn bare_pre_is_fenced_with_language_from_wrapper() {
    let out = md("<div class=\"highlight-python3 notranslate\"><div class=\"highlight\"><pre><span></span><span class=\"c1\"># Expected output:</span>\n<span class=\"k\">def</span> main():\n    return 1\n</pre></div></div>");
    assert_eq!(
      out,
      "```python3\n# Expected output:\ndef main():\n    return 1\n```"
    );
  }

  #[test]
  fn pre_code_language_and_blank_lines_kept() {
    let out = md(
      "<pre><code class=\"language-rust\">fn main() {\n\n\n    println!(\"hi\");\n}\n</code></pre>",
    );
    assert_eq!(
      out,
      "```rust\nfn main() {\n\n\n    println!(\"hi\");\n}\n```"
    );
  }

  #[test]
  fn data_table_with_and_without_header() {
    let with = md("<table><thead><tr><th>Plan</th><th>Price</th></tr></thead><tbody><tr><td>Pro</td><td>$20 | month</td></tr></tbody></table>");
    assert_eq!(
      with,
      "| Plan | Price |\n| --- | --- |\n| Pro | $20 \\| month |"
    );
    let without = md("<table><tr><td>a</td><td>b</td></tr><tr><td>c</td><td>d</td></tr></table>");
    assert_eq!(without, "| | |\n| --- | --- |\n| a | b |\n| c | d |");
  }

  #[test]
  fn colspan_and_ragged_rows_stay_aligned() {
    let out = md("<table><tr><th>A</th><th>B</th><th>C</th></tr><tr><td colspan=\"2\">wide</td><td>x</td></tr><tr><td>only</td></tr></table>");
    assert_eq!(
      out,
      "| A | B | C |\n| --- | --- | --- |\n| wide | | x |\n| only | | |"
    );
  }

  #[test]
  fn layout_tables_are_unwrapped() {
    let out = md("<table><tr><td><p>First block.</p><p>Second block.</p></td></tr></table>");
    assert_eq!(out, "First block.\n\nSecond block.");
  }

  #[test]
  fn header_less_tables_with_prose_are_layout() {
    let out = md("<table><tr><td><img src=\"/s.gif\"></td><td><p>A long comment that is really a paragraph.</p><p>And another.</p></td></tr></table>");
    assert_eq!(
      out,
      "![](/s.gif)\n\nA long comment that is really a paragraph.\n\nAnd another."
    );
    let out = md("<table role=\"presentation\"><tr><td>a</td><td>b</td></tr></table>");
    assert_eq!(out, "a\n\nb");
  }

  #[test]
  fn custom_and_inline_wrappers_keep_their_blocks() {
    let out = md("<turbo-frame><span><h2>Why Rust?</h2><ul><li>Fast</li><li>Safe</li></ul><p>Text.</p></span></turbo-frame>");
    assert_eq!(out, "## Why Rust?\n\n- Fast\n- Safe\n\nText.");
    let out = md("<a href=\"/post\"><div><h3>Card title</h3></div></a><a href=\"/two\"><div><h3>Title</h3><p>Summary</p></div></a>");
    assert_eq!(out, "### [Card title](/post)\n\n### Title\n\nSummary");
  }

  #[test]
  fn nested_and_ordered_lists() {
    let out = md("<ul><li>one<ul><li>nested a</li><li>nested b</li></ul></li><li>two</li></ul><ol start=\"3\"><li>third</li><li>fourth</li></ol>");
    assert_eq!(
      out,
      "- one\n  - nested a\n  - nested b\n- two\n\n3. third\n4. fourth"
    );
  }

  #[test]
  fn list_item_with_paragraphs_and_code() {
    let out = md("<ol><li><p>Run it:</p><pre><code>npm start</code></pre></li><li>Done</li></ol>");
    assert_eq!(out, "1. Run it:\n\n   ```\n   npm start\n   ```\n2. Done");
  }

  #[test]
  fn blockquote_images_and_skipped_elements() {
    let out = md("<blockquote><p>Quoted</p><p>Twice</p></blockquote><p><img src=\"/a.png\" alt=\"An image\"><img src=\"data:image/png;base64,AAAA\" alt=\"inline\"></p><script>var x;</script><style>p{}</style>");
    assert_eq!(out, "> Quoted\n>\n> Twice\n\n![An image](/a.png)");
  }

  #[test]
  fn plain_text_that_looks_like_markdown_is_escaped() {
    let out =
      md("<p># not a heading</p><p>- not a list</p><p>1. not ordered</p><p>#hashtag stays</p>");
    assert_eq!(
      out,
      "\\# not a heading\n\n\\- not a list\n\n\\1. not ordered\n\n#hashtag stays"
    );
  }

  #[test]
  fn links_without_targets_and_with_spaces() {
    let out = md(
      "<p><a href=\"javascript:void(0)\">click</a> <a>bare</a> <a href=\"/a b(1)\">spaced</a></p>",
    );
    assert_eq!(out, "click bare [spaced](/a%20b%281%29)");
  }

  #[test]
  fn whitespace_and_breaks() {
    let out = md("<p>  many   spaces\n and\tnewlines <br> next line </p><div>inline <span>text</span> in a div</div>");
    assert_eq!(
      out,
      "many spaces and newlines\nnext line\n\ninline text in a div"
    );
  }

  #[test]
  fn tidy_keeps_code_blank_lines() {
    let out = tidy("a\n\n\n\nb\n```\nx\n\n\n\ny\n```\n");
    assert_eq!(out, "a\n\nb\n```\nx\n\n\n\ny\n```");
  }
}
