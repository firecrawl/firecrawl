use nom::{
  branch::alt,
  bytes::complete::{tag, take_till, take_while1},
  character::complete::{char, one_of},
  combinator::{map, not},
  multi::many0,
  sequence::preceded,
  IResult, Parser,
};
use url::Url;
use url_macro::url;

pub enum GoogleDocLink {
  Document { id: String },
  Presentation { id: String },
  Spreadsheets { id: String, gid: Option<String> },
  File { id: String },
}

impl GoogleDocLink {
  pub fn new(url: &str) -> Option<Self> {
    link(url).ok().map(|(_, link)| link)
  }

  pub fn scrape_url(&self) -> Url {
    match self {
      Self::Document { id } => {
        let mut x: Url = url!("https://docs.google.com/document/d/");
        x.path_segments_mut().unwrap().push(id).push("export");
        x.query_pairs_mut().append_pair("format", "html");
        x
      }
      Self::Presentation { id } => {
        let mut x: Url = url!("https://docs.google.com/presentation/d/");
        x.path_segments_mut().unwrap().push(id).push("export");
        x.query_pairs_mut().append_pair("format", "html");
        x
      }
      Self::File { id } => {
        let mut x: Url = url!("https://drive.google.com/uc");
        x.query_pairs_mut()
          .append_pair("export", "download")
          .append_pair("id", id);
        x
      }
      Self::Spreadsheets { id, gid } => {
        let mut x: Url = url!("https://docs.google.com/spreadsheets/d/");
        x.path_segments_mut()
          .unwrap()
          .push(id)
          .push("gviz")
          .push("tq");
        x.query_pairs_mut().append_pair("tqx", "out:html");
        if let Some(gid) = gid {
          x.query_pairs_mut().append_pair("gid", gid);
        }
        x
      }
    }
  }
}

/// `https?://{host}/{seg}/d/{id}`, fails on the published version;s `/d/e/` form
fn head<'a>(
  host: &'static str,
  seg: &'static str,
) -> impl FnMut(&'a str) -> IResult<&'a str, &'a str> {
  move |i| {
    let (i, _) = alt((tag("https://"), tag("http://"))).parse(i)?;
    let (i, _) = (tag(host), char('/'), tag(seg), tag("/d/")).parse(i)?;
    let (i, _) = not(tag("e/")).parse(i)?;
    take_while1(|c: char| c.is_ascii_alphanumeric() || c == '-' || c == '_').parse(i)
  }
}

/// extract and preserve gid to keep spreadsheet tab
fn gid(i: &str) -> IResult<&str, Option<String>> {
  let (rest, params) = many0(preceded(
    one_of("?&#"),
    take_till(|c: char| matches!(c, '?' | '&' | '#')),
  ))
  .parse(i)?;

  let gid = params.into_iter().find_map(|p| {
    let digits: String = p
      .strip_prefix("gid=")?
      .chars()
      .take_while(char::is_ascii_digit)
      .collect();
    (!digits.is_empty()).then_some(digits)
  });

  Ok((rest, gid))
}

fn link(i: &str) -> IResult<&str, GoogleDocLink> {
  alt((
    map(head("docs.google.com", "document"), |id: &str| {
      GoogleDocLink::Document { id: id.into() }
    }),
    map(head("docs.google.com", "presentation"), |id: &str| {
      GoogleDocLink::Presentation { id: id.into() }
    }),
    map(head("drive.google.com", "file"), |id: &str| {
      GoogleDocLink::File { id: id.into() }
    }),
    map(
      (head("docs.google.com", "spreadsheets"), gid),
      |(id, gid): (&str, Option<String>)| GoogleDocLink::Spreadsheets { id: id.into(), gid },
    ),
  ))
  .parse(i)
}
