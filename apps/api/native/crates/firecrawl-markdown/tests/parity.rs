//! Exact-output parity and regression tests for `firecrawl-markdown`.

#![allow(clippy::unwrap_used, clippy::expect_used, clippy::indexing_slicing)]

use firecrawl_markdown::{
  Base64ImageMode, IframeMode, MarkdownOptions, html_to_markdown, post_process_markdown,
};

fn md(html: &str) -> String {
  html_to_markdown(html, &MarkdownOptions::default())
}

#[test]
fn headings_paragraphs_inline_and_permalinks() {
  let out = md(
    "<h1>Title</h1><p>Hello <strong>bold</strong>, <em>em</em>, <code>x = 1</code> and \
     <a href=\"https://x.dev/a\">a link</a>.</p><h2>Sub <a class=\"headerlink\" href=\"#sub\">¶</a></h2>",
  );
  assert_eq!(
    out,
    "# Title\n\nHello **bold**, *em*, `x = 1` and [a link](https://x.dev/a).\n\n## Sub"
  );
}

#[test]
fn code_language_detection_and_ancestor_safety() {
  let sphinx = md(
    "<div class=\"highlight-python3 notranslate\"><div class=\"highlight\"><pre><span></span>\
     <span class=\"c1\"># Expected output:</span>\n<span class=\"k\">def</span> main():\n    return 1\n</pre></div></div>",
  );
  assert_eq!(
    sphinx,
    "```python3\n# Expected output:\ndef main():\n    return 1\n```"
  );

  let rust_code = md(
    "<pre><code class=\"language-rust\">fn main() {\n\n\n    println!(\"hi\");\n}\n</code></pre>",
  );
  assert_eq!(
    rust_code,
    "```rust\nfn main() {\n\n\n    println!(\"hi\");\n}\n```"
  );

  // Generic wrapper classes on ancestors must not become fake fence languages.
  let wrapper = md("<div class=\"highlight-wrapper\"><pre><code>plain</code></pre></div>");
  assert_eq!(wrapper, "```\nplain\n```");

  let switcher = md("<div class=\"lang-switcher\"><pre><code>plain</code></pre></div>");
  assert_eq!(switcher, "```\nplain\n```");
}

#[test]
fn pre_preserves_empty_block_blank_lines() {
  let out = md("<pre><div>a</div><div></div><div>b</div></pre>");
  assert_eq!(out, "```\na\n\nb\n```");
}

#[test]
fn tables_alignment_colspan_layout_and_wide_cap() {
  let with = md(
    "<table><thead><tr><th>Plan</th><th>Price</th></tr></thead>\
     <tbody><tr><td>Pro</td><td>$20 | month</td></tr></tbody></table>",
  );
  assert_eq!(
    with,
    "| Plan | Price |\n| --- | --- |\n| Pro | $20 \\| month |"
  );

  let without = md("<table><tr><td>a</td><td>b</td></tr><tr><td>c</td><td>d</td></tr></table>");
  assert_eq!(without, "| | |\n| --- | --- |\n| a | b |\n| c | d |");

  let spanned = md(
    "<table><tr><th>A</th><th>B</th><th>C</th></tr>\
     <tr><td colspan=\"2\">wide</td><td>x</td></tr><tr><td>only</td></tr></table>",
  );
  assert_eq!(
    spanned,
    "| A | B | C |\n| --- | --- | --- |\n| wide | | x |\n| only | | |"
  );

  let layout = md("<table><tr><td><p>First block.</p><p>Second block.</p></td></tr></table>");
  assert_eq!(layout, "First block.\n\nSecond block.");

  let prose = md(
    "<table><tr><td><img src=\"/s.gif\"></td>\
     <td><p>A long comment that is really a paragraph.</p><p>And another.</p></td></tr></table>",
  );
  assert_eq!(
    prose,
    "![](/s.gif)\n\nA long comment that is really a paragraph.\n\nAnd another."
  );

  let presentational = md("<table role=\"presentation\"><tr><td>a</td><td>b</td></tr></table>");
  assert_eq!(presentational, "a\n\nb");

  // Crafted over-wide table must unwrap linearly instead of padding every row.
  let mut wide = String::from("<table><tr><td colspan=\"50\">A</td><td colspan=\"50\">B</td></tr>");
  for _ in 0..200 {
    wide.push_str("<tr><td>x</td></tr>");
  }
  wide.push_str("</table>");
  let opts = MarkdownOptions {
    unwrap_layout_tables: false,
    ..MarkdownOptions::default()
  };
  let wide_md = html_to_markdown(&wide, &opts);
  assert!(!wide_md.contains("| --- |"));
  assert!(
    wide_md.len() < 4_000,
    "unexpected table amplification: {} bytes",
    wide_md.len()
  );
}

#[test]
fn card_links_and_trailing_backslash_heading() {
  let out = md("<a href=\"/post\"><div><h3>Card title</h3></div></a>");
  assert_eq!(out, "### [Card title](/post)");

  let multi = md("<a href=\"/two\"><div><h3>Title\\</h3><p>Summary</p></div></a>");
  assert_eq!(multi, "[**Title\\\\**\\\n\\\nSummary](/two)");
}

#[test]
fn lists_nested_ordered_and_code() {
  let out = md(
    "<ul><li>one<ul><li>nested a</li><li>nested b</li></ul></li><li>two</li></ul>\
     <ol start=\"3\"><li>third</li><li>fourth</li></ol>",
  );
  assert_eq!(
    out,
    "- one\n  - nested a\n  - nested b\n- two\n\n3. third\n4. fourth"
  );

  let with_code =
    md("<ol><li><p>Run it:</p><pre><code>npm start</code></pre></li><li>Done</li></ol>");
  assert_eq!(
    with_code,
    "1. Run it:\n\n   ```\n   npm start\n   ```\n2. Done"
  );
}

#[test]
fn escaping_setext_line_starts_and_javascript_uris() {
  let out = md(
    "<p># not a heading</p><p>- not a list</p><p>1. not ordered</p>\
     <p>#hashtag stays</p><p>title<br>--<br>===</p>",
  );
  assert_eq!(
    out,
    "\\# not a heading\n\n\\- not a list\n\n1\\. not ordered\n\n#hashtag stays\n\ntitle\n\\--\n\\==="
  );

  let uris = md(
    "<p><a href=\"javascript:void(0)\">click</a> <a href=\"java&#9;script:alert(1)\">tab</a> \
     <a href=\"java&#10;script:alert(1)\">nl</a> <a>bare</a> <a href=\"/a b(1)\">spaced</a></p>",
  );
  assert_eq!(uris, "click tab nl bare [spaced](/a%20b%281%29)");
}

#[test]
fn iframe_percent_decoding_base64_and_depth_budget() {
  let plus = md("<iframe src=\"data:text/html,<p>1+1</p>\"></iframe>");
  assert_eq!(plus, "1+1");

  // Base64 payload with percent-encoded `=` padding (`%3D`).
  let b64_pct = md("<iframe src=\"data:text/html;base64,PHA+aGk8L3A+%3D%3D\"></iframe>");
  assert_eq!(b64_pct, "hi");

  // Inner data:text/html inherits caller DOM depth budget.
  let nested = "<div><div><div><iframe src=\"data:text/html,<div><p>inner</p></div>\"></iframe></div></div></div>";
  let tight = MarkdownOptions {
    max_dom_depth: 3,
    ..MarkdownOptions::default()
  };
  let out = html_to_markdown(nested, &tight);
  assert!(
    !out.contains("inner"),
    "inner iframe exceeded depth budget: {out:?}"
  );
}

#[test]
fn depth_fallback_escapes_brackets() {
  let opts = MarkdownOptions {
    max_dom_depth: 2,
    ..MarkdownOptions::default()
  };
  let out = html_to_markdown(
    "<div><span><span>[x](javascript:alert(1))</span></span></div>",
    &opts,
  );
  assert_eq!(out, "\\[x\\](javascript:alert(1))");
}

#[test]
fn post_process_fences_tilde_and_linear_nested_skip_links() {
  // Unmatched `[` inside a fenced block must not inject backslashes after it.
  let with_code = "```js\nconst x = arr[\n  0\n];\n```\n\nLine 1\nLine 2";
  assert_eq!(post_process_markdown(with_code), with_code);

  let tilde = "~~~txt\n[\n\n\nline   \n~~~\n\nPara 1\nPara 2";
  assert_eq!(post_process_markdown(tilde), tilde);

  // A <pre> block keeps interior blank lines verbatim inside a backtick fence.
  let pre_tilde = md("<pre><code>a\n\n\nb</code></pre>");
  assert_eq!(pre_tilde, "```\na\n\n\nb\n```");

  // Deeply nested skip-to-content links resolve in linear time and stay idempotent.
  let depth = 5_000;
  let mut crafted = String::with_capacity(depth * 24);
  for _ in 0..depth {
    crafted.push_str("[Skip to Content](#");
  }
  crafted.push_str("payload");
  for _ in 0..depth {
    crafted.push(')');
  }
  crafted.push_str("kept");
  let once = post_process_markdown(&crafted);
  assert_eq!(once, "kept");
  assert_eq!(post_process_markdown(&once), once);
}

#[test]
fn base64_image_modes_and_iframe_skip() {
  let html = "<p><img src=\"data:image/png;base64,AAAA\" alt=\"pic\"></p>\
              <iframe src=\"https://example.com/embed\"></iframe>";

  let keep = html_to_markdown(html, &MarkdownOptions::default());
  assert_eq!(
    keep,
    "![pic](data:image/png;base64,AAAA)\n\n[iframe](https://example.com/embed)"
  );

  let placeholder = html_to_markdown(
    html,
    &MarkdownOptions {
      base64_images: Base64ImageMode::Placeholder,
      iframes: IframeMode::Skip,
      ..MarkdownOptions::default()
    },
  );
  assert_eq!(placeholder, "![pic](<Base64-Image-Removed>)");

  let drop_all = html_to_markdown(
    html,
    &MarkdownOptions {
      base64_images: Base64ImageMode::Drop,
      iframes: IframeMode::Skip,
      ..MarkdownOptions::default()
    },
  );
  assert_eq!(drop_all, "");
}

#[test]
fn card_link_preserves_fenced_code_and_lone_markers_escape() {
  let card = md(
    "<a href=\"https://example.com\"><div><h3>Card</h3><pre><code>  first\n\n# comment\n  second</code></pre></div></a>",
  );
  assert!(
    card.contains("**Card**"),
    "heading inside wrapper div card converts to bold: {card}"
  );
  assert!(
    !card.contains("**comment**"),
    "# comment inside fenced code in card must not turn into bold: {card}"
  );
  assert!(
    card.contains("  second"),
    "indentation inside fenced code in card must survive: {card}"
  );

  assert_eq!(md("<p>*</p>"), "\\*");
  assert_eq!(md("<p>+</p>"), "\\+");
  assert_eq!(md("<p>-</p>"), "\\-");
  assert_eq!(md("<p>***</p>"), "\\***");
  assert_eq!(md("<p>++</p>"), "++");
}
