//! GFM data table rendering (colspan expansion, ragged-row padding, column
//! alignment markers, safe caption formatting) and layout-table unwrapping.

use kuchikiki::NodeRef;

use super::RenderCtx;
use super::block_map::{attr, normalize_inline, tag_of};
use super::blocks::render_blocks;
use super::code::is_gutter_class;
use super::inline::{InlineState, inline_children};

const MAX_TABLE_COLUMNS: usize = 64;
const MAX_TABLE_CELLS: usize = 16_384;

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum ColAlign {
  Default,
  Left,
  Center,
  Right,
}

impl ColAlign {
  fn from_cell(cell: &NodeRef) -> Self {
    let Some(raw) = attr(cell, "align") else {
      return Self::Default;
    };
    match raw.trim().to_ascii_lowercase().as_str() {
      "left" => Self::Left,
      "center" => Self::Center,
      "right" => Self::Right,
      _ => Self::Default,
    }
  }

  const fn separator(self) -> &'static str {
    match self {
      Self::Default => "---",
      Self::Left => ":--",
      Self::Center => ":-:",
      Self::Right => "--:",
    }
  }
}

struct Row {
  cells: Vec<NodeRef>,
  header: bool,
}

fn cell_is_code_pane(cell: &NodeRef) -> bool {
  if attr(cell, "class").is_some_and(|c| c.to_ascii_lowercase().contains("code")) {
    return true;
  }
  cell
    .descendants()
    .skip(1)
    .any(|d| tag_of(&d) == Some("pre"))
}

fn collect_rows(
  ctx: &RenderCtx<'_>,
  node: &NodeRef,
  in_head: bool,
  rows: &mut Vec<Row>,
  caption: &mut Option<String>,
  depth: usize,
  state: InlineState,
) {
  if depth >= ctx.opts.max_dom_depth {
    return;
  }
  let next_depth = depth.saturating_add(1);
  for child in node.children() {
    match tag_of(&child) {
      Some("thead") => collect_rows(ctx, &child, true, rows, caption, next_depth, state),
      Some("tbody" | "tfoot") => collect_rows(ctx, &child, false, rows, caption, next_depth, state),
      Some("caption") => {
        let text =
          normalize_inline(&inline_children(ctx, &child, state, next_depth)).replace('\n', " ");
        if !text.is_empty() {
          *caption = Some(text);
        }
      }
      Some("tr") => {
        let raw_cells: Vec<NodeRef> = child
          .children()
          .filter(|c| matches!(tag_of(c), Some("td" | "th")))
          .collect();
        if raw_cells.is_empty() {
          continue;
        }
        // Strip syntax-highlighter line-number gutter cells when paired with a code cell.
        let has_code_cell = raw_cells
          .iter()
          .any(|c| !is_gutter_class(c) && cell_is_code_pane(c));
        let cells: Vec<NodeRef> = if has_code_cell {
          raw_cells
            .into_iter()
            .filter(|c| !is_gutter_class(c))
            .collect()
        } else {
          raw_cells
        };
        if cells.is_empty() {
          continue;
        }
        let all_th = cells.iter().all(|c| tag_of(c) == Some("th"));
        rows.push(Row {
          cells,
          header: in_head || all_th,
        });
      }
      _ => {}
    }
  }
}

fn cell_span(cell: &NodeRef) -> usize {
  attr(cell, "colspan")
    .and_then(|s| s.trim().parse::<usize>().ok())
    .unwrap_or(1)
    .clamp(1, 50)
}

fn cell_text(ctx: &RenderCtx<'_>, cell: &NodeRef, depth: usize, state: InlineState) -> String {
  let text = render_blocks(ctx, cell, depth, state).join(" ");
  let text = text.replace('\n', " ").replace('|', "\\|");
  normalize_inline(&text)
}

fn format_caption(caption: &str) -> String {
  if caption.contains("**") {
    caption.to_string()
  } else {
    format!("**{caption}**")
  }
}

fn column_alignments(row: Option<&Row>, columns: usize) -> Vec<ColAlign> {
  let mut aligns = vec![ColAlign::Default; columns];
  let Some(row) = row else {
    return aligns;
  };
  let mut col = 0usize;
  for cell in &row.cells {
    let align = ColAlign::from_cell(cell);
    let span = cell_span(cell);
    for _ in 0..span {
      if let Some(slot) = aligns.get_mut(col) {
        *slot = align;
      }
      col = col.saturating_add(1);
    }
  }
  aligns
}

pub(crate) fn render_table(
  ctx: &RenderCtx<'_>,
  node: &NodeRef,
  depth: usize,
  state: InlineState,
) -> String {
  let next_depth = depth.saturating_add(1);
  let mut rows = Vec::new();
  let mut caption = None;
  collect_rows(ctx, node, false, &mut rows, &mut caption, next_depth, state);
  if rows.is_empty() {
    return render_blocks(ctx, node, next_depth, state).join("\n\n");
  }

  let columns = rows
    .iter()
    .map(|r| {
      r.cells
        .iter()
        .fold(0usize, |acc, c| acc.saturating_add(cell_span(c)))
    })
    .max()
    .unwrap_or(0);
  if columns == 0 {
    return caption.map_or_else(String::new, |c| format_caption(&c));
  }

  let has_header = rows.iter().any(|r| r.header)
    || rows
      .iter()
      .any(|r| r.cells.iter().any(|c| tag_of(c) == Some("th")));
  let presentational = matches!(attr(node, "role").as_deref(), Some("presentation" | "none"));
  let prose_cells = !has_header
    && rows.iter().any(|r| {
      r.cells.iter().any(|c| {
        c.descendants().skip(1).any(|d| {
          matches!(
            tag_of(&d),
            Some("p" | "ul" | "ol" | "pre" | "blockquote" | "h1" | "h2" | "h3" | "h4")
          )
        }) || c.text_contents().len() > 400
      })
    });

  let too_large =
    columns > MAX_TABLE_COLUMNS || rows.len().saturating_mul(columns) > MAX_TABLE_CELLS;
  let unwrap = too_large
    || (ctx.opts.unwrap_layout_tables
      && (columns <= 1 || ctx.block_map.has_nested_table(node) || presentational || prose_cells));
  if unwrap {
    let mut parts = Vec::new();
    if let Some(c) = caption {
      parts.push(format_caption(&c));
    }
    for row in &rows {
      for cell in &row.cells {
        let text = render_blocks(ctx, cell, next_depth, state).join("\n\n");
        if !text.is_empty() {
          parts.push(text);
        }
      }
    }
    return parts.join("\n\n");
  }

  let render_row = |row: &Row| -> String {
    let mut line = String::from("|");
    let mut used = 0usize;
    for cell in &row.cells {
      let span = cell_span(cell);
      line.push(' ');
      line.push_str(&cell_text(ctx, cell, next_depth, state));
      line.push_str(" |");
      for _ in 1..span {
        line.push_str(" |");
      }
      used = used.saturating_add(span);
    }
    for _ in used..columns {
      line.push_str(" |");
    }
    line
  };

  let mut out = String::new();
  if let Some(c) = caption {
    out.push_str(&format_caption(&c));
    out.push_str("\n\n");
  }

  let aligns = column_alignments(rows.first(), columns);
  let mut body = rows.iter();
  match rows.first() {
    Some(first) if first.header => {
      out.push_str(&render_row(first));
      body.next();
    }
    _ => {
      out.push('|');
      for _ in 0..columns {
        out.push_str(" |");
      }
    }
  }

  out.push_str("\n|");
  for align in aligns {
    out.push(' ');
    out.push_str(align.separator());
    out.push_str(" |");
  }

  for row in body {
    out.push('\n');
    out.push_str(&render_row(row));
  }
  out
}
