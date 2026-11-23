//! `firecrawl-local init`: add Firecrawl to every AI coding tool on this
//! machine in one command.
//!
//! Each tool keeps its MCP servers in its own config file. This finds the
//! ones that exist, backs each up, and adds a `firecrawl` entry that runs
//! `firecrawl-local mcp`. Nothing else in the file is touched.

use std::{
  fs,
  path::{Path, PathBuf},
};

use serde_json::{json, Map, Value};

pub struct InitOptions {
  /// Limit to these tools (names as in `targets()`); empty means every tool found.
  pub only: Vec<String>,
  /// Print what would change and write nothing.
  pub dry_run: bool,
  /// Home directory to look in. Tests point this at a temp directory.
  pub home: PathBuf,
  /// Path to this binary, written into each config.
  pub binary: PathBuf,
}

enum Kind {
  /// JSON file with a top-level object of servers under `key`.
  Json { key: &'static str },
  /// Codex's TOML file with `[mcp_servers.<name>]` tables.
  CodexToml,
}

struct Target {
  name: &'static str,
  label: &'static str,
  /// Path relative to the home directory.
  config: &'static str,
  /// Directory whose existence means the tool is installed.
  marker: &'static str,
  kind: Kind,
}

fn targets() -> Vec<Target> {
  vec![
    Target {
      name: "claude-code",
      label: "Claude Code",
      config: ".claude.json",
      marker: ".claude",
      kind: Kind::Json { key: "mcpServers" },
    },
    Target {
      name: "claude-desktop",
      label: "Claude desktop",
      config: "Library/Application Support/Claude/claude_desktop_config.json",
      marker: "Library/Application Support/Claude",
      kind: Kind::Json { key: "mcpServers" },
    },
    Target {
      name: "cursor",
      label: "Cursor",
      config: ".cursor/mcp.json",
      marker: ".cursor",
      kind: Kind::Json { key: "mcpServers" },
    },
    Target {
      name: "windsurf",
      label: "Windsurf",
      config: ".codeium/windsurf/mcp_config.json",
      marker: ".codeium/windsurf",
      kind: Kind::Json { key: "mcpServers" },
    },
    Target {
      name: "gemini",
      label: "Gemini CLI",
      config: ".gemini/settings.json",
      marker: ".gemini",
      kind: Kind::Json { key: "mcpServers" },
    },
    Target {
      name: "codex",
      label: "Codex",
      config: ".codex/config.toml",
      marker: ".codex",
      kind: Kind::CodexToml,
    },
  ]
}

pub fn target_names() -> Vec<&'static str> {
  targets().iter().map(|t| t.name).collect()
}

#[derive(Debug, PartialEq, Eq)]
pub enum Outcome {
  Added,
  Updated,
  AlreadySet,
}

fn backup(path: &Path) -> Result<(), String> {
  if path.exists() {
    let mut bak = path.as_os_str().to_owned();
    bak.push(".firecrawl-bak");
    fs::copy(path, PathBuf::from(bak))
      .map_err(|e| format!("could not back up {}: {e}", path.display()))?;
  }
  Ok(())
}

fn server_entry(binary: &Path) -> Value {
  json!({ "command": binary.to_string_lossy(), "args": ["mcp"] })
}

/// Merge the server entry into a JSON config, keeping every other key and
/// the file's key order.
fn merge_json(
  existing: Option<&str>,
  key: &str,
  binary: &Path,
) -> Result<(String, Outcome), String> {
  let mut root: Value = match existing {
    Some(text) if !text.trim().is_empty() => serde_json::from_str(text)
      .map_err(|e| format!("the file is not valid JSON ({e}); left untouched"))?,
    _ => Value::Object(Map::new()),
  };
  let obj = root
    .as_object_mut()
    .ok_or_else(|| "the file's top level is not a JSON object; left untouched".to_string())?;
  let servers = obj
    .entry(key.to_string())
    .or_insert_with(|| Value::Object(Map::new()));
  let servers = servers
    .as_object_mut()
    .ok_or_else(|| format!("'{key}' is not an object; left untouched"))?;
  let entry = server_entry(binary);
  let outcome = match servers.get("firecrawl") {
    Some(current) if *current == entry => Outcome::AlreadySet,
    Some(_) => Outcome::Updated,
    None => Outcome::Added,
  };
  servers.insert("firecrawl".to_string(), entry);
  let mut text = serde_json::to_string_pretty(&root).map_err(|e| e.to_string())?;
  text.push('\n');
  Ok((text, outcome))
}

fn toml_string(s: &str) -> String {
  format!("\"{}\"", s.replace('\\', "\\\\").replace('"', "\\\""))
}

/// Add or replace the `[mcp_servers.firecrawl]` table in Codex's config,
/// leaving the rest of the file byte-for-byte as it was.
fn merge_codex_toml(existing: Option<&str>, binary: &Path) -> (String, Outcome) {
  let block = format!(
    "[mcp_servers.firecrawl]\ncommand = {}\nargs = [\"mcp\"]\n",
    toml_string(&binary.to_string_lossy())
  );
  let text = existing.unwrap_or("");
  let header = "[mcp_servers.firecrawl]";
  match text.find(header) {
    Some(start) => {
      // The table runs until the next table header or the end of the file.
      let after = &text[start + header.len()..];
      let end = after
        .match_indices("\n[")
        .next()
        .map(|(i, _)| start + header.len() + i + 1)
        .unwrap_or(text.len());
      let current = &text[start..end];
      if current.trim_end() == block.trim_end() {
        return (text.to_string(), Outcome::AlreadySet);
      }
      let mut out = String::with_capacity(text.len() + block.len());
      out.push_str(&text[..start]);
      out.push_str(&block);
      if end < text.len() {
        out.push('\n');
      }
      out.push_str(&text[end..]);
      (out, Outcome::Updated)
    }
    None => {
      let mut out = text.to_string();
      if !out.is_empty() && !out.ends_with('\n') {
        out.push('\n');
      }
      if !out.is_empty() {
        out.push('\n');
      }
      out.push_str(&block);
      (out, Outcome::Added)
    }
  }
}

pub struct Report {
  pub lines: Vec<String>,
  pub configured: usize,
}

pub fn run(opts: &InitOptions) -> Report {
  let mut lines = Vec::new();
  let mut configured = 0usize;
  for target in targets() {
    if !opts.only.is_empty() && !opts.only.iter().any(|o| o == target.name) {
      continue;
    }
    let explicitly_asked = opts.only.iter().any(|o| o == target.name);
    if !explicitly_asked && !opts.home.join(target.marker).exists() {
      continue;
    }
    let path = opts.home.join(target.config);
    let existing = fs::read_to_string(&path).ok();
    let merged = match &target.kind {
      Kind::Json { key } => merge_json(existing.as_deref(), key, &opts.binary),
      Kind::CodexToml => Ok(merge_codex_toml(existing.as_deref(), &opts.binary)),
    };
    match merged {
      Err(e) => lines.push(format!(
        "  {}: skipped, {e} ({})",
        target.label,
        path.display()
      )),
      Ok((_, Outcome::AlreadySet)) => {
        configured += 1;
        lines.push(format!("  {}: already set up", target.label));
      }
      Ok((text, outcome)) => {
        let verb = if outcome == Outcome::Added {
          "added"
        } else {
          "updated"
        };
        if opts.dry_run {
          lines.push(format!(
            "  {}: would be {verb} in {}",
            target.label,
            path.display()
          ));
          continue;
        }
        let write = || -> Result<(), String> {
          if let Some(parent) = path.parent() {
            fs::create_dir_all(parent).map_err(|e| e.to_string())?;
          }
          backup(&path)?;
          fs::write(&path, &text).map_err(|e| e.to_string())
        };
        match write() {
          Ok(()) => {
            configured += 1;
            lines.push(format!("  {}: {verb} ({})", target.label, path.display()));
          }
          Err(e) => lines.push(format!(
            "  {}: could not write {} ({e})",
            target.label,
            path.display()
          )),
        }
      }
    }
  }
  Report { lines, configured }
}

#[cfg(test)]
mod tests {
  use super::*;

  fn bin() -> PathBuf {
    PathBuf::from("/usr/local/bin/firecrawl-local")
  }

  #[test]
  fn json_merge_keeps_other_servers_and_keys() {
    let existing = r#"{"theme":"dark","mcpServers":{"other":{"command":"x"}}}"#;
    let (text, outcome) = merge_json(Some(existing), "mcpServers", &bin()).unwrap();
    assert_eq!(outcome, Outcome::Added);
    let v: Value = serde_json::from_str(&text).unwrap();
    assert_eq!(v["theme"], "dark");
    assert_eq!(v["mcpServers"]["other"]["command"], "x");
    assert_eq!(v["mcpServers"]["firecrawl"]["args"][0], "mcp");
    // Key order is preserved: theme still comes first.
    assert!(text.find("theme").unwrap() < text.find("mcpServers").unwrap());

    let (_, again) = merge_json(Some(&text), "mcpServers", &bin()).unwrap();
    assert_eq!(again, Outcome::AlreadySet);
  }

  #[test]
  fn json_merge_refuses_broken_files() {
    assert!(merge_json(Some("{not json"), "mcpServers", &bin()).is_err());
    assert!(merge_json(Some("[]"), "mcpServers", &bin()).is_err());
  }

  #[test]
  fn codex_toml_append_and_replace() {
    let existing = "model = \"gpt\"\n\n[mcp_servers.other]\ncommand = \"x\"\n";
    let (text, outcome) = merge_codex_toml(Some(existing), &bin());
    assert_eq!(outcome, Outcome::Added);
    assert!(text.starts_with(existing));
    assert!(text.contains(
      "[mcp_servers.firecrawl]\ncommand = \"/usr/local/bin/firecrawl-local\"\nargs = [\"mcp\"]"
    ));

    let (again, outcome) = merge_codex_toml(Some(&text), &bin());
    assert_eq!(outcome, Outcome::AlreadySet);
    assert_eq!(again, text);

    let old =
      "[mcp_servers.firecrawl]\ncommand = \"/old/path\"\n\n[mcp_servers.other]\ncommand = \"x\"\n";
    let (replaced, outcome) = merge_codex_toml(Some(old), &bin());
    assert_eq!(outcome, Outcome::Updated);
    assert!(replaced.contains("/usr/local/bin/firecrawl-local"));
    assert!(!replaced.contains("/old/path"));
    assert!(replaced.contains("[mcp_servers.other]\ncommand = \"x\""));
  }

  #[test]
  fn run_only_touches_installed_tools_and_backs_up() {
    let home = std::env::temp_dir().join(format!("fc-init-test-{}", std::process::id()));
    let _ = fs::remove_dir_all(&home);
    fs::create_dir_all(home.join(".cursor")).unwrap();
    fs::write(
      home.join(".cursor/mcp.json"),
      r#"{"mcpServers":{"a":{"command":"b"}}}"#,
    )
    .unwrap();

    let opts = InitOptions {
      only: Vec::new(),
      dry_run: false,
      home: home.clone(),
      binary: bin(),
    };
    let report = run(&opts);
    assert_eq!(report.configured, 1, "{:?}", report.lines);
    let written: Value =
      serde_json::from_str(&fs::read_to_string(home.join(".cursor/mcp.json")).unwrap()).unwrap();
    assert_eq!(written["mcpServers"]["a"]["command"], "b");
    assert_eq!(
      written["mcpServers"]["firecrawl"]["command"],
      "/usr/local/bin/firecrawl-local"
    );
    assert!(home.join(".cursor/mcp.json.firecrawl-bak").exists());
    // Tools that are not installed get no config file.
    assert!(!home.join(".codex/config.toml").exists());
    assert!(!home.join(".claude.json").exists());
    let _ = fs::remove_dir_all(&home);
  }
}
