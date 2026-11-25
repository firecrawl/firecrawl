//! Property-based verification suite (`hegeltest`) for `firecrawl-markdown`.
//! Covers untrusted/deeply-nested HTML safety on a 2 MiB Tokio-sized stack,
//! code-block/inline-code backtick soundness, link preservation and dedup,
//! GFM table structural validity, and `post_process_markdown` idempotency.

#![allow(clippy::unwrap_used, clippy::expect_used, clippy::indexing_slicing)]

use std::sync::{Mutex, OnceLock, mpsc};

use firecrawl_markdown::{
  Base64ImageMode, IframeMode, MarkdownOptions, html_to_markdown, post_process_markdown,
};
use hegel::{TestCase, generators as gs};

type BoxedJob = Box<dyn FnOnce() + Send + 'static>;

fn run_on_2mb_stack<R: Send + 'static>(f: impl FnOnce() -> R + Send + 'static) -> R {
  static WORKER: OnceLock<Mutex<mpsc::Sender<BoxedJob>>> = OnceLock::new();
  let sender = WORKER.get_or_init(|| {
    let (tx, rx) = mpsc::channel::<BoxedJob>();
    std::thread::Builder::new()
      .name("md-2mb-stack-worker".to_string())
      .stack_size(2 * 1024 * 1024)
      .spawn(move || {
        while let Ok(job) = rx.recv() {
          job();
        }
      })
      .expect("failed to spawn 2 MiB worker thread");
    Mutex::new(tx)
  });

  let (res_tx, res_rx) = mpsc::sync_channel::<R>(1);
  let job: BoxedJob = Box::new(move || {
    let value = f();
    let _ = res_tx.send(value);
  });
  sender
    .lock()
    .expect("2 MiB worker lock poisoned")
    .send(job)
    .expect("2 MiB worker channel closed");
  res_rx.recv().expect("2 MiB worker panicked")
}

fn max_backtick_run(s: &str) -> usize {
  let mut best = 0usize;
  let mut cur = 0usize;
  for b in s.bytes() {
    if b == b'`' {
      cur = cur.saturating_add(1);
      best = best.max(cur);
    } else {
      cur = 0;
    }
  }
  best
}

fn count_unescaped_pipes(line: &str) -> usize {
  let mut count = 0usize;
  let mut escaped = false;
  for ch in line.chars() {
    if escaped {
      escaped = false;
      continue;
    }
    if ch == '\\' {
      escaped = true;
      continue;
    }
    if ch == '|' {
      count = count.saturating_add(1);
    }
  }
  count
}

fn is_valid_gfm_separator(line: &str) -> bool {
  let trimmed = line.trim();
  if !trimmed.starts_with('|') || !trimmed.ends_with('|') {
    return false;
  }
  let inner = &trimmed[1..trimmed.len().saturating_sub(1)];
  let cells: Vec<&str> = inner.split('|').collect();
  !cells.is_empty()
    && cells
      .iter()
      .all(|c| matches!(c.trim(), "---" | ":--" | ":-:" | "--:"))
}

fn escape_html_text(raw: &str) -> String {
  raw
    .replace('&', "&amp;")
    .replace('<', "&lt;")
    .replace('>', "&gt;")
    .replace('"', "&quot;")
}

const NEST_TAGS: &[(&str, &str)] = &[
  ("<div>", "</div>"),
  ("<span>", "</span>"),
  ("<blockquote>", "</blockquote>"),
  ("<ul><li>", "</li></ul>"),
  ("<table><tr><td>", "</td></tr></table>"),
  ("<a href=\"https://example.com\">", "</a>"),
  ("<strong><em>", "</em></strong>"),
  ("<pre><span>", "</span></pre>"),
];

#[test]
fn depth_6000_and_10000_never_overflow_2mb_stack() {
  let opts = MarkdownOptions::default();
  for &(open, close) in NEST_TAGS {
    let depths: &[usize] = if matches!(open, "<div>" | "<span>") {
      &[6_000, 10_000]
    } else {
      &[6_000]
    };
    for &depth in depths {
      let mut html = String::with_capacity(
        open
          .len()
          .saturating_add(close.len())
          .saturating_mul(depth)
          .saturating_add(32),
      );
      for _ in 0..depth {
        html.push_str(open);
      }
      html.push_str("<p>deep_payload</p>");
      for _ in 0..depth {
        html.push_str(close);
      }
      let opts_clone = opts.clone();
      let md = run_on_2mb_stack(move || html_to_markdown(&html, &opts_clone));
      assert!(
        md.contains("deep_payload"),
        "lost payload at depth {depth} for {open}"
      );
    }
  }
}

#[hegel::test]
fn prop_untrusted_html_never_panics_or_overflows_stack(tc: TestCase) {
  let kind = tc.draw(gs::integers::<u8>().min_value(0).max_value(2));
  let html = match kind {
    0 => tc.draw(gs::text().max_size(512)),
    1 => {
      let fragments = tc.draw(
        gs::vecs(gs::sampled_from(&[
          "<div>",
          "</div>",
          "<span>",
          "</span>",
          "<p>",
          "</p>",
          "<a href=\"https://x.test/a(1) b\">",
          "</a>",
          "<img src=\"data:image/png;base64,AAAA\" alt=\"[x]\">",
          "<pre><code class=\"language-rust\">```",
          "</code></pre>",
          "<table><caption><strong>Cap</strong></caption><tr><th>A</th><td>|</td></tr></table>",
          "<ul><li><input type=\"checkbox\" checked>x</li></ul>",
          "<iframe src=\"data:text/html,%3Cp%3Ehi%3C%2Fp%3E\"></iframe>",
          "<em><i>nested</i></em>",
          "<strong><b>bold</b></strong>",
          "<blockquote>",
          "</blockquote>",
          "<br>",
          "[Skip to Content](#main)",
          "\0\r\n",
        ]))
        .max_size(40),
      );
      fragments.concat()
    }
    _ => {
      let (open, close) = tc.draw(gs::sampled_from(NEST_TAGS));
      let depth = usize::from(tc.draw(gs::integers::<u16>().min_value(1).max_value(600)));
      let mut s = String::new();
      for _ in 0..depth {
        s.push_str(open);
      }
      s.push_str("leaf");
      for _ in 0..depth {
        s.push_str(close);
      }
      s
    }
  };

  let opts = MarkdownOptions {
    base64_images: tc.draw(gs::sampled_from(&[
      Base64ImageMode::Keep,
      Base64ImageMode::Placeholder,
      Base64ImageMode::Drop,
    ])),
    iframes: tc.draw(gs::sampled_from(&[IframeMode::Convert, IframeMode::Skip])),
    apply_post_process: tc.draw(gs::booleans()),
    ..MarkdownOptions::default()
  };

  let md = run_on_2mb_stack(move || html_to_markdown(&html, &opts));
  assert!(std::str::from_utf8(md.as_bytes()).is_ok());
}

#[hegel::test]
fn prop_code_fence_and_inline_backtick_soundness(tc: TestCase) {
  let run_a = usize::from(tc.draw(gs::integers::<u8>().min_value(0).max_value(12)));
  let run_b = usize::from(tc.draw(gs::integers::<u8>().min_value(0).max_value(12)));
  let ticks_a = "`".repeat(run_a);
  let ticks_b = "`".repeat(run_b);
  let line1 = format!("alpha{ticks_a}beta");
  let line2 = format!("gamma{ticks_b}delta");

  let pre_html = format!(
    "<pre><button class=\"copy-btn\" aria-label=\"Copy code\">COPYCHROME</button>\
     <table><tr><td class=\"gutter\">GUTTER999</td>\
     <td class=\"code\"><code class=\"language-rust\">\
     <div class=\"token-line\">{line1}</div>\
     <div class=\"token-line\">{line2}</div>\
     </code></td></tr></table></pre>"
  );
  let opts = MarkdownOptions::default();
  let md = html_to_markdown(&pre_html, &opts);

  assert!(!md.contains("GUTTER999"), "gutter leaked into {md:?}");
  assert!(!md.contains("COPYCHROME"), "copy button leaked into {md:?}");

  let lines: Vec<&str> = md.lines().collect();
  assert!(lines.len() >= 4, "expected fenced multiline block: {md:?}");
  let open = lines[0];
  let close = lines[lines.len().saturating_sub(1)];
  let open_ticks = open.bytes().take_while(|&b| b == b'`').count();
  let close_ticks = close.bytes().take_while(|&b| b == b'`').count();
  let body = lines[1..lines.len().saturating_sub(1)].join("\n");
  let expected_min = max_backtick_run(&body).saturating_add(1).max(3);
  assert_eq!(open_ticks, close_ticks, "mismatched fence lengths: {md:?}");
  assert!(
    open_ticks >= expected_min,
    "fence {open_ticks} too short for body max {expected_min}: {md:?}"
  );
  assert!(
    body.contains(&format!("{line1}\n{line2}")),
    "token-line divs smashed together: {body:?}"
  );

  let inline_body = format!("{ticks_a}x{ticks_b}");
  let inline_html = format!("<p><code>{inline_body}</code></p>");
  let inline_md = html_to_markdown(&inline_html, &opts);
  let lead_ticks = inline_md.bytes().take_while(|&b| b == b'`').count();
  let trail_ticks = inline_md.bytes().rev().take_while(|&b| b == b'`').count();
  assert_eq!(
    lead_ticks, trail_ticks,
    "unbalanced inline code: {inline_md:?}"
  );
  assert!(
    lead_ticks > max_backtick_run(&inline_body),
    "inline delimiter {lead_ticks} not strictly longer than content ticks in {inline_md:?}"
  );
}

#[hegel::test]
fn prop_link_url_preservation_and_dedup(tc: TestCase) {
  let slug = tc.draw(gs::integers::<u32>().min_value(1).max_value(99_999));
  let url = format!("https://example.com/item/{slug}");
  let opts = MarkdownOptions::default();

  let card_html = format!(
    "<a href=\"{url}\"><div><img src=\"https://cdn.example.com/t.png\" alt=\"Thumb\">\
     <h3>Card {slug}</h3><p>Summary line</p></div></a>"
  );
  let card_md = html_to_markdown(&card_html, &opts);
  assert!(
    card_md.contains(&url),
    "multi-block card dropped href {url}: {card_md:?}"
  );

  let icon_html =
    format!("<a href=\"{url}\" aria-label=\"Icon {slug}\"><svg><path d=\"M0 0\"/></svg></a>");
  let icon_md = html_to_markdown(&icon_html, &opts);
  assert!(
    icon_md.contains(&url) && icon_md.contains(&format!("Icon {slug}")),
    "aria-label icon link dropped: {icon_md:?}"
  );

  let dedup_html = format!("<a href=\"{url}\"><img src=\"{url}\" alt=\"Pic\"></a>");
  let dedup_md = html_to_markdown(&dedup_html, &opts);
  assert_eq!(dedup_md, format!("![Pic]({url})"));

  let js_html = "<p><a href=\"javascript:alert(1)\">Click</a></p>";
  let js_md = html_to_markdown(js_html, &opts);
  assert!(!js_md.contains("](javascript:"));
  assert_eq!(js_md, "Click");
}

#[hegel::test]
fn prop_gfm_table_structural_validity(tc: TestCase) {
  let cols = usize::from(tc.draw(gs::integers::<u8>().min_value(2).max_value(5)));
  let row_count = usize::from(tc.draw(gs::integers::<u8>().min_value(1).max_value(5)));
  let has_thead = tc.draw(gs::booleans());
  let bold_caption = tc.draw(gs::booleans());
  let presentational = tc.draw(gs::booleans());
  let aligns = [
    "",
    " align=\"left\"",
    " align=\"center\"",
    " align=\"right\"",
  ];

  let cap_token = format!("CapToken{}", tc.draw(gs::integers::<u16>()));
  let caption_html = if bold_caption {
    format!("<caption>Prefix <strong>{cap_token}</strong></caption>")
  } else {
    format!("<caption>{cap_token}</caption>")
  };

  let mut table_html = String::new();
  if presentational {
    table_html.push_str("<table role=\"presentation\">");
  } else {
    table_html.push_str("<table>");
  }
  table_html.push_str(&caption_html);

  if has_thead {
    table_html.push_str("<thead><tr>");
    for c in 0..cols {
      let a = tc.draw(gs::sampled_from(&aligns));
      table_html.push_str(&format!("<th{a}>H{c}</th>"));
    }
    table_html.push_str("</tr></thead>");
  }

  table_html.push_str("<tbody>");
  for r in 0..row_count {
    table_html.push_str("<tr>");
    let cell_count = usize::from(tc.draw(gs::integers::<u8>().min_value(1).max_value(cols as u8)));
    for c in 0..cell_count {
      let span = if c == 0 && cell_count == 1 && cols > 1 {
        2
      } else {
        1
      };
      let with_pipe = tc.draw(gs::booleans());
      let val = if with_pipe {
        format!("r{r}|c{c}")
      } else {
        format!("r{r}c{c}")
      };
      table_html.push_str(&format!(
        "<td colspan=\"{span}\">{}</td>",
        escape_html_text(&val)
      ));
    }
    table_html.push_str("</tr>");
  }
  table_html.push_str("</tbody></table>");

  let md = html_to_markdown(&table_html, &MarkdownOptions::default());
  assert!(md.contains(&cap_token), "caption dropped in {md:?}");
  assert!(
    !md.contains("****"),
    "double-bold caption corruption in {md:?}"
  );

  if !presentational {
    let table_lines: Vec<&str> = md.lines().filter(|l| l.starts_with('|')).collect();
    assert!(
      table_lines.len() >= 3,
      "expected header, separator, and body rows: {md:?}"
    );
    assert!(
      is_valid_gfm_separator(table_lines[1]),
      "invalid GFM separator {:?} in {md:?}",
      table_lines[1]
    );
    let expected_pipes = count_unescaped_pipes(table_lines[0]);
    for row in &table_lines {
      assert_eq!(
        count_unescaped_pipes(row),
        expected_pipes,
        "ragged column count on row {row:?} in {md:?}"
      );
    }
  }
}

#[hegel::test]
fn prop_post_process_idempotent_and_utf8_safe(tc: TestCase) {
  let parts = tc.draw(
    gs::vecs(gs::sampled_from(&[
      "[",
      "]",
      "\\",
      "\\\n",
      "\n",
      "[Skip to Content](#main)",
      "[skip to content](#top)",
      "(",
      ")",
      "#",
      "日本語",
      "🚀",
      "plain text",
      "a_b_c",
    ]))
    .max_size(32),
  );
  let extra = tc.draw(gs::text().max_size(64));
  let input = format!("{}{}", parts.concat(), extra);

  let once = post_process_markdown(&input);
  let twice = post_process_markdown(&once);
  assert_eq!(
    once, twice,
    "post_process_markdown not idempotent on {input:?}"
  );

  let pre_escaped = "[line1\\\nline2](https://example.com)";
  assert_eq!(post_process_markdown(pre_escaped), pre_escaped);
}
