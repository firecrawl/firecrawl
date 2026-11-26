use std::sync::OnceLock;

use tiktoken::CoreBpe;

use crate::{Encoding, TokenizerError};

static INIT_SINGLE_THREAD: OnceLock<()> = OnceLock::new();
static O200K_BASE: OnceLock<&'static CoreBpe> = OnceLock::new();
static CL100K_BASE: OnceLock<&'static CoreBpe> = OnceLock::new();
static P50K_BASE: OnceLock<&'static CoreBpe> = OnceLock::new();
static P50K_EDIT: OnceLock<&'static CoreBpe> = OnceLock::new();
static R50K_BASE: OnceLock<&'static CoreBpe> = OnceLock::new();

fn get_or_init_slot(
  slot: &OnceLock<&'static CoreBpe>,
  name: &'static str,
) -> Result<&'static CoreBpe, TokenizerError> {
  if let Some(bpe) = slot.get() {
    return Ok(*bpe);
  }

  // Keep tokenization on the caller's thread so embedding inside async worker
  // runtimes never spawns an unmanaged secondary thread pool.
  INIT_SINGLE_THREAD.get_or_init(|| tiktoken::set_parallelism(1));

  let bpe = tiktoken::get_encoding(name).ok_or(TokenizerError::EncodingUnavailable(name))?;
  let _ = slot.set(bpe);
  Ok(bpe)
}

/// Returns the process-global cached `CoreBpe` for `encoding`, initializing it
/// at most once per process.
pub(crate) fn encoder(encoding: Encoding) -> Result<&'static CoreBpe, TokenizerError> {
  match encoding {
    Encoding::O200kBase => get_or_init_slot(&O200K_BASE, "o200k_base"),
    Encoding::Cl100kBase => get_or_init_slot(&CL100K_BASE, "cl100k_base"),
    Encoding::P50kBase => get_or_init_slot(&P50K_BASE, "p50k_base"),
    Encoding::P50kEdit => get_or_init_slot(&P50K_EDIT, "p50k_edit"),
    Encoding::R50kBase | Encoding::Gpt2 => get_or_init_slot(&R50K_BASE, "r50k_base"),
  }
}
