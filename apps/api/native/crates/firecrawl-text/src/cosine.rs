use std::cmp::Ordering;

fn is_js_ascii_word_byte(b: u8) -> bool {
  b.is_ascii_alphanumeric() || b == b'_'
}

/// Split a string on maximal runs of JS `\W+` (`[^A-Za-z0-9_]+`), matching
/// `str.split(/\W+/)` including leading/trailing empty tokens.
fn split_js_non_word(input: &str) -> Vec<&str> {
  let bytes = input.as_bytes();
  let mut parts = Vec::new();
  let mut token_start = 0usize;
  let mut i = 0usize;

  while let Some(&b) = bytes.get(i) {
    if is_js_ascii_word_byte(b) {
      i = i.saturating_add(1);
    } else {
      if let Some(slice) = input.get(token_start..i) {
        parts.push(slice);
      }
      while let Some(&sep) = bytes.get(i) {
        if is_js_ascii_word_byte(sep) {
          break;
        }
        i = i.saturating_add(1);
      }
      token_start = i;
    }
  }

  if let Some(tail) = input.get(token_start..) {
    parts.push(tail);
  }
  parts
}

fn utf16_len(s: &str) -> usize {
  if s.is_ascii() {
    s.len()
  } else {
    s.encode_utf16().count()
  }
}

fn count_word_occurrences(haystack_lower: &str, haystack_utf16_len: usize, word: &str) -> usize {
  if word.is_empty() {
    // Matches `text.match(new RegExp("", "g")).length === text.length + 1`.
    return haystack_utf16_len.saturating_add(1);
  }
  haystack_lower.matches(word).count()
}

fn lowercase_into<'a>(src: &'a str, scratch: &'a mut String) -> &'a str {
  scratch.clear();
  if src.is_ascii() {
    scratch.push_str(src);
    scratch.make_ascii_lowercase();
    scratch.as_str()
  } else {
    for ch in src.chars() {
      for lower in ch.to_lowercase() {
        scratch.push(lower);
      }
    }
    scratch.as_str()
  }
}

/// Rank `links` by cosine similarity to `search_query` and return the 0-based
/// indices into `links` in descending score order (stable on ties).
pub fn rank_cosine_similarity_indices(links: &[String], search_query: &str) -> Vec<u32> {
  let count = links.len();
  let identity = || -> Vec<u32> {
    (0..count)
      .map(|idx| u32::try_from(idx).unwrap_or(u32::MAX))
      .collect()
  };

  if count <= 1 || search_query.is_empty() {
    return identity();
  }

  let query_lower = search_query.to_lowercase();
  let words = split_js_non_word(&query_lower);
  if words.is_empty() {
    return identity();
  }

  // Deduplicate query tokens so repeated words are only scanned once per URL.
  let mut unique_words: Vec<&str> = Vec::with_capacity(words.len());
  let mut word_to_unique: Vec<usize> = Vec::with_capacity(words.len());
  for &word in &words {
    if let Some(pos) = unique_words.iter().position(|&existing| existing == word) {
      word_to_unique.push(pos);
    } else {
      let pos = unique_words.len();
      unique_words.push(word);
      word_to_unique.push(pos);
    }
  }

  let query_utf16_len = utf16_len(search_query);
  let query_len_f64 = query_utf16_len as f64;
  let unique_query_counts: Vec<usize> = unique_words
    .iter()
    .map(|&w| count_word_occurrences(&query_lower, query_utf16_len, w))
    .collect();

  let mut search_vec: Vec<f64> = Vec::with_capacity(words.len());
  let mut sum_sq2 = 0.0_f64;
  for &u_idx in &word_to_unique {
    let c = unique_query_counts.get(u_idx).copied().unwrap_or(0);
    let val = (c as f64) / query_len_f64;
    search_vec.push(val);
    sum_sq2 += val * val;
  }
  let mag2 = sum_sq2.sqrt();

  let mut lower_buf = String::new();
  let mut unique_link_counts: Vec<usize> = vec![0; unique_words.len()];
  let mut scored: Vec<(usize, f64)> = Vec::with_capacity(count);

  for (idx, link) in links.iter().enumerate() {
    let link_utf16_len = utf16_len(link);
    let score = if link_utf16_len == 0 {
      f64::NAN
    } else {
      let link_lower = lowercase_into(link, &mut lower_buf);
      for (u_slot, &w) in unique_link_counts.iter_mut().zip(unique_words.iter()) {
        *u_slot = count_word_occurrences(link_lower, link_utf16_len, w);
      }

      let link_len_f64 = link_utf16_len as f64;
      let mut dot = 0.0_f64;
      let mut sum_sq1 = 0.0_f64;
      for (&u_idx, &val2) in word_to_unique.iter().zip(search_vec.iter()) {
        let c = unique_link_counts.get(u_idx).copied().unwrap_or(0);
        let val1 = (c as f64) / link_len_f64;
        dot += val1 * val2;
        sum_sq1 += val1 * val1;
      }
      let mag1 = sum_sq1.sqrt();
      if mag1 == 0.0 || mag2 == 0.0 {
        0.0
      } else {
        dot / (mag1 * mag2)
      }
    };
    scored.push((idx, score));
  }

  // Stable descending sort with total ordering on NaN so slice::sort_by never
  // panics even when empty URLs yield NaN scores.
  scored.sort_by(|&(idx_a, score_a), &(idx_b, score_b)| {
    match (score_a.is_nan(), score_b.is_nan()) {
      (true, true) => idx_a.cmp(&idx_b),
      (true, false) => Ordering::Greater,
      (false, true) => Ordering::Less,
      (false, false) => score_b
        .partial_cmp(&score_a)
        .unwrap_or(Ordering::Equal)
        .then_with(|| idx_a.cmp(&idx_b)),
    }
  });

  scored
    .into_iter()
    .map(|(idx, _)| u32::try_from(idx).unwrap_or(u32::MAX))
    .collect()
}

/// Rank `links` by cosine similarity to `search_query`, returning the links in
/// descending score order (stable on ties).
pub fn rank_cosine_similarity(links: &[String], search_query: &str) -> Vec<String> {
  let indices = rank_cosine_similarity_indices(links, search_query);
  let mut out = Vec::with_capacity(indices.len());
  for idx in indices {
    if let Some(link) = links.get(idx as usize) {
      out.push(link.clone());
    }
  }
  out
}

#[cfg(test)]
mod tests {
  use super::*;

  #[test]
  fn split_non_word_matches_js() {
    assert_eq!(split_js_non_word(""), vec![""]);
    assert_eq!(split_js_non_word("foo"), vec!["foo"]);
    assert_eq!(split_js_non_word("foo bar"), vec!["foo", "bar"]);
    assert_eq!(split_js_non_word("foo!"), vec!["foo", ""]);
    assert_eq!(split_js_non_word("!foo!"), vec!["", "foo", ""]);
    assert_eq!(split_js_non_word("---"), vec!["", ""]);
    assert_eq!(split_js_non_word("café"), vec!["caf", ""]);
  }

  #[test]
  fn ranks_matching_urls_first_and_preserves_tie_order() {
    let links = vec![
      "https://example.com/about".to_string(),
      "https://example.com/pricing".to_string(),
      "https://example.com/blog".to_string(),
      "https://example.com/docs/pricing".to_string(),
    ];
    let ranked = rank_cosine_similarity(&links, "pricing");
    assert_eq!(
      ranked,
      vec![
        "https://example.com/pricing",
        "https://example.com/docs/pricing",
        "https://example.com/about",
        "https://example.com/blog",
      ]
    );
  }

  #[test]
  fn handles_empty_query_and_regex_metacharacters() {
    let links = vec![
      "https://b.com/a+b".to_string(),
      "https://a.com/[test](1)".to_string(),
    ];
    assert_eq!(rank_cosine_similarity(&links, ""), links);
    let ranked = rank_cosine_similarity(&links, "[test](1)");
    assert_eq!(
      ranked.first().map(String::as_str),
      Some("https://a.com/[test](1)")
    );
  }
}
