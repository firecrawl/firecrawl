use std::collections::HashSet;

use pdf_inspector::{
  PositionOptions, TextItem, extract_text_with_positions_mem,
  extract_text_with_positions_mem_with_options,
};

const ROW_SLACK: f32 = 3.0;
const NEXT_ROW_LIMIT: f32 = 48.0;
const WORD_GAP: f32 = 0.12;
const CELL_GAP: f32 = 0.35;

struct PdfRow {
  page: u32,
  y: f32,
  cells: Vec<(f32, String)>,
}

/// Restore empty cells in matching Markdown tables using the PDF text positions.
pub fn realign_tagged_tables(pdf: &[u8], markdown: String, max_pages: Option<u32>) -> String {
  if pdf.is_empty() || !has_pipe_table(&markdown) {
    return markdown;
  }
  let items = match positioned_text(pdf, max_pages) {
    Ok(items) => items,
    Err(_) => return markdown,
  };
  let grids = grids_for_markdown(&markdown, &items);
  if grids.is_empty() {
    return markdown;
  }
  replace_matching_tables(&markdown, &grids)
}

fn positioned_text(
  pdf: &[u8],
  max_pages: Option<u32>,
) -> Result<Vec<TextItem>, pdf_inspector::PdfError> {
  match max_pages {
    Some(limit) if limit > 0 => {
      let pages: HashSet<u32> = (1..=limit).collect();
      extract_text_with_positions_mem_with_options(pdf, Some(&pages), PositionOptions::new())
    }
    _ => extract_text_with_positions_mem(pdf),
  }
}

fn has_pipe_table(markdown: &str) -> bool {
  markdown
    .lines()
    .any(|line| line.starts_with('|') && line.ends_with('|') && line.matches('|').count() >= 3)
}

fn grids_for_markdown(markdown: &str, items: &[TextItem]) -> Vec<Vec<Vec<String>>> {
  let pdf_rows = pdf_rows(items);
  let mut cursor = 0;
  let mut grids = Vec::new();
  for table in markdown_tables(markdown) {
    let Some((grid, next)) = align_table(&table, &pdf_rows, cursor) else {
      continue;
    };
    cursor = next;
    grids.push(grid);
  }
  grids
}

fn pdf_rows(items: &[TextItem]) -> Vec<PdfRow> {
  let mut ordered: Vec<&TextItem> = items
    .iter()
    .filter(|item| !item.text.trim().is_empty())
    .collect();
  ordered.sort_by(|left, right| {
    left
      .page
      .cmp(&right.page)
      .then(right.line_y().total_cmp(&left.line_y()))
      .then(left.x.total_cmp(&right.x))
  });

  let mut rows: Vec<Vec<&TextItem>> = Vec::new();
  for item in ordered {
    if let Some(row) = rows.last_mut().filter(|row| {
      row.first().is_some_and(|first| {
        first.page == item.page && (first.line_y() - item.line_y()).abs() <= ROW_SLACK
      })
    }) {
      row.push(item);
    } else {
      rows.push(vec![item]);
    }
  }

  rows
    .into_iter()
    .filter_map(|row| {
      let first = *row.first()?;
      Some(PdfRow {
        page: first.page,
        y: first.line_y(),
        cells: merge_row(row),
      })
    })
    .filter(|row| !row.cells.is_empty())
    .collect()
}

fn merge_row(mut parts: Vec<&TextItem>) -> Vec<(f32, String)> {
  parts.sort_by(|left, right| left.x.total_cmp(&right.x));
  let mut cells: Vec<(f32, String, f32)> = Vec::new();
  for item in parts {
    let piece = item.text.trim();
    if piece.is_empty() {
      continue;
    }
    let advance = if item.width > 0.0 {
      item.width
    } else {
      item.font_size * 0.5 * piece.chars().count() as f32
    };
    let em = item.font_size.max(1.0);
    let attached = if let Some((_, text, right)) = cells.last_mut() {
      let gap = item.x - *right;
      if gap <= (em * WORD_GAP).max(0.4) {
        text.push_str(piece);
        *right = item.x + advance;
        true
      } else if gap <= (em * CELL_GAP).max(1.5) {
        if word_boundary(text, piece) {
          text.push(' ');
        }
        text.push_str(piece);
        *right = item.x + advance;
        true
      } else {
        false
      }
    } else {
      false
    };
    if !attached {
      cells.push((item.x, piece.to_string(), item.x + advance));
    }
  }
  cells.into_iter().map(|(x, text, _)| (x, text)).collect()
}

fn word_boundary(previous: &str, next: &str) -> bool {
  let previous_end = previous.chars().last();
  let next_start = next.chars().next();
  !matches!(previous_end, Some('-' | '(' | '[' | '{'))
    && !matches!(
      next_start,
      Some('-' | ')' | ']' | '}' | ',' | '.' | ';' | ':' | '!' | '?')
    )
}

fn align_table(
  parsed: &[Vec<String>],
  pdf_rows: &[PdfRow],
  cursor: usize,
) -> Option<(Vec<Vec<String>>, usize)> {
  if parsed.len() < 2 {
    return None;
  }
  let header = parsed.first()?;
  let start = pdf_rows
    .iter()
    .enumerate()
    .skip(cursor)
    .find_map(|(index, row)| {
      (row.cells.len() == header.len() && row_text(&row.cells) == row_text_owned(header))
        .then_some(index)
    })?;
  let next = start.checked_add(parsed.len())?;
  let (header_row, body_rows) = pdf_rows.get(start..next)?.split_first()?;
  let mut body = Vec::with_capacity(body_rows.len());
  let mut previous_y = header_row.y;
  for row in body_rows {
    if row.page != header_row.page || (previous_y - row.y).abs() > NEXT_ROW_LIMIT {
      return None;
    }
    previous_y = row.y;
    body.push(row.cells.clone());
  }
  let grid = place_on_columns(&header_row.cells, &body)?;
  if !same_values(parsed, &grid) {
    return None;
  }
  Some((grid, next))
}

fn row_text(cells: &[(f32, String)]) -> Vec<&str> {
  cells.iter().map(|(_, text)| text.trim()).collect()
}

fn row_text_owned(cells: &[String]) -> Vec<&str> {
  cells.iter().map(|text| text.trim()).collect()
}

fn place_on_columns(
  header: &[(f32, String)],
  body: &[Vec<(f32, String)>],
) -> Option<Vec<Vec<String>>> {
  if header.len() < 2 || body.is_empty() {
    return None;
  }
  let xs: Vec<f32> = header.iter().map(|(x, _)| *x).collect();
  let mut min_gap = f32::MAX;
  let mut last_width = 36.0_f32;
  for (&left, &right) in xs.iter().zip(xs.iter().skip(1)) {
    if right <= left {
      return None;
    }
    let gap = right - left;
    min_gap = min_gap.min(gap);
    last_width = last_width.max(gap);
  }
  let slack = (min_gap * 0.25).clamp(2.0, 12.0);

  let mut grid = Vec::with_capacity(body.len().saturating_add(1));
  grid.push(header.iter().map(|(_, text)| text.clone()).collect());
  for row in body {
    let mut placed = vec![String::new(); header.len()];
    for (x, text) in row {
      let cell = placed.get_mut(column_for(*x, &xs, slack, last_width)?)?;
      if cell.is_empty() {
        cell.clone_from(text);
      } else {
        cell.push(' ');
        cell.push_str(text);
      }
    }
    grid.push(placed);
  }
  Some(grid)
}

fn column_for(x: f32, xs: &[f32], slack: f32, last_width: f32) -> Option<usize> {
  xs.iter().enumerate().position(|(index, &start)| {
    let left = start - slack;
    let right = xs
      .get(index.saturating_add(1))
      .map_or(start + last_width, |next| next - slack);
    x >= left && x < right
  })
}

fn markdown_tables(markdown: &str) -> Vec<Vec<Vec<String>>> {
  let lines: Vec<&str> = markdown.lines().collect();
  let mut tables = Vec::new();
  let mut index = 0;
  while let Some(line) = lines.get(index) {
    if split_row(line).is_none() {
      index = index.saturating_add(1);
      continue;
    }
    let start = index;
    while lines
      .get(index)
      .is_some_and(|line| split_row(line).is_some())
    {
      index = index.saturating_add(1);
    }
    let parsed: Vec<Vec<String>> = lines
      .get(start..index)
      .unwrap_or_default()
      .iter()
      .filter_map(|line| split_row(line))
      .filter(|row| !is_separator(row))
      .collect();
    if parsed.len() >= 2 {
      tables.push(parsed);
    }
  }
  tables
}

fn replace_matching_tables(markdown: &str, grids: &[Vec<Vec<String>>]) -> String {
  let ends_with_newline = markdown.ends_with('\n');
  let lines: Vec<&str> = markdown.lines().collect();
  let mut used = vec![false; grids.len()];
  let mut out: Vec<String> = Vec::new();
  let mut index = 0;
  while let Some(line) = lines.get(index) {
    if split_row(line).is_none() {
      out.push(line.to_string());
      index = index.saturating_add(1);
      continue;
    }
    let start = index;
    while lines
      .get(index)
      .is_some_and(|line| split_row(line).is_some())
    {
      index = index.saturating_add(1);
    }
    let table_lines = lines.get(start..index).unwrap_or_default();
    let parsed: Vec<Vec<String>> = table_lines
      .iter()
      .filter_map(|line| split_row(line))
      .filter(|row| !is_separator(row))
      .collect();
    let replacement = grids.iter().zip(&mut used).find_map(|(grid, used)| {
      if *used || !same_values(&parsed, grid) || !placement_differs(&parsed, grid) {
        None
      } else {
        *used = true;
        Some(render_table(grid))
      }
    });
    match replacement {
      Some(table) => out.push(table),
      None => {
        for line in table_lines {
          out.push((*line).to_string());
        }
      }
    }
  }
  let mut rendered = out.join("\n");
  if ends_with_newline {
    rendered.push('\n');
  }
  rendered
}

fn split_row(line: &str) -> Option<Vec<String>> {
  let inner = line.trim().strip_prefix('|')?.strip_suffix('|')?;
  Some(
    inner
      .split('|')
      .map(|cell| cell.trim().to_string())
      .collect(),
  )
}

fn is_separator(row: &[String]) -> bool {
  !row.is_empty()
    && row.iter().all(|cell| {
      let cell = cell.trim().trim_matches(':');
      !cell.is_empty() && cell.chars().all(|character| character == '-')
    })
}

fn nonempty(row: &[String]) -> Vec<&str> {
  row
    .iter()
    .map(|cell| cell.trim())
    .filter(|cell| !cell.is_empty())
    .collect()
}

fn same_values(parsed: &[Vec<String>], placed: &[Vec<String>]) -> bool {
  parsed.len() == placed.len()
    && parsed
      .iter()
      .zip(placed)
      .all(|(left, right)| left.len() == right.len() && nonempty(left) == nonempty(right))
}

fn placement_differs(parsed: &[Vec<String>], placed: &[Vec<String>]) -> bool {
  parsed.iter().zip(placed).any(|(left, right)| {
    left
      .iter()
      .map(|cell| cell.trim())
      .ne(right.iter().map(|cell| cell.trim()))
  })
}

fn render_table(grid: &[Vec<String>]) -> String {
  let Some((header, body)) = grid.split_first() else {
    return String::new();
  };
  let mut lines = Vec::with_capacity(grid.len().saturating_add(1));
  lines.push(pipe_row(header));
  lines.push(separator(header.len()));
  for row in body {
    lines.push(pipe_row(row));
  }
  lines.join("\n")
}

fn pipe_row(row: &[String]) -> String {
  let mut line = String::from("|");
  for cell in row {
    line.push_str(cell.trim());
    line.push('|');
  }
  line
}

fn separator(columns: usize) -> String {
  let mut line = String::from("|");
  for _ in 0..columns {
    line.push_str("---|");
  }
  line
}

#[cfg(test)]
#[allow(clippy::expect_used)]
mod tests {
  use super::*;

  fn header() -> Vec<(f32, String)> {
    ["Date", "Description", "Withdrawals", "Deposits", "Balance"]
      .into_iter()
      .enumerate()
      .map(|(index, text)| (100.0 + index as f32 * 80.0, text.to_string()))
      .collect()
  }

  #[test]
  fn empty_middle_cells_stay_under_their_headers() {
    let body = vec![
      vec![
        (100.0, "10/01".to_string()),
        (180.0, "LOAN PMT".to_string()),
        (260.0, "2,675.12".to_string()),
        (420.0, "15,777.25".to_string()),
      ],
      vec![
        (100.0, "10/06".to_string()),
        (180.0, "MOBILE DEPOSIT".to_string()),
        (340.0, "6,146.48".to_string()),
        (420.0, "17,352.24".to_string()),
      ],
    ];
    let grid = place_on_columns(&header(), &body).expect("columns are distinct");
    assert_eq!(
      grid.get(1).expect("first body row"),
      &["10/01", "LOAN PMT", "2,675.12", "", "15,777.25"]
    );
    assert_eq!(
      grid.get(2).expect("second body row"),
      &["10/06", "MOBILE DEPOSIT", "", "6,146.48", "17,352.24"]
    );
  }

  #[test]
  fn a_cell_outside_the_header_columns_is_not_placed() {
    let body = vec![vec![
      (20.0, "1".to_string()),
      (100.0, "10/01".to_string()),
      (180.0, "LOAN PMT".to_string()),
    ]];
    assert!(place_on_columns(&header(), &body).is_none());
  }

  #[test]
  fn a_shifted_markdown_table_is_rewritten_and_other_text_stays() {
    let markdown = "\
Intro\n\
|Date|Description|Withdrawals|Deposits|Balance|\n\
|---|---|---|---|---|\n\
|10/01|LOAN PMT|2,675.12|15,777.25||\n\
|10/06|MOBILE DEPOSIT|6,146.48|17,352.24||\n\
After\n";
    let grid = place_on_columns(
      &header(),
      &[
        vec![
          (100.0, "10/01".to_string()),
          (180.0, "LOAN PMT".to_string()),
          (260.0, "2,675.12".to_string()),
          (420.0, "15,777.25".to_string()),
        ],
        vec![
          (100.0, "10/06".to_string()),
          (180.0, "MOBILE DEPOSIT".to_string()),
          (340.0, "6,146.48".to_string()),
          (420.0, "17,352.24".to_string()),
        ],
      ],
    )
    .expect("columns are distinct");
    let rendered = replace_matching_tables(markdown, &[grid]);
    assert!(
      rendered.contains("|10/01|LOAN PMT|2,675.12||15,777.25|"),
      "{rendered}"
    );
    assert!(
      rendered.contains("|10/06|MOBILE DEPOSIT||6,146.48|17,352.24|"),
      "{rendered}"
    );
    assert!(rendered.starts_with("Intro\n"), "{rendered}");
    assert!(rendered.trim_end().ends_with("After"), "{rendered}");
    assert!(
      !rendered.contains("|10/01|LOAN PMT|2,675.12|15,777.25||"),
      "{rendered}"
    );
  }

  #[test]
  fn an_already_aligned_table_is_left_unchanged() {
    let markdown = "|A|B|\n|---|---|\n|1|2|\n";
    let grid = vec![
      vec!["A".to_string(), "B".to_string()],
      vec!["1".to_string(), "2".to_string()],
    ];
    assert_eq!(replace_matching_tables(markdown, &[grid]), markdown);
  }

  fn text_item(text: &str, x: f32, width: f32, y: f32, page: u32) -> TextItem {
    TextItem {
      text: text.to_string(),
      x,
      y,
      width,
      height: 12.0,
      font: "F1".to_string(),
      font_tag: String::new(),
      legacy_symbol_rewrite: false,
      font_size: 12.0,
      page,
      is_bold: false,
      is_italic: false,
      font_weight: None,
      bold_source: None,
      fixed_pitch: None,
      fill_color: None,
      stroke_color: None,
      render_mode: None,
      is_underline: false,
      is_strikeout: false,
      rotation: 0.0,
      advance_known: true,
      item_type: pdf_inspector::types::ItemType::Text,
      mcid: None,
      baseline_shift: 0.0,
    }
  }

  #[test]
  fn a_word_gap_keeps_a_space_and_kerning_does_not() {
    let mobile = text_item("MOBILE", 100.0, 48.0, 700.0, 1);
    let deposit = text_item("DEPOSIT", 151.0, 52.0, 700.0, 1);
    let with = text_item("With", 100.0, 24.0, 680.0, 1);
    let drawals = text_item("drawals", 124.2, 40.0, 680.0, 1);
    let words = merge_row(vec![&mobile, &deposit]);
    let kerned = merge_row(vec![&with, &drawals]);
    assert_eq!(words, vec![(100.0, "MOBILE DEPOSIT".to_string())]);
    assert_eq!(kerned, vec![(100.0, "Withdrawals".to_string())]);
  }

  #[test]
  fn rows_on_different_pages_stay_apart() {
    let page_one_header = text_item("Date", 40.0, 26.0, 700.0, 1);
    let page_one_value = text_item("10/01", 40.0, 28.0, 680.0, 1);
    let page_two_header = text_item("Date", 40.0, 26.0, 700.0, 2);
    let page_two_value = text_item("10/02", 40.0, 28.0, 680.0, 2);
    let rows = pdf_rows(&[
      page_one_header,
      page_two_header,
      page_one_value,
      page_two_value,
    ]);
    let labels: Vec<(&str, u32)> = rows
      .iter()
      .map(|row| {
        (
          row.cells.first().expect("row has text").1.as_str(),
          row.page,
        )
      })
      .collect();
    assert_eq!(
      labels,
      vec![("Date", 1), ("10/01", 1), ("Date", 2), ("10/02", 2)]
    );
  }
}
