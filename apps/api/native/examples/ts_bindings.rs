//! Writes `scrape-url.d.ts`. Run with `pnpm ts-bindings`.

fn main() -> Result<(), String> {
  let path = concat!(env!("CARGO_MANIFEST_DIR"), "/scrape-url.d.ts");
  let rendered = firecrawl_rs::render_scrape_url_ts_bindings()?;
  std::fs::write(path, rendered).map_err(|e| format!("failed to write {path}: {e}"))
}
