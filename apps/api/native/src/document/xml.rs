//! Helpers shared by the zip+XML based providers (docx, odt).

use roxmltree::Node;
use std::io::{Read, Seek};
use zip::read::ZipArchive;

pub fn read_zip_text<R: Read + Seek>(zip: &mut ZipArchive<R>, path: &str) -> Option<String> {
  let mut file = zip.by_name(path).ok()?;
  let mut s = String::new();
  file.read_to_string(&mut s).ok()?;
  Some(s)
}

pub fn strip_bom(s: &str) -> &str {
  s.strip_prefix('\u{FEFF}').unwrap_or(s)
}

pub fn is_tag(node: &Node, local: &str) -> bool {
  node.is_element() && node.tag_name().name() == local
}

/// Attribute value matched by local name, ignoring the namespace prefix.
pub fn attr<'a>(node: &Node<'a, 'a>, local: &str) -> Option<&'a str> {
  node
    .attributes()
    .find(|a| {
      let name = a.name();
      match name.rsplit_once(':') {
        Some((_, l)) => l == local,
        None => name == local,
      }
    })
    .map(|a| a.value())
}

pub fn child<'a>(node: &Node<'a, 'a>, local: &str) -> Option<Node<'a, 'a>> {
  node
    .children()
    .find(|n| n.is_element() && n.tag_name().name() == local)
}

pub fn children<'a, 'b>(
  node: &Node<'a, 'a>,
  local: &'b str,
) -> impl Iterator<Item = Node<'a, 'a>> + use<'a, 'b> {
  node
    .children()
    .filter(move |n| n.is_element() && n.tag_name().name() == local)
}
