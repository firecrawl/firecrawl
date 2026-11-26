use pulldown_cmark::{CodeBlockKind, Event, LinkType, Options, Parser, Tag, TagEnd};

use crate::highlight_assemble::{Sentence, SentenceSource};
use crate::highlight_inline::{ActiveMode, InlineCollector, SentenceEmitter, trim_js_ws};
use crate::highlight_list_inline::ListInlineState;

struct HighlightParser<'a> {
  src: &'a str,
  out: SentenceEmitter,
  mode: ActiveMode,
  table_bid: Option<u32>,
  table_row: Vec<String>,
  in_table_head: bool,
  list_context: Vec<bool>,
  last_text_end: usize,
}

impl<'a> HighlightParser<'a> {
  fn new(src: &'a str) -> Self {
    Self {
      src,
      out: SentenceEmitter::new(),
      mode: ActiveMode::None,
      table_bid: None,
      table_row: Vec::new(),
      in_table_head: false,
      list_context: Vec::new(),
      last_text_end: 0,
    }
  }

  fn in_direct_list_item(&self) -> bool {
    self.list_context.last().copied().unwrap_or(false)
  }

  fn split_leading_escape<'s>(
    &self,
    range: &std::ops::Range<usize>,
    raw: &'s str,
  ) -> Option<(&'s str, &'s str)> {
    let first = raw.as_bytes().first().copied()?;
    if first == b'\\'
      && raw.len() == 2
      && raw.as_bytes().get(1).is_some_and(u8::is_ascii_punctuation)
    {
      return Some((raw.get(1..2)?, ""));
    }
    if first.is_ascii_punctuation()
      && range.start > 0
      && self.last_text_end < range.start
      && self.src.as_bytes().get(range.start.saturating_sub(1)) == Some(&b'\\')
    {
      return Some((raw.get(..1)?, raw.get(1..)?));
    }
    None
  }

  fn close_list_inline(&mut self) {
    if let Some(st) = self.mode.list_mut() {
      st.flush(&mut self.out);
      self.mode = ActiveMode::None;
    }
  }

  fn start_list_inline(&mut self) {
    let _wrapper_bid = self.out.alloc_block_id();
    self.mode = ActiveMode::ListInline(ListInlineState::new());
  }

  fn ensure_list_inline(&mut self) {
    if matches!(self.mode, ActiveMode::None) && self.in_direct_list_item() {
      self.start_list_inline();
    }
  }

  fn handle_start(&mut self, tag: Tag<'a>) {
    match tag {
      Tag::Heading { .. } => {
        self.close_list_inline();
        let bid = self.out.alloc_block_id();
        self.mode = ActiveMode::Heading {
          bid,
          inline: InlineCollector::new(),
        };
      }
      Tag::Paragraph => {
        self.close_list_inline();
        if self.in_direct_list_item() {
          self.start_list_inline();
        } else {
          let bid = self.out.alloc_block_id();
          self.mode = ActiveMode::Paragraph {
            bid,
            inline: InlineCollector::new(),
          };
        }
      }
      Tag::Table(_) => {
        self.close_list_inline();
        self.table_bid = Some(self.out.alloc_block_id());
      }
      Tag::TableHead => {
        self.in_table_head = true;
        self.table_row.clear();
      }
      Tag::TableRow => {
        self.in_table_head = false;
        self.table_row.clear();
      }
      Tag::TableCell => self.mode = ActiveMode::TableCell(InlineCollector::new()),
      Tag::CodeBlock(kind) => {
        self.close_list_inline();
        let bid = self.out.alloc_block_id();
        let lang = match kind {
          CodeBlockKind::Fenced(info) => {
            let trimmed = trim_js_ws(&info);
            (!trimmed.is_empty()).then(|| trimmed.to_string())
          }
          CodeBlockKind::Indented => None,
        };
        self.mode = ActiveMode::CodeBlock {
          bid,
          lang,
          buf: String::new(),
        };
      }
      Tag::HtmlBlock => {
        self.close_list_inline();
        self.mode = ActiveMode::HtmlBlock;
      }
      Tag::BlockQuote(_) => {
        self.close_list_inline();
        self.list_context.push(false);
      }
      Tag::List(_) => self.close_list_inline(),
      Tag::Item => {
        self.close_list_inline();
        self.list_context.push(true);
      }
      Tag::Strong | Tag::Emphasis | Tag::Strikethrough => {
        self.ensure_list_inline();
        if let Some(inline) = self.mode.inline_mut() {
          inline.start_format();
        } else if let Some(st) = self.mode.list_mut() {
          st.start_format(&mut self.out);
        }
      }
      Tag::Link {
        link_type,
        dest_url,
        ..
      } => {
        self.ensure_list_inline();
        let href = if matches!(link_type, LinkType::Email) {
          format!("mailto:{dest_url}")
        } else {
          dest_url.to_string()
        };
        if let Some(inline) = self.mode.inline_mut() {
          inline.start_link(href);
        } else if let Some(st) = self.mode.list_mut() {
          st.start_link(&mut self.out);
        }
      }
      Tag::Image { .. } => {
        self.ensure_list_inline();
        if let Some(inline) = self.mode.inline_mut() {
          inline.start_image();
        } else if let Some(st) = self.mode.list_mut() {
          st.start_image(&mut self.out);
        }
      }
      _ => {}
    }
  }

  fn handle_end(&mut self, tag: TagEnd) {
    match tag {
      TagEnd::Heading(_) => {
        if let ActiveMode::Heading { bid, inline } =
          std::mem::replace(&mut self.mode, ActiveMode::None)
        {
          let text = inline.finish();
          let trimmed = trim_js_ws(&text);
          if !trimmed.is_empty() {
            self.out.sentences.push(Sentence {
              text: trimmed.to_string(),
              source: SentenceSource::Heading,
              block_id: bid,
              lang: None,
              is_header: None,
            });
          }
        }
      }
      TagEnd::Paragraph => {
        if self.in_direct_list_item() {
          self.close_list_inline();
        } else if let ActiveMode::Paragraph { bid, inline } =
          std::mem::replace(&mut self.mode, ActiveMode::None)
        {
          let text = inline.finish();
          self.out.push_sentences(&text, SentenceSource::Text, bid);
        }
      }
      TagEnd::TableCell => {
        if let ActiveMode::TableCell(inline) = std::mem::replace(&mut self.mode, ActiveMode::None) {
          let text = inline.finish();
          let trimmed = trim_js_ws(&text);
          if !trimmed.is_empty() {
            self.table_row.push(trimmed.to_string());
          }
        }
      }
      TagEnd::TableHead | TagEnd::TableRow => {
        if let Some(bid) = self.table_bid
          && !self.table_row.is_empty()
        {
          self.out.sentences.push(Sentence {
            text: self.table_row.join(" | "),
            source: SentenceSource::Table,
            block_id: bid,
            lang: None,
            is_header: self.in_table_head.then_some(true),
          });
        }
        self.table_row.clear();
      }
      TagEnd::Table => self.table_bid = None,
      TagEnd::CodeBlock => {
        if let ActiveMode::CodeBlock { bid, lang, buf } =
          std::mem::replace(&mut self.mode, ActiveMode::None)
        {
          for line in buf.split('\n') {
            let trimmed = trim_js_ws(line);
            if !trimmed.is_empty() {
              self.out.sentences.push(Sentence {
                text: trimmed.to_string(),
                source: SentenceSource::Code,
                block_id: bid,
                lang: lang.clone(),
                is_header: None,
              });
            }
          }
        }
      }
      TagEnd::HtmlBlock => self.mode = ActiveMode::None,
      TagEnd::BlockQuote(_) => {
        self.list_context.pop();
      }
      TagEnd::Item => {
        self.close_list_inline();
        self.list_context.pop();
      }
      TagEnd::Strong | TagEnd::Emphasis | TagEnd::Strikethrough => {
        if let Some(inline) = self.mode.inline_mut() {
          inline.end_format();
        } else if let Some(st) = self.mode.list_mut() {
          st.end_format(&mut self.out);
        }
      }
      TagEnd::Link => {
        if let Some(inline) = self.mode.inline_mut() {
          inline.end_link();
        } else if let Some(st) = self.mode.list_mut() {
          st.end_link(&mut self.out);
        }
      }
      TagEnd::Image => {
        if let Some(inline) = self.mode.inline_mut() {
          inline.end_image();
        } else if let Some(st) = self.mode.list_mut() {
          st.end_image(&mut self.out);
        }
      }
      _ => {}
    }
  }

  fn handle_event(&mut self, event: Event<'a>, range: std::ops::Range<usize>) {
    match event {
      Event::Start(tag) => self.handle_start(tag),
      Event::End(tag) => self.handle_end(tag),
      Event::Text(cow) => {
        if let ActiveMode::CodeBlock { buf, .. } = &mut self.mode {
          buf.push_str(&cow);
        } else {
          self.ensure_list_inline();
          let raw = self.src.get(range.clone()).unwrap_or(&cow);
          let split = self.split_leading_escape(&range, raw);
          if let Some(inline) = self.mode.inline_mut() {
            if let Some((esc, tail)) = split {
              inline.push_escaped(esc);
              inline.pending.push_str(tail);
            } else {
              inline.pending.push_str(raw);
            }
          } else if let Some(st) = self.mode.list_mut() {
            st.push_text(&cow, raw, split, &mut self.out);
          }
        }
        self.last_text_end = range.end;
      }
      Event::Code(cow) => {
        self.ensure_list_inline();
        if let Some(inline) = self.mode.inline_mut() {
          inline.push_code(&cow);
        } else if let Some(st) = self.mode.list_mut() {
          st.push_code(&cow, &mut self.out);
        }
        self.last_text_end = range.end;
      }
      Event::SoftBreak => {
        self.ensure_list_inline();
        if let Some(inline) = self.mode.inline_mut() {
          inline.push_char('\n');
        } else if let Some(st) = self.mode.list_mut() {
          st.push_soft_break();
        }
        self.last_text_end = range.end;
      }
      Event::HardBreak => {
        self.ensure_list_inline();
        if let Some(inline) = self.mode.inline_mut() {
          inline.push_char(' ');
        } else if let Some(st) = self.mode.list_mut() {
          st.push_hard_break(&mut self.out);
        }
        self.last_text_end = range.end;
      }
      Event::InlineHtml(_) => {
        if let Some(st) = self.mode.list_mut() {
          st.flush(&mut self.out);
        }
        self.last_text_end = range.end;
      }
      Event::Rule => self.close_list_inline(),
      _ => {}
    }
  }
}

/// Parse markdown into highlight sentences matching `parseMarkdownToSentences`.
#[must_use]
pub fn parse_markdown_to_sentences(markdown: &str) -> Vec<Sentence> {
  if markdown.is_empty() {
    return Vec::new();
  }
  let opts = Options::ENABLE_TABLES | Options::ENABLE_STRIKETHROUGH | Options::ENABLE_TASKLISTS;
  let mut state = HighlightParser::new(markdown);
  for (event, range) in Parser::new_ext(markdown, opts).into_offset_iter() {
    state.handle_event(event, range);
  }
  state.close_list_inline();
  state.out.sentences
}
