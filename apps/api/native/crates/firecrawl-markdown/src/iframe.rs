//! `<iframe>` handling: `[iframe](src)` link emission and depth-bounded
//! conversion of `data:text/html` embedded documents.

use kuchikiki::{NodeRef, parse_html, traits::TendrilSink};

use super::block_map::{BlockMap, attr};
use super::escape::{encode_url, is_data_uri, is_javascript_uri};
use super::inline::InlineState;
use super::{IframeMode, RenderCtx, blocks};

pub(crate) fn is_data_text_html(uri: &str) -> bool {
  let trimmed: Vec<u8> = uri
    .bytes()
    .skip_while(|b| *b <= 0x20)
    .filter(|b| !matches!(b, b'\t' | b'\r' | b'\n'))
    .take(14)
    .collect();
  trimmed.len() == 14 && trimmed.eq_ignore_ascii_case(b"data:text/html")
}

fn hex_val(b: u8) -> Option<u8> {
  match b {
    b'0'..=b'9' => Some(b.saturating_sub(b'0')),
    b'a'..=b'f' => Some(b.saturating_sub(b'a').saturating_add(10)),
    b'A'..=b'F' => Some(b.saturating_sub(b'A').saturating_add(10)),
    _ => None,
  }
}

/// RFC 2397 percent-decoding for `data:` URL bodies (literal `+` stays `+`).
fn percent_decode(input: &str) -> String {
  let bytes = input.as_bytes();
  let mut out: Vec<u8> = Vec::with_capacity(bytes.len());
  let mut i = 0usize;
  while let Some(&b) = bytes.get(i) {
    if b == b'%' {
      let hi = bytes.get(i.saturating_add(1)).copied().and_then(hex_val);
      let lo = bytes.get(i.saturating_add(2)).copied().and_then(hex_val);
      if let (Some(h), Some(l)) = (hi, lo) {
        out.push(h.wrapping_shl(4) | l);
        i = i.saturating_add(3);
      } else {
        out.push(b'%');
        i = i.saturating_add(1);
      }
    } else {
      out.push(b);
      i = i.saturating_add(1);
    }
  }
  String::from_utf8_lossy(&out).into_owned()
}

fn decode_base64(input: &str) -> Option<String> {
  let mut bytes: Vec<u8> = Vec::with_capacity(input.len());
  let mut buf = 0u32;
  let mut bits = 0u32;
  for b in input.bytes() {
    if b.is_ascii_whitespace() || b == b'=' {
      continue;
    }
    let val = match b {
      b'A'..=b'Z' => b.saturating_sub(b'A'),
      b'a'..=b'z' => b.saturating_sub(b'a').saturating_add(26),
      b'0'..=b'9' => b.saturating_sub(b'0').saturating_add(52),
      b'+' | b'-' => 62,
      b'/' | b'_' => 63,
      _ => return None,
    };
    buf = buf.wrapping_shl(6) | u32::from(val);
    bits = bits.saturating_add(6);
    if bits >= 8 {
      bits = bits.saturating_sub(8);
      bytes.push((buf.wrapping_shr(bits) & 0xFF) as u8);
    }
  }
  Some(String::from_utf8_lossy(&bytes).into_owned())
}

/// Convert a `data:text/html,...` iframe payload into Markdown blocks while
/// carrying the caller's DOM depth budget into the embedded document.
pub(crate) fn render_data_iframe_blocks(
  ctx: &RenderCtx<'_>,
  src: &str,
  depth: usize,
  state: InlineState,
) -> Vec<String> {
  if depth >= ctx.opts.max_dom_depth || state.iframe_depth >= ctx.opts.max_iframe_depth {
    return Vec::new();
  }
  let Some((meta, payload)) = src.split_once(',') else {
    return Vec::new();
  };
  let decoded_payload = percent_decode(payload);
  let html = if meta.to_ascii_lowercase().contains(";base64") {
    match decode_base64(&decoded_payload) {
      Some(decoded) => decoded,
      None => return Vec::new(),
    }
  } else {
    decoded_payload
  };
  let doc = parse_html().one(html);
  let inner_ctx = RenderCtx {
    opts: ctx.opts,
    block_map: BlockMap::build(&doc.document_node, ctx.opts),
  };
  let inner_state = InlineState {
    iframe_depth: state.iframe_depth.saturating_add(1),
    ..InlineState::default()
  };
  blocks::render_blocks(
    &inner_ctx,
    &doc.document_node,
    depth.saturating_add(1),
    inner_state,
  )
}

/// Render an `<iframe>` inline as `[iframe](src)` or converted `data:text/html`.
pub(crate) fn render_iframe_inline(
  ctx: &RenderCtx<'_>,
  node: &NodeRef,
  depth: usize,
  state: InlineState,
  out: &mut String,
) {
  if ctx.opts.iframes == IframeMode::Skip {
    return;
  }
  let src_raw = attr(node, "src").unwrap_or_default();
  let src = src_raw.trim();
  if src.is_empty() || is_javascript_uri(src) {
    return;
  }
  if is_data_text_html(src) {
    let inner = render_data_iframe_blocks(ctx, src, depth, state).join(" ");
    if !inner.is_empty() {
      out.push_str(&inner);
    }
    return;
  }
  if is_data_uri(src) {
    return;
  }
  out.push_str(&format!("[iframe]({})", encode_url(src)));
}
