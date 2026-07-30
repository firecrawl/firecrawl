use chrono::{DateTime, Utc};
use std::num::NonZeroU32;

#[derive(Debug, Clone)]
pub struct Document {
  pub blocks: Vec<Block>,
  pub metadata: DocumentMetadata,
  pub notes: Vec<Note>,
  pub comments: Vec<Comment>,
}

#[derive(Debug, Clone, Default)]
pub struct DocumentMetadata {
  pub title: Option<String>,
  pub author: Option<String>,
  pub created: Option<DateTime<Utc>>,
}

#[derive(Debug, Clone, PartialEq, Eq, Hash)]
pub struct NoteId(pub String);

#[derive(Debug, Clone, PartialEq, Eq, Hash)]
pub struct CommentId(pub String);

#[derive(Debug, Clone, PartialEq, Eq, Hash)]
pub struct BookmarkId(pub String);

#[derive(Debug, Clone)]
pub enum Block {
  Paragraph(Paragraph),
  Table(Table),
  List(List),
  Image(Image),
}

#[derive(Debug, Clone)]
pub struct Paragraph {
  pub kind: ParagraphKind,
  pub inlines: Vec<Inline>,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum ParagraphKind {
  Normal,
  Heading(u8), // 1..=6 will render as <h1>.. <h6>
  Blockquote,
}

#[derive(Debug, Clone)]
pub enum Inline {
  Text(String),
  LineBreak,
  Link { href: String, children: Vec<Inline> },

  Strong(Vec<Inline>),
  Em(Vec<Inline>),
  Del(Vec<Inline>),
  Code(String),
  Sup(Vec<Inline>),
  Sub(Vec<Inline>),

  FootnoteRef(NoteId),
  EndnoteRef(NoteId),
  CommentRef(CommentId),
  Bookmark(BookmarkId),
}

/// True when the inlines would render something the reader can see.
pub fn has_visible_content(inlines: &[Inline]) -> bool {
  inlines.iter().any(|inline| match inline {
    Inline::Text(t) => !t.trim().is_empty(),
    Inline::LineBreak => false,
    Inline::Link { children, .. } => has_visible_content(children),
    Inline::Strong(c) | Inline::Em(c) | Inline::Del(c) | Inline::Sup(c) | Inline::Sub(c) => {
      has_visible_content(c)
    }
    Inline::Code(t) => !t.trim().is_empty(),
    Inline::FootnoteRef(_) | Inline::EndnoteRef(_) | Inline::CommentRef(_) => true,
    Inline::Bookmark(_) => false,
  })
}

#[derive(Debug, Clone)]
pub struct Image {
  pub src: String,
  pub alt: Option<String>,
}

#[derive(Debug, Clone)]
pub struct Table {
  pub rows: Vec<TableRow>,
}

#[derive(Debug, Clone)]
pub struct TableRow {
  pub cells: Vec<TableCell>,
  pub kind: TableRowKind,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum TableRowKind {
  Header,
  Body,
  Footer,
}

#[derive(Debug, Clone)]
pub struct TableCell {
  pub blocks: Vec<Block>,
  pub colspan: NonZeroU32,
  pub rowspan: NonZeroU32,
}

#[derive(Debug, Clone)]
pub struct List {
  pub items: Vec<ListItem>,
  pub list_type: ListType,
}

#[derive(Debug, Clone)]
pub struct ListItem {
  pub blocks: Vec<Block>,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum ListType {
  Ordered,
  Unordered,
}

#[derive(Debug, Clone)]
pub struct Note {
  pub id: NoteId,
  pub kind: NoteKind,
  pub blocks: Vec<Block>,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum NoteKind {
  Footnote,
  Endnote,
}

#[derive(Debug, Clone)]
pub struct Comment {
  pub id: CommentId,
  pub author_name: Option<String>,
  pub author_initials: Option<String>,
  pub blocks: Vec<Block>,
}
