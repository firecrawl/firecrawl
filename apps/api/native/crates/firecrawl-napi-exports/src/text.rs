use firecrawl_text::{Sentence, SentenceSource};
use serde_json::Value;

pub fn rank_cosine_similarity(links: Vec<String>, search_query: String) -> Vec<String> {
  firecrawl_text::rank_cosine_similarity(&links, &search_query)
}

pub fn rank_cosine_similarity_indices(links: Vec<String>, search_query: String) -> Vec<u32> {
  firecrawl_text::rank_cosine_similarity_indices(&links, &search_query)
}

pub fn parse_markdown_to_sentences(markdown: String) -> Vec<Sentence> {
  firecrawl_text::parse_markdown_to_sentences(&markdown)
}

pub fn assemble_answer(sentences: Vec<Sentence>, indices: Vec<i32>) -> String {
  firecrawl_text::assemble_answer(&sentences, &indices)
}

pub fn parse_source(value: &str) -> SentenceSource {
  SentenceSource::from_str_lossy(value)
}

pub fn normalize_schema_keywords(mut schema: Value) -> Value {
  firecrawl_text::normalize_schema_keywords_in_place(&mut schema);
  schema
}

pub fn to_root_schema(schema: Value) -> Value {
  firecrawl_text::to_root_schema_owned(schema)
}

pub fn find_strict_schema_violation(schema: Value) -> Option<String> {
  firecrawl_text::find_strict_schema_violation_owned(schema)
}

pub fn normalize_schema_keywords_json(schema_json: &str) -> Result<String, serde_json::Error> {
  let mut value: Value = serde_json::from_str(schema_json)?;
  firecrawl_text::normalize_schema_keywords_in_place(&mut value);
  serde_json::to_string(&value)
}

pub fn to_root_schema_json(schema_json: &str) -> Result<String, serde_json::Error> {
  let value: Value = serde_json::from_str(schema_json)?;
  let root = firecrawl_text::to_root_schema_owned(value);
  serde_json::to_string(&root)
}

pub fn find_strict_schema_violation_json(
  schema_json: &str,
) -> Result<Option<String>, serde_json::Error> {
  let value: Value = serde_json::from_str(schema_json)?;
  Ok(firecrawl_text::find_strict_schema_violation_owned(value))
}
