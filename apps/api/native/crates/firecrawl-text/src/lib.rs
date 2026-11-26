pub mod cosine;
mod gfm_autolink;
pub mod highlight_assemble;
mod highlight_inline;
mod highlight_list_inline;
pub mod highlight_spans;
pub mod html_entities;
mod html_escape;
pub mod strict_schema;
mod strict_schema_check;

pub use cosine::{rank_cosine_similarity, rank_cosine_similarity_indices};
pub use highlight_assemble::{Sentence, SentenceSource, assemble_answer};
pub use highlight_spans::parse_markdown_to_sentences;
pub use strict_schema::{
  normalize_schema_keywords, normalize_schema_keywords_in_place, to_root_schema,
  to_root_schema_owned, type_includes,
};
pub use strict_schema_check::{find_strict_schema_violation, find_strict_schema_violation_owned};
