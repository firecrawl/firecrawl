use crate::gfm_autolink::{AutolinkSegment, split_gfm_autolinks};
use crate::highlight_assemble::{Sentence, SentenceSource};
use crate::highlight_inline::{SentenceEmitter, split_sentences};
use crate::html_escape::{marked_escape_encode, marked_escape_no_encode};

/// Tracks inline tokens directly inside a list item, matching the legacy
/// `marked` walker where list-item inline tokens fall into the `default` branch
/// (allocating a fresh `block_id` per token and walking link children as plain
/// text without emitting `[text](href)`). Highlight models are trained on this
/// exact span layout.
pub(crate) struct ListInlineState {
  pending: String,
  link_depth: u32,
  image_buf: Option<String>,
}

impl ListInlineState {
  pub(crate) fn new() -> Self {
    Self {
      pending: String::new(),
      link_depth: 0,
      image_buf: None,
    }
  }

  pub(crate) fn flush(&mut self, out: &mut SentenceEmitter) {
    if self.pending.is_empty() {
      return;
    }
    let text = std::mem::take(&mut self.pending);
    if self.link_depth > 0 {
      let bid = out.alloc_block_id();
      out.push_sentences(&marked_escape_no_encode(&text), SentenceSource::Text, bid);
      return;
    }
    for seg in split_gfm_autolinks(&text) {
      match seg {
        AutolinkSegment::Text(t) => {
          let bid = out.alloc_block_id();
          out.push_sentences(&marked_escape_no_encode(t), SentenceSource::Text, bid);
        }
        AutolinkSegment::Link { text: lt, .. } => {
          let _link_bid = out.alloc_block_id();
          let text_bid = out.alloc_block_id();
          out.push_sentences(&marked_escape_no_encode(lt), SentenceSource::Text, text_bid);
        }
      }
    }
  }

  pub(crate) fn start_format(&mut self, out: &mut SentenceEmitter) {
    self.flush(out);
    let _bid = out.alloc_block_id();
  }

  pub(crate) fn end_format(&mut self, out: &mut SentenceEmitter) {
    self.flush(out);
  }

  pub(crate) fn start_link(&mut self, out: &mut SentenceEmitter) {
    self.flush(out);
    let _bid = out.alloc_block_id();
    self.link_depth = self.link_depth.saturating_add(1);
  }

  pub(crate) fn end_link(&mut self, out: &mut SentenceEmitter) {
    self.flush(out);
    self.link_depth = self.link_depth.saturating_sub(1);
  }

  pub(crate) fn start_image(&mut self, out: &mut SentenceEmitter) {
    self.flush(out);
    self.image_buf = Some(String::new());
  }

  pub(crate) fn end_image(&mut self, out: &mut SentenceEmitter) {
    if let Some(alt) = self.image_buf.take() {
      let bid = out.alloc_block_id();
      out.push_sentences(&marked_escape_no_encode(&alt), SentenceSource::Text, bid);
    }
  }

  pub(crate) fn push_text(
    &mut self,
    cow: &str,
    raw: &str,
    split: Option<(&str, &str)>,
    out: &mut SentenceEmitter,
  ) {
    if let Some(alt) = self.image_buf.as_mut() {
      alt.push_str(cow);
      return;
    }
    if let Some((esc, tail)) = split {
      self.flush(out);
      let bid = out.alloc_block_id();
      out.push_sentences(&marked_escape_no_encode(esc), SentenceSource::Text, bid);
      if !tail.is_empty() {
        self.pending.push_str(tail);
      }
    } else {
      self.pending.push_str(raw);
    }
  }

  pub(crate) fn push_code(&mut self, cow: &str, out: &mut SentenceEmitter) {
    if let Some(alt) = self.image_buf.as_mut() {
      alt.push_str(cow);
      return;
    }
    self.flush(out);
    let bid = out.alloc_block_id();
    out.push_sentences(&marked_escape_encode(cow), SentenceSource::Text, bid);
  }

  pub(crate) fn push_soft_break(&mut self) {
    if let Some(alt) = self.image_buf.as_mut() {
      alt.push('\n');
    } else {
      self.pending.push('\n');
    }
  }

  pub(crate) fn push_hard_break(&mut self, out: &mut SentenceEmitter) {
    self.flush(out);
    let _br_bid = out.alloc_block_id();
  }
}

pub(crate) fn push_sentences_into(
  sentences: &mut Vec<Sentence>,
  text: &str,
  source: SentenceSource,
  bid: u32,
) {
  for s in split_sentences(text) {
    sentences.push(Sentence {
      text: s,
      source,
      block_id: bid,
      lang: None,
      is_header: None,
    });
  }
}
