use std::collections::BTreeMap;

use super::{document::Document, engines::EngineScrapeResult, error::ScrapeURLError, meta::Meta};

mod document;
mod fallback;
mod pdf;

#[derive(Debug, Clone, PartialEq, Eq, strum::EnumDiscriminants)]
#[strum_discriminants(
  name(ParserKind),
  derive(Hash, PartialOrd, Ord, strum::Display, strum::EnumIter)
)]
pub enum Parser {
  Pdf(pdf::PdfOptions),
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Parsers(BTreeMap<ParserKind, Parser>);

impl Parsers {
  pub fn new() -> Self {
    Self(Default::default())
  }

  /// Returns the format this displaced, if any.
  pub fn insert(&mut self, parser: Parser) -> Option<Parser> {
    self.0.insert(ParserKind::from(&parser), parser)
  }

  pub fn contains(&self, kind: ParserKind) -> bool {
    self.0.contains_key(&kind)
  }

  pub fn get(&self, kind: ParserKind) -> Option<&Parser> {
    self.0.get(&kind)
  }

  pub fn remove(&mut self, kind: ParserKind) -> Option<Parser> {
    self.0.remove(&kind)
  }

  pub fn iter(&self) -> impl Iterator<Item = &Parser> {
    self.0.values()
  }

  pub fn kinds(&self) -> impl Iterator<Item = ParserKind> + '_ {
    self.0.keys().copied()
  }

  pub fn len(&self) -> usize {
    self.0.len()
  }

  pub fn is_empty(&self) -> bool {
    self.0.is_empty()
  }
}

impl FromIterator<Parser> for Parsers {
  fn from_iter<I: IntoIterator<Item = Parser>>(iter: I) -> Self {
    Self(
      iter
        .into_iter()
        .map(|f| (ParserKind::from(&f), f))
        .collect(),
    )
  }
}

impl IntoIterator for Parsers {
  type Item = Parser;
  type IntoIter = std::collections::btree_map::IntoValues<ParserKind, Parser>;

  fn into_iter(self) -> Self::IntoIter {
    self.0.into_values()
  }
}

macro_rules! parser_options {
    ($($method:ident => $variant:ident($ty:ty)),* $(,)?) => {
        impl Parsers {
            $(
                pub fn $method(&self) -> Option<&$ty> {
                    match self.get(ParserKind::$variant) {
                        Some(Parser::$variant(opts)) => Some(opts),
                        _ => None,
                    }
                }
            )*
        }
    };
}

parser_options! {
  pdf => Pdf(pdf::PdfOptions),
}

impl Default for Parsers {
  fn default() -> Self {
    let mut x = Self::new();
    x.insert(Parser::Pdf(Default::default()));
    x
  }
}

pub async fn parse_engine_result(
  meta: &Meta,
  result: EngineScrapeResult,
) -> Result<Document, ScrapeURLError> {
  if pdf::has_pdf_signal(&result) {
    pdf::parse_pdf(meta, result).await
  } else if document::has_document_signal(&result) {
    document::parse_document(meta, result)
  } else {
    fallback::parse_fallback(meta, result)
  }
}
