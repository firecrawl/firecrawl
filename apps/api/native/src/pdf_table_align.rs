use pdf_inspector::{extract_text_with_positions_mem, TextItem};

const ROW_SLACK: f32 = 3.0;
const NEXT_ROW_LIMIT: f32 = 48.0;

struct PdfRow {
  y: f32,
  cells: Vec<(f32, String)>,
}

pub(crate) fn realign_tagged_tables(pdf: &[u8], markdown: String) -> String {
  if pdf.is_empty() || !has_pipe_table(&markdown) {
    return markdown;
  }
  let items = match extract_text_with_positions_mem(pdf) {
    Ok(items) => items,
    Err(_) => return markdown,
  };
  let grids = grids_for_markdown(&markdown, &items);
  if grids.is_empty() {
    return markdown;
  }
  replace_matching_tables(&markdown, &grids)
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
    right
      .line_y()
      .total_cmp(&left.line_y())
      .then(left.x.total_cmp(&right.x))
  });

  let mut rows: Vec<Vec<&TextItem>> = Vec::new();
  for item in ordered {
    if let Some(row) = rows.last_mut() {
      if (row[0].line_y() - item.line_y()).abs() <= ROW_SLACK {
        row.push(item);
        continue;
      }
    }
    rows.push(vec![item]);
  }

  rows
    .into_iter()
    .map(|row| PdfRow {
      y: row[0].line_y(),
      cells: merge_row(row),
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
    let join = cells
      .last()
      .is_some_and(|(_, _, right)| item.x - *right <= (item.font_size * 0.35).max(1.5));
    if join {
      let (_, text, right) = cells.last_mut().expect("join checks last");
      text.push_str(piece);
      *right = item.x + advance;
    } else {
      cells.push((item.x, piece.to_string(), item.x + advance));
    }
  }
  cells.into_iter().map(|(x, text, _)| (x, text)).collect()
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
  let mut body = Vec::new();
  let mut previous_y = pdf_rows[start].y;
  for offset in 1..parsed.len() {
    let row = pdf_rows.get(start + offset)?;
    if (previous_y - row.y).abs() > NEXT_ROW_LIMIT {
      return None;
    }
    previous_y = row.y;
    body.push(row.cells.clone());
  }
  let grid = place_on_columns(&pdf_rows[start].cells, &body)?;
  if !same_values(parsed, &grid) {
    return None;
  }
  Some((grid, start + parsed.len()))
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
  if header.windows(2).any(|pair| pair[1].0 <= pair[0].0) {
    return None;
  }
  let xs: Vec<f32> = header.iter().map(|(x, _)| *x).collect();
  let min_gap = xs
    .windows(2)
    .map(|pair| pair[1] - pair[0])
    .fold(f32::MAX, f32::min);
  let slack = (min_gap * 0.25).clamp(2.0, 12.0);
  let last_width = xs
    .windows(2)
    .map(|pair| pair[1] - pair[0])
    .fold(36.0, f32::max);

  let mut grid = Vec::with_capacity(body.len() + 1);
  grid.push(header.iter().map(|(_, text)| text.clone()).collect());
  for row in body {
    let mut placed = vec![String::new(); header.len()];
    for (x, text) in row {
      let column = column_for(*x, &xs, slack, last_width)?;
      if placed[column].is_empty() {
        placed[column] = text.clone();
      } else {
        placed[column].push(' ');
        placed[column].push_str(text);
      }
    }
    grid.push(placed);
  }
  Some(grid)
}

fn column_for(x: f32, xs: &[f32], slack: f32, last_width: f32) -> Option<usize> {
  for index in 0..xs.len() {
    let left = xs[index] - slack;
    let right = if index + 1 < xs.len() {
      xs[index + 1] - slack
    } else {
      xs[index] + last_width
    };
    if x >= left && x < right {
      return Some(index);
    }
  }
  None
}

fn markdown_tables(markdown: &str) -> Vec<Vec<Vec<String>>> {
  let lines: Vec<&str> = markdown.lines().collect();
  let mut tables = Vec::new();
  let mut index = 0;
  while index < lines.len() {
    if split_row(lines[index]).is_none() {
      index += 1;
      continue;
    }
    let start = index;
    while index < lines.len() && split_row(lines[index]).is_some() {
      index += 1;
    }
    let parsed: Vec<Vec<String>> = lines[start..index]
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
  while index < lines.len() {
    if split_row(lines[index]).is_none() {
      out.push(lines[index].to_string());
      index += 1;
      continue;
    }
    let start = index;
    while index < lines.len() && split_row(lines[index]).is_some() {
      index += 1;
    }
    let parsed: Vec<Vec<String>> = lines[start..index]
      .iter()
      .filter_map(|line| split_row(line))
      .filter(|row| !is_separator(row))
      .collect();
    let replacement = grids.iter().enumerate().find_map(|(grid_index, grid)| {
      if used[grid_index] || !same_values(&parsed, grid) || !placement_differs(&parsed, grid) {
        None
      } else {
        used[grid_index] = true;
        Some(render_table(grid))
      }
    });
    match replacement {
      Some(table) => out.push(table),
      None => {
        for line in &lines[start..index] {
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
  let line = line.trim();
  if !line.starts_with('|') || !line.ends_with('|') || line.len() < 2 {
    return None;
  }
  Some(
    line[1..line.len() - 1]
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
  let mut lines = Vec::with_capacity(grid.len() + 1);
  lines.push(pipe_row(&grid[0]));
  lines.push(separator(grid[0].len()));
  for row in grid.iter().skip(1) {
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
      grid[1],
      vec!["10/01", "LOAN PMT", "2,675.12", "", "15,777.25"]
    );
    assert_eq!(
      grid[2],
      vec!["10/06", "MOBILE DEPOSIT", "", "6,146.48", "17,352.24"]
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
}
