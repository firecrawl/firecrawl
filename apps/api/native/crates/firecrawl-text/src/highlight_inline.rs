use crate::gfm_autolink::{AutolinkSegment, split_gfm_autolinks};
use crate::highlight_assemble::{Sentence, SentenceSource};
use crate::highlight_list_inline::{ListInlineState, push_sentences_into};
use crate::html_entities::decode_html_entities;
use crate::html_escape::{marked_escape_encode, marked_escape_no_encode};

pub(crate) fn is_js_ws(c: char) -> bool {
  c.is_whitespace() || c == '\u{FEFF}'
}

pub(crate) fn trim_js_ws(s: &str) -> &str {
  s.trim_matches(is_js_ws)
}

pub(crate) struct SentenceEmitter {
  pub(crate) sentences: Vec<Sentence>,
  next_block_id: u32,
}

impl SentenceEmitter {
  pub(crate) fn new() -> Self {
    Self {
      sentences: Vec::new(),
      next_block_id: 0,
    }
  }

  pub(crate) fn alloc_block_id(&mut self) -> u32 {
    let bid = self.next_block_id;
    self.next_block_id = self.next_block_id.saturating_add(1);
    bid
  }

  pub(crate) fn push_sentences(&mut self, text: &str, source: SentenceSource, bid: u32) {
    push_sentences_into(&mut self.sentences, text, source, bid);
  }
}

/// Split a single block string into sentences with the same whitespace
/// normalization and `/(?<=[.!?])\s+/` split rule as `splitSentences` in
/// TypeScript.
pub(crate) fn split_sentences(text: &str) -> Vec<String> {
  let mut normalized = String::with_capacity(text.len());
  let mut in_ws = false;
  for ch in text.chars() {
    if is_js_ws(ch) {
      if !normalized.is_empty() && !in_ws {
        normalized.push(' ');
      }
      in_ws = true;
    } else {
      normalized.push(ch);
      in_ws = false;
    }
  }
  if normalized.ends_with(' ') {
    normalized.pop();
  }
  if normalized.is_empty() {
    return Vec::new();
  }

  let bytes = normalized.as_bytes();
  let mut out = Vec::new();
  let mut start = 0usize;

  for i in 0..bytes.len() {
    if matches!(bytes.get(i), Some(b'.' | b'!' | b'?'))
      && bytes.get(i.saturating_add(1)) == Some(&b' ')
    {
      let end = i.saturating_add(1);
      if let Some(chunk) = normalized.get(start..end) {
        let trimmed = trim_js_ws(chunk);
        if !trimmed.is_empty() {
          out.push(trimmed.to_string());
        }
      }
      start = end.saturating_add(1);
    }
  }

  if let Some(tail) = normalized.get(start..) {
    let trimmed = trim_js_ws(tail);
    if !trimmed.is_empty() {
      out.push(trimmed.to_string());
    }
  }
  out
}

pub(crate) enum ActiveMode {
  None,
  Heading {
    bid: u32,
    inline: InlineCollector,
  },
  Paragraph {
    bid: u32,
    inline: InlineCollector,
  },
  TableCell(InlineCollector),
  ListInline(ListInlineState),
  CodeBlock {
    bid: u32,
    lang: Option<String>,
    buf: String,
  },
  HtmlBlock,
}

impl ActiveMode {
  pub(crate) fn inline_mut(&mut self) -> Option<&mut InlineCollector> {
    match self {
      Self::Heading { inline, .. } | Self::Paragraph { inline, .. } | Self::TableCell(inline) => {
        Some(inline)
      }
      _ => None,
    }
  }

  pub(crate) fn list_mut(&mut self) -> Option<&mut ListInlineState> {
    match self {
      Self::ListInline(state) => Some(state),
      _ => None,
    }
  }
}

pub(crate) fn is_cite_note_link(text: &str, href: &str) -> bool {
  if !href.contains("cite_note") {
    return false;
  }
  let inner = text
    .strip_prefix('[')
    .unwrap_or(text)
    .strip_suffix(']')
    .unwrap_or(text);
  let bytes = inner.as_bytes();
  !bytes.is_empty()
    && bytes.len() <= 3
    && bytes
      .iter()
      .all(|&b| b.is_ascii_alphanumeric() || b == b'_')
}

enum InlineFrame {
  Root(String),
  Format(String),
  Link { href: String, buf: String },
  Image(String),
}

impl InlineFrame {
  fn buf_mut(&mut self) -> &mut String {
    match self {
      Self::Root(b) | Self::Format(b) | Self::Link { buf: b, .. } | Self::Image(b) => b,
    }
  }
}

pub(crate) struct InlineCollector {
  frames: Vec<InlineFrame>,
  pub(crate) pending: String,
  link_depth: u32,
  image_depth: u32,
}

impl InlineCollector {
  pub(crate) fn new() -> Self {
    Self {
      frames: vec![InlineFrame::Root(String::new())],
      pending: String::new(),
      link_depth: 0,
      image_depth: 0,
    }
  }

  fn flush_pending(&mut self) {
    if self.pending.is_empty() {
      return;
    }
    let text = std::mem::take(&mut self.pending);
    let Some(frame) = self.frames.last_mut() else {
      return;
    };
    let buf = frame.buf_mut();
    if self.image_depth > 0 {
      buf.push_str(&text);
    } else if self.link_depth > 0 {
      buf.push_str(&marked_escape_no_encode(&text));
    } else {
      for seg in split_gfm_autolinks(&text) {
        match seg {
          AutolinkSegment::Text(t) => buf.push_str(&marked_escape_no_encode(t)),
          AutolinkSegment::Link { text: lt, href } => {
            buf.push('[');
            buf.push_str(&marked_escape_no_encode(lt));
            buf.push_str("](");
            buf.push_str(&href);
            buf.push(')');
          }
        }
      }
    }
  }

  pub(crate) fn push_escaped(&mut self, ch_text: &str) {
    self.flush_pending();
    if let Some(frame) = self.frames.last_mut() {
      if self.image_depth > 0 {
        frame.buf_mut().push_str(ch_text);
      } else {
        frame.buf_mut().push_str(&marked_escape_no_encode(ch_text));
      }
    }
  }

  pub(crate) fn push_code(&mut self, code: &str) {
    self.flush_pending();
    if let Some(frame) = self.frames.last_mut() {
      if self.image_depth > 0 {
        frame.buf_mut().push_str(code);
      } else {
        frame.buf_mut().push_str(&marked_escape_encode(code));
      }
    }
  }

  pub(crate) fn push_char(&mut self, ch: char) {
    self.flush_pending();
    if let Some(frame) = self.frames.last_mut() {
      frame.buf_mut().push(ch);
    }
  }

  pub(crate) fn start_format(&mut self) {
    self.flush_pending();
    self.frames.push(InlineFrame::Format(String::new()));
  }

  pub(crate) fn end_format(&mut self) {
    self.flush_pending();
    if let Some(InlineFrame::Format(inner)) = self.frames.pop()
      && let Some(parent) = self.frames.last_mut()
    {
      parent.buf_mut().push_str(&decode_html_entities(&inner));
    }
  }

  pub(crate) fn start_link(&mut self, href: String) {
    self.flush_pending();
    self.link_depth = self.link_depth.saturating_add(1);
    self.frames.push(InlineFrame::Link {
      href,
      buf: String::new(),
    });
  }

  pub(crate) fn end_link(&mut self) {
    self.flush_pending();
    self.link_depth = self.link_depth.saturating_sub(1);
    if let Some(InlineFrame::Link { href, buf }) = self.frames.pop() {
      let link_text = decode_html_entities(&buf);
      if !is_cite_note_link(&link_text, &href)
        && let Some(parent) = self.frames.last_mut()
      {
        let out = parent.buf_mut();
        out.push('[');
        out.push_str(&link_text);
        out.push_str("](");
        out.push_str(&href);
        out.push(')');
      }
    }
  }

  pub(crate) fn start_image(&mut self) {
    self.flush_pending();
    self.image_depth = self.image_depth.saturating_add(1);
    self.frames.push(InlineFrame::Image(String::new()));
  }

  pub(crate) fn end_image(&mut self) {
    self.flush_pending();
    self.image_depth = self.image_depth.saturating_sub(1);
    if let Some(InlineFrame::Image(alt)) = self.frames.pop()
      && let Some(parent) = self.frames.last_mut()
    {
      parent.buf_mut().push_str(&marked_escape_no_encode(&alt));
    }
  }

  pub(crate) fn finish(mut self) -> String {
    self.flush_pending();
    match self.frames.pop() {
      Some(InlineFrame::Root(raw)) => decode_html_entities(&raw).into_owned(),
      _ => String::new(),
    }
  }
}
