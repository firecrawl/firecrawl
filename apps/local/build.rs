//! Selects the vendored modules in crates.io builds.

use std::path::Path;

fn main() {
  println!("cargo:rustc-check-cfg=cfg(vendored_native)");
  println!("cargo:rerun-if-changed=build.rs");
  let root = std::env::var("CARGO_MANIFEST_DIR").unwrap_or_else(|_| ".".into());
  let root = Path::new(&root);
  if root.join("src/native").exists() {
    println!("cargo:rerun-if-changed=src/native");
  }
  if root.join("src/native/html.rs").exists() {
    println!("cargo:rustc-cfg=vendored_native");
  }
}
