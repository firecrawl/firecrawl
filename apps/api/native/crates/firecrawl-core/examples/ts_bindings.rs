//! Writes `apps/api/native/core-types.d.ts`. Run with `pnpm ts-bindings`.

use std::path::Path;

fn main() -> Result<(), String> {
  let out_path = Path::new(env!("CARGO_MANIFEST_DIR")).join("../../core-types.d.ts");
  let rendered = firecrawl_core::types::render_core_ts_bindings()?;
  std::fs::write(&out_path, rendered)
    .map_err(|err| format!("failed to write {}: {err}", out_path.display()))
}
