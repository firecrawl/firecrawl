use std::collections::{BTreeSet, HashSet};

use serde::{Deserialize, Serialize};

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum SentenceSource {
  Heading,
  Text,
  Code,
  Table,
}

impl SentenceSource {
  pub const fn as_str(self) -> &'static str {
    match self {
      Self::Heading => "heading",
      Self::Text => "text",
      Self::Code => "code",
      Self::Table => "table",
    }
  }

  pub fn from_str_lossy(value: &str) -> Self {
    match value {
      "heading" => Self::Heading,
      "code" => Self::Code,
      "table" => Self::Table,
      _ => Self::Text,
    }
  }
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Sentence {
  pub text: String,
  pub source: SentenceSource,
  pub block_id: u32,
  #[serde(skip_serializing_if = "Option::is_none")]
  pub lang: Option<String>,
  #[serde(skip_serializing_if = "Option::is_none")]
  pub is_header: Option<bool>,
}

struct CodeRun<'a> {
  texts: Vec<&'a str>,
  lang: Option<&'a str>,
}

fn flush_code(parts: &mut Vec<String>, code_run: &mut Option<CodeRun<'_>>) {
  let Some(run) = code_run.take() else {
    return;
  };
  let mut block = String::from("```");
  if let Some(lang) = run.lang
    && !lang.is_empty()
  {
    block.push_str(lang);
  }
  block.push('\n');
  for (i, line) in run.texts.iter().enumerate() {
    if i > 0 {
      block.push('\n');
    }
    block.push_str(line);
  }
  block.push_str("\n```");
  parts.push(block);
}

fn format_table_row(text: &str) -> String {
  let mut row = String::with_capacity(text.len().saturating_add(4));
  row.push_str("| ");
  row.push_str(text);
  row.push_str(" |");
  row
}

fn format_table_header(text: &str) -> (String, String) {
  let cols: Vec<&str> = text.split(" | ").collect();
  let mut header = String::from("| ");
  let mut sep = String::from("| ");
  for (i, col) in cols.iter().enumerate() {
    if i > 0 {
      header.push_str(" | ");
      sep.push_str(" | ");
    }
    for ch in col.chars() {
      if ch == '*' {
        header.push_str("\\*");
      } else {
        header.push(ch);
      }
    }
    sep.push_str("---");
  }
  header.push_str(" |");
  sep.push_str(" |");
  (header, sep)
}

fn start_table(cur: &Sentence, table_rows: &mut Option<Vec<String>>) {
  let mut rows = Vec::new();
  if cur.is_header == Some(true) {
    let (header, sep) = format_table_header(&cur.text);
    rows.push(header);
    rows.push(sep);
  } else {
    rows.push(format_table_row(&cur.text));
  }
  *table_rows = Some(rows);
}

fn append_table_row(cur: &Sentence, table_rows: &mut Option<Vec<String>>) {
  let Some(rows) = table_rows.as_mut() else {
    start_table(cur, table_rows);
    return;
  };
  if cur.is_header == Some(true) {
    let (header, sep) = format_table_header(&cur.text);
    rows.insert(0, header);
    rows.insert(1, sep);
  } else {
    rows.push(format_table_row(&cur.text));
  }
}

fn flush_table(parts: &mut Vec<String>, table_rows: &mut Option<Vec<String>>) {
  let Some(rows) = table_rows.take() else {
    return;
  };
  parts.push(rows.join("\n"));
}

/// Reassemble selected spans (by 0-based index into `sentences`) back into
/// readable markdown, preserving tables, fenced code blocks, and paragraphs.
pub fn assemble_answer(sentences: &[Sentence], indices: &[i32]) -> String {
  let mut selected_indices: BTreeSet<usize> = BTreeSet::new();
  for &raw_idx in indices {
    if let Ok(idx) = usize::try_from(raw_idx)
      && idx < sentences.len()
    {
      selected_indices.insert(idx);
    }
  }

  let mut table_header_included: HashSet<u32> = HashSet::new();
  let mut headers_to_add: Vec<usize> = Vec::new();
  for &idx in &selected_indices {
    if let Some(s) = sentences.get(idx)
      && s.source == SentenceSource::Table
      && s.is_header != Some(true)
      && !table_header_included.contains(&s.block_id)
      && let Some(header_idx) = sentences
        .iter()
        .position(|h| h.block_id == s.block_id && h.is_header == Some(true))
    {
      headers_to_add.push(header_idx);
      table_header_included.insert(s.block_id);
    }
  }
  for header_idx in headers_to_add {
    selected_indices.insert(header_idx);
  }

  let selected: Vec<&Sentence> = selected_indices
    .into_iter()
    .filter_map(|idx| sentences.get(idx))
    .collect();

  let mut parts: Vec<String> = Vec::new();
  let mut code_run: Option<CodeRun<'_>> = None;
  let mut table_rows: Option<Vec<String>> = None;
  let mut prev: Option<&Sentence> = None;

  for &cur in &selected {
    let same_prev_block =
      prev.is_some_and(|p| p.block_id == cur.block_id && p.source == cur.source);

    if cur.source == SentenceSource::Code {
      flush_table(&mut parts, &mut table_rows);
      if same_prev_block && let Some(run) = code_run.as_mut() {
        run.texts.push(&cur.text);
      } else {
        flush_code(&mut parts, &mut code_run);
        code_run = Some(CodeRun {
          texts: vec![&cur.text],
          lang: cur.lang.as_deref(),
        });
      }
      prev = Some(cur);
      continue;
    }

    if cur.source == SentenceSource::Table {
      flush_code(&mut parts, &mut code_run);
      if same_prev_block && table_rows.is_some() {
        append_table_row(cur, &mut table_rows);
      } else {
        flush_table(&mut parts, &mut table_rows);
        start_table(cur, &mut table_rows);
      }
      prev = Some(cur);
      continue;
    }

    flush_code(&mut parts, &mut code_run);
    flush_table(&mut parts, &mut table_rows);

    if same_prev_block && let Some(last) = parts.last_mut() {
      last.push(' ');
      last.push_str(&cur.text);
    } else {
      parts.push(cur.text.clone());
    }
    prev = Some(cur);
  }

  flush_code(&mut parts, &mut code_run);
  flush_table(&mut parts, &mut table_rows);
  parts.join("\n\n")
}
