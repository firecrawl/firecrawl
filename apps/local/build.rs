//! Decides where the shared cleaning code is compiled from.
//!
//! In the repository it comes straight from `apps/api/native/src`, the same
//! files the cloud API loads. A crate published to crates.io cannot reach
//! outside its own folder, so `scripts/vendor-native.sh` copies those files
//! to `src/native` before packaging, and the copy is used only when the
//! repository's files are not there.

use std::path::Path;

fn main() {
  println!("cargo:rustc-check-cfg=cfg(vendored_native)");
  println!("cargo:rerun-if-changed=build.rs");
  let root = std::env::var("CARGO_MANIFEST_DIR").unwrap_or_else(|_| ".".into());
  let root = Path::new(&root);
  if root.join("src/native").exists() {
    println!("cargo:rerun-if-changed=src/native");
  }
  let in_repository = root.join("../api/native/src/html.rs").exists();
  let vendored = root.join("src/native/html.rs").exists();
  if !in_repository && vendored {
    println!("cargo:rustc-cfg=vendored_native");
  }
}
