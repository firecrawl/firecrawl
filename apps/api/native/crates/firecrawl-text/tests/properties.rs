use std::collections::BTreeMap;

use firecrawl_text::{
  assemble_answer, find_strict_schema_violation, normalize_schema_keywords,
  parse_markdown_to_sentences, rank_cosine_similarity, rank_cosine_similarity_indices,
  to_root_schema,
};
use hegel::{TestCase, generators as gs};
use serde_json::{Map, Number, Value};

const MARKDOWN_FRAGMENTS: &[&str] = &[
  "# Heading\n\n",
  "## Sub *heading* &amp; [link](https://example.com)\n\n",
  "First sentence. Second! Third?\n\n",
  "- Item one\n- **Bold** and [docs](https://a.com).\n\n",
  "> Quoted text. More quote.\n\n",
  "```rust\nfn main() {}\n```\n\n",
  "| Size | Price |\n| --- | --- |\n| 128GB | $799 |\n| 256GB | $899 |\n\n",
  "Text [[1]](#cite_note-1) with `a < b & c` and &copy; &mdash; &#128;.\n\n",
  "<div>raw html</div>\n\n---\n\n",
  "Visit https://example.com and user@example.com.\n\n",
];

const SCHEMA_KEYS: &[&str] = &[
  "type",
  "properties",
  "items",
  "anyOf",
  "oneOf",
  "allOf",
  "not",
  "required",
  "additionalProperties",
  "$defs",
  "definitions",
  "$ref",
  "$schema",
  "title",
  "description",
  "enum",
  "const",
  "name",
  "price",
];

const TYPE_STRINGS: &[&str] = &[
  "object", "Object", "array", "Array", "string", "String", "number", "integer", "boolean", "null",
  "enum", "invalid", "",
];

#[hegel::composite]
fn markdown_input(tc: &TestCase) -> String {
  if tc.draw(gs::weighted_booleans(0.35)) {
    return tc.draw(gs::text().max_size(256));
  }
  let count = tc.draw(gs::integers::<usize>().min_value(0).max_value(8));
  let mut out = String::new();
  for _ in 0..count {
    if tc.draw(gs::weighted_booleans(0.7)) {
      out.push_str(tc.draw(gs::sampled_from(MARKDOWN_FRAGMENTS)));
    } else {
      out.push_str(&tc.draw(gs::text().max_size(48)));
    }
  }
  out
}

fn draw_json_value(tc: &TestCase, depth: usize) -> Value {
  if depth == 0 {
    return match tc.draw(gs::integers::<u8>().min_value(0).max_value(4)) {
      0 => Value::Null,
      1 => Value::Bool(tc.draw(gs::booleans())),
      2 => Value::Number(Number::from(
        tc.draw(gs::integers::<i64>().min_value(-1000).max_value(1000)),
      )),
      3 => Value::String(tc.draw(gs::sampled_from(TYPE_STRINGS)).to_owned()),
      _ => Value::String(tc.draw(gs::text().max_size(24))),
    };
  }

  let next_depth = depth.saturating_sub(1);
  match tc.draw(gs::integers::<u8>().min_value(0).max_value(5)) {
    0 => Value::Null,
    1 => Value::Bool(tc.draw(gs::booleans())),
    2 => Value::Number(Number::from(
      tc.draw(gs::integers::<i64>().min_value(-1000).max_value(1000)),
    )),
    3 => Value::String(tc.draw(gs::sampled_from(TYPE_STRINGS)).to_owned()),
    4 => {
      let len = tc.draw(gs::integers::<usize>().min_value(0).max_value(4));
      let mut arr = Vec::with_capacity(len);
      for _ in 0..len {
        arr.push(draw_json_value(tc, next_depth));
      }
      Value::Array(arr)
    }
    _ => {
      let len = tc.draw(gs::integers::<usize>().min_value(0).max_value(5));
      let mut map = Map::new();
      for _ in 0..len {
        let key = if tc.draw(gs::weighted_booleans(0.8)) {
          tc.draw(gs::sampled_from(SCHEMA_KEYS)).to_owned()
        } else {
          tc.draw(gs::text().max_size(16))
        };
        let val = draw_json_value(tc, next_depth);
        map.insert(key, val);
      }
      Value::Object(map)
    }
  }
}

#[hegel::test]
fn cosine_ranking_never_panics_and_preserves_multiset(tc: TestCase) {
  let links = tc.draw(gs::vecs(gs::text().max_size(64)).max_size(24));
  let query = tc.draw(gs::text().max_size(48));

  let indices = rank_cosine_similarity_indices(&links, &query);
  assert_eq!(indices.len(), links.len());

  let mut sorted_indices = indices.clone();
  sorted_indices.sort_unstable();
  let expected_indices: Vec<u32> = (0..links.len())
    .map(|i| u32::try_from(i).unwrap_or(u32::MAX))
    .collect();
  assert_eq!(sorted_indices, expected_indices);

  let ranked = rank_cosine_similarity(&links, &query);
  assert_eq!(ranked.len(), links.len());

  let mut before: BTreeMap<&str, usize> = BTreeMap::new();
  for link in &links {
    let entry = before.entry(link.as_str()).or_insert(0);
    *entry = entry.saturating_add(1);
  }
  let mut after: BTreeMap<&str, usize> = BTreeMap::new();
  for link in &ranked {
    let entry = after.entry(link.as_str()).or_insert(0);
    *entry = entry.saturating_add(1);
  }
  assert_eq!(before, after);
}

#[hegel::test]
fn highlight_spans_and_assemble_never_panic_on_arbitrary_markdown(tc: TestCase) {
  let md = tc.draw(markdown_input());
  let spans = parse_markdown_to_sentences(&md);
  let indices = tc.draw(gs::vecs(gs::integers::<i32>().min_value(-4).max_value(64)).max_size(24));
  let assembled = assemble_answer(&spans, &indices);

  let all_valid: Vec<i32> = (0..spans.len())
    .filter_map(|i| i32::try_from(i).ok())
    .collect();
  let _ = assemble_answer(&spans, &all_valid);

  if spans.is_empty() || indices.is_empty() {
    assert!(assembled.is_empty());
  }
}

#[hegel::test]
fn strict_schema_never_panics_or_mutates_input(tc: TestCase) {
  let depth = tc.draw(gs::integers::<usize>().min_value(0).max_value(5));
  let schema = draw_json_value(&tc, depth);
  let snapshot = schema.clone();

  let normalized = normalize_schema_keywords(&schema);
  assert_eq!(schema, snapshot);

  // Normalization converges in at most two passes (a typeless root with both
  // `properties` and an object `additionalProperties` rewrites the latter to
  // `false` on pass 1 and then infers `type: "object"` on pass 2).
  let second = normalize_schema_keywords(&normalized);
  assert_eq!(normalize_schema_keywords(&second), second);

  let root = to_root_schema(&schema);
  assert_eq!(schema, snapshot);

  let _ = find_strict_schema_violation(&schema);
  let _ = find_strict_schema_violation(&root);
}

#[test]
fn deeply_nested_schema_does_not_stack_overflow() {
  let mut schema = Value::Object({
    let mut leaf = Map::new();
    leaf.insert("type".to_owned(), Value::String("String".to_owned()));
    leaf
  });
  for _ in 0..500 {
    let mut props = Map::new();
    props.insert("child".to_owned(), schema);
    let mut node = Map::new();
    node.insert("type".to_owned(), Value::String("Object".to_owned()));
    node.insert("properties".to_owned(), Value::Object(props));
    schema = Value::Object(node);
  }

  let normalized = normalize_schema_keywords(&schema);
  assert_eq!(find_strict_schema_violation(&normalized), None);
}

#[test]
fn highlight_edge_cases_match_js_semantics() {
  // Multi-byte UTF-8 at byte 8 must not break `www.` GFM autolinking.
  let utf8_url = parse_markdown_to_sentences("Visit www.caf\u{00e9}.com today.");
  assert_eq!(
    utf8_url.first().map(|s| s.text.as_str()),
    Some("Visit [www.caf\u{00e9}.com](http://www.caf\u{00e9}.com) today.")
  );

  // Opening-only bracket citation label `[1` matches `/^\[?\w{1,3}\]?$/`.
  let cite = parse_markdown_to_sentences("Fact [\\[1](#cite_note-1) end.");
  assert_eq!(cite.first().map(|s| s.text.as_str()), Some("Fact end."));

  // U+0085 (NEL) is not whitespace in JavaScript `\s` / `trim()`.
  let nel = parse_markdown_to_sentences("a\u{0085}b");
  assert_eq!(nel.first().map(|s| s.text.as_str()), Some("a\u{0085}b"));

  // Link href already decoded once by pulldown-cmark must not be double-decoded.
  let href_amp = parse_markdown_to_sentences("[link](https://example.com?a=1&amp;amp;b=2)");
  assert_eq!(
    href_amp.first().map(|s| s.text.as_str()),
    Some("[link](https://example.com?a=1&amp;b=2)")
  );
}
