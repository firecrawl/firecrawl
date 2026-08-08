use std::collections::BTreeMap;

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct JsonOptions;
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct DeterministicJsonOptions;
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ChangeTrackingOptions;

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ScreenshotOptionsViewport {
  pub width: u32,  // 1-7680
  pub height: u32, // 1-4320
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ScreenshotOptions {
  pub full_page: bool,
  pub quality: Option<u8>, // 1-100
  pub viewport: Option<ScreenshotOptionsViewport>,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct AttributesOptions;
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct QuestionOptions;
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct HighlightsOptions;
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct QueryOptions;

#[derive(Debug, Clone, PartialEq, Eq, strum::EnumDiscriminants)]
#[strum_discriminants(
  name(FormatKind),
  derive(Hash, PartialOrd, Ord, strum::Display, strum::EnumIter)
)]
pub enum Format {
  Markdown,
  Html,
  RawHtml,
  Links,
  Images,
  Summary,
  Json(JsonOptions),
  DeterministicJson(DeterministicJsonOptions),
  ChangeTracking(ChangeTrackingOptions),
  Screenshot(ScreenshotOptions),
  Attributes(AttributesOptions),
  Branding,
  Product,
  Menu,
  Question(QuestionOptions),
  Highlights(HighlightsOptions),
  Query(QueryOptions),
  Audio,
  Video,
}

// TODO: serde trickery
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Formats(BTreeMap<FormatKind, Format>);

impl Formats {
  pub fn new() -> Self {
    Self(Default::default())
  }

  /// Returns the format this displaced, if any.
  pub fn insert(&mut self, format: Format) -> Option<Format> {
    self.0.insert(FormatKind::from(&format), format)
  }

  pub fn contains(&self, kind: FormatKind) -> bool {
    self.0.contains_key(&kind)
  }

  pub fn get(&self, kind: FormatKind) -> Option<&Format> {
    self.0.get(&kind)
  }

  pub fn remove(&mut self, kind: FormatKind) -> Option<Format> {
    self.0.remove(&kind)
  }

  pub fn iter(&self) -> impl Iterator<Item = &Format> {
    self.0.values()
  }

  pub fn kinds(&self) -> impl Iterator<Item = FormatKind> + '_ {
    self.0.keys().copied()
  }

  pub fn len(&self) -> usize {
    self.0.len()
  }

  pub fn is_empty(&self) -> bool {
    self.0.is_empty()
  }
}

impl FromIterator<Format> for Formats {
  fn from_iter<I: IntoIterator<Item = Format>>(iter: I) -> Self {
    Self(
      iter
        .into_iter()
        .map(|f| (FormatKind::from(&f), f))
        .collect(),
    )
  }
}

impl IntoIterator for Formats {
  type Item = Format;
  type IntoIter = std::collections::btree_map::IntoValues<FormatKind, Format>;

  fn into_iter(self) -> Self::IntoIter {
    self.0.into_values()
  }
}

macro_rules! format_options {
    ($($method:ident => $variant:ident($ty:ty)),* $(,)?) => {
        impl Formats {
            $(
                pub fn $method(&self) -> Option<&$ty> {
                    match self.get(FormatKind::$variant) {
                        Some(Format::$variant(opts)) => Some(opts),
                        _ => None,
                    }
                }
            )*
        }
    };
}

format_options! {
    json               => Json(JsonOptions),
    deterministic_json => DeterministicJson(DeterministicJsonOptions),
    change_tracking    => ChangeTracking(ChangeTrackingOptions),
    screenshot         => Screenshot(ScreenshotOptions),
    attributes         => Attributes(AttributesOptions),
    question           => Question(QuestionOptions),
    highlights         => Highlights(HighlightsOptions),
    query              => Query(QueryOptions),
}

impl Default for Formats {
  fn default() -> Self {
    let mut x = Self::new();
    x.insert(Format::Markdown);
    x
  }
}

// TODO: deal with format refines from zod
