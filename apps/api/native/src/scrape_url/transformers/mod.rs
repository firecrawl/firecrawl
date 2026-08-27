use tracing::instrument;

use super::{document::Document, meta::Meta};

macro_rules! generate_execute_tranformers {
    ($($f:path),+ $(,)?) => {
        #[instrument(name = "transformers::execute_transformers", skip(meta, document))]
        pub async fn execute_tranformers(
          meta: &Meta,
          mut document: Document,
        ) -> Result<Document, TransformerError> {
          $( document = $f(&meta, document).await?; )+
          Ok(document)
        }
    };
}

use attributes::derive_attributes_from_html;
use html::derive_html_from_raw_html;
use images::derive_images_from_html;
use links::derive_links_from_html;
use markdown::derive_markdown_from_html;
use metadata::derive_metadata_from_raw_html;

mod attributes;
mod html;
mod images;
mod links;
mod markdown;
mod metadata;

#[derive(Debug)]
pub enum TransformerError {
  CalledOutOfOrder(String),
}

generate_execute_tranformers!(
  derive_html_from_raw_html,
  derive_markdown_from_html,
  // TODO: perform_clean_content
  // TODO: perform_redact_pii
  derive_links_from_html,
  derive_images_from_html,
  // TODO: derive_branding_from_actions
  derive_metadata_from_raw_html,
  // TODO: fetch_product
  // TODO: fetch_menu
  // TODO: send_document_to_index
  // TODO: send_document_to_search_index
  // TODO: perform_llm_extract
  // TODO: perform_deterministic_json
  // TODO: perform_summary
  // TODO: perform_query
  derive_attributes_from_html,
  // TODO: perform_agent
  // TODO: remove_base64_images
  // TODO: derive_diff
  // TODO: fetch_audio
  // TODO: fetch_video
  // TODO: coerce_fields_to_formats // TODO: deal with raw_base64 format here
);
