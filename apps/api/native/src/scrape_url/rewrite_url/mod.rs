use url::Url;

use self::google_doc::GoogleDocLink;

mod google_doc;

#[allow(clippy::manual_map)] // implemented in this fashion to allow easy extendability, remove this #[allow] when more elseif cases are added
pub fn rewrite_url(url: &Url) -> Option<Url> {
  if let Some(doc) = GoogleDocLink::new(url.as_str()) {
    // convert human-friendly google docs/spreadsheets/slides/drive links into scrapeable ones
    Some(doc.scrape_url())
  } else {
    None
  }
}
