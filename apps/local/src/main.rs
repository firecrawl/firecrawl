use std::{net::SocketAddr, process::ExitCode, sync::Arc};

use clap::{Parser, Subcommand};
use futures::stream::{self, StreamExt};
use serde_json::{json, Value};

use firecrawl_local::{
  cloud::Cloud,
  crawl::{self, CrawlOptions, MapOptions},
  guard::NetworkPolicy,
  init::{self, InitOptions},
  login::{self, LoginSession},
  scrape::{BrowserMode, Engine, EngineConfig, ScrapeOptions},
  serve::{self, ServeConfig},
};

// DOM-heavy work allocates and frees a lot; mimalloc is markedly faster at it
// than the system allocator.
#[global_allocator]
static GLOBAL: mimalloc::MiMalloc = mimalloc::MiMalloc;

#[derive(Parser)]
#[command(
  name = "firecrawl-local",
  version,
  about = "Scrape, crawl and map the web from your own machine."
)]
struct Cli {
  /// When to use the local Chrome for JavaScript pages: auto, never or always.
  #[arg(
    long,
    global = true,
    env = "FIRECRAWL_LOCAL_BROWSER",
    default_value = "auto"
  )]
  browser: String,
  #[command(subcommand)]
  command: Command,
}

#[derive(Subcommand)]
enum Command {
  /// Scrape one or more URLs and print Firecrawl-shaped JSON.
  Scrape {
    /// One or more URLs.
    #[arg(required = true)]
    urls: Vec<String>,
    /// Comma-separated formats: markdown, html, rawHtml, links.
    #[arg(long, short = 'f', default_value = "markdown", value_delimiter = ',')]
    format: Vec<String>,
    /// Keep navigation, headers and footers instead of main content only.
    #[arg(long)]
    full_page: bool,
    /// Print only the markdown, not the JSON envelope.
    #[arg(long)]
    markdown: bool,
    /// Per-page timeout in milliseconds.
    #[arg(long, default_value_t = 30_000)]
    timeout: u64,
    /// How many URLs to fetch at once.
    #[arg(long, short = 'c', default_value_t = 16)]
    concurrency: usize,
    /// Refuse localhost and private-network targets.
    #[arg(long)]
    public_only: bool,
    /// Override the User-Agent header.
    #[arg(long, env = "FIRECRAWL_LOCAL_USER_AGENT")]
    user_agent: Option<String>,
  },
  /// Crawl a site from a start URL.
  Crawl {
    url: String,
    /// Maximum pages.
    #[arg(long, short = 'l', default_value_t = 100)]
    limit: usize,
    /// How many links deep to follow.
    #[arg(long)]
    max_depth: Option<u32>,
    /// Follow links anywhere on the site, not only under the start path.
    #[arg(long)]
    entire_domain: bool,
    /// Regex a URL path must match. Repeatable.
    #[arg(long = "include")]
    include_paths: Vec<String>,
    /// Regex that skips a URL path. Repeatable.
    #[arg(long = "exclude")]
    exclude_paths: Vec<String>,
    /// Pages fetched at once.
    #[arg(long, short = 'c')]
    concurrency: Option<usize>,
    /// Write one markdown file per page into this directory.
    #[arg(long, short = 'o')]
    out: Option<std::path::PathBuf>,
    /// Do not read robots.txt.
    #[arg(long)]
    ignore_robots: bool,
    /// Refuse localhost and private-network targets.
    #[arg(long)]
    public_only: bool,
  },
  /// List a site's URLs from its sitemaps and start page.
  Map {
    url: String,
    /// Only URLs containing this text.
    #[arg(long)]
    search: Option<String>,
    #[arg(long, short = 'l', default_value_t = 5000)]
    limit: usize,
  },
  /// Search the web through Firecrawl cloud.
  Search {
    query: String,
    #[arg(long, short = 'l', default_value_t = 5)]
    limit: u32,
  },
  /// Find Alexandria data providers on Firecrawl cloud.
  FindTools {
    /// What data you need, in plain words.
    query: String,
    #[arg(long, short = 'l', default_value_t = 10)]
    limit: u32,
  },
  /// Run an Alexandria data provider on Firecrawl cloud.
  Data {
    provider: String,
    capability: String,
    /// The capability's options as JSON.
    #[arg(long, default_value = "{}")]
    options: String,
  },
  /// Sign in to Firecrawl in the browser. One step: the key is saved for you.
  Login {
    /// Print the link instead of opening the browser.
    #[arg(long)]
    no_browser: bool,
  },
  /// Run as an MCP server over stdio, for AI agents.
  Mcp {
    /// Refuse localhost and private-network targets.
    #[arg(long)]
    public_only: bool,
  },
  /// Add Firecrawl to the AI coding tools on this machine.
  Init {
    /// Only set up this tool. Repeatable. Default: every tool found.
    #[arg(long = "agent")]
    agents: Vec<String>,
    /// Show what would change without writing anything.
    #[arg(long)]
    dry_run: bool,
  },
  /// Serve the Firecrawl HTTP API (scrape, crawl, map) on one port.
  Serve {
    #[arg(long, default_value = "127.0.0.1")]
    host: String,
    #[arg(long, short = 'p', default_value_t = 3002)]
    port: u16,
    /// Bearer token clients must send. Required when --host is not loopback.
    #[arg(long, env = "FIRECRAWL_LOCAL_TOKEN")]
    token: Option<String>,
    /// Extra hostname accepted in the Host header. Repeatable.
    #[arg(long = "allowed-host")]
    allowed_hosts: Vec<String>,
    /// Let API callers scrape localhost and private-network targets.
    #[arg(long, env = "FIRECRAWL_LOCAL_ALLOW_PRIVATE")]
    allow_private: bool,
    /// Override the User-Agent header.
    #[arg(long, env = "FIRECRAWL_LOCAL_USER_AGENT")]
    user_agent: Option<String>,
  },
}

/// Run the Firecrawl MCP server against this engine.
///
/// Firecrawl already maintains one MCP server, the `firecrawl-mcp` package,
/// and it can talk to any Firecrawl API address. So this starts the engine's
/// API on a loopback port the system picks, then runs that server pointed at
/// it, with this process's stdin and stdout handed straight through. Scrape,
/// crawl and map are answered here; everything else the server offers is
/// passed on to Firecrawl cloud.
async fn launch_mcp(engine: Arc<Engine>) -> Result<(), String> {
  let listener = tokio::net::TcpListener::bind((std::net::Ipv4Addr::LOCALHOST, 0))
    .await
    .map_err(|e| format!("could not open a local port for Firecrawl Local: {e}"))?;
  let addr = listener
    .local_addr()
    .map_err(|e| format!("could not read the local port: {e}"))?;
  let cloud = Cloud::from_env().with_surface(firecrawl_local::cloud::Surface::Mcp, None);
  // The MCP server refuses Alexandria tools by itself unless it holds a key,
  // so someone who signed in with `firecrawl-local login` needs it passed on.
  let signed_in_key = cloud.api_key();
  let cfg = ServeConfig {
    addr,
    token: None,
    allowed_hosts: Vec::new(),
    cloud,
    // The MCP server's key is the copy handed to it below, so this process
    // stays the one that decides whether a call is signed in.
    use_client_key: false,
  };
  let (stop_tx, stop_rx) = tokio::sync::oneshot::channel::<()>();
  let server = tokio::spawn(serve::serve_on(listener, engine, cfg, async move {
    let _ = stop_rx.await;
  }));

  let package = std::env::var("FIRECRAWL_MCP_PACKAGE")
    .ok()
    .filter(|p| !p.trim().is_empty())
    .unwrap_or_else(|| "firecrawl-mcp".to_string());
  let npx = if cfg!(windows) { "npx.cmd" } else { "npx" };
  let mut command = tokio::process::Command::new(npx);
  command
    .args(["-y", &package])
    .env("FIRECRAWL_API_URL", format!("http://{addr}"))
    .stdin(std::process::Stdio::inherit())
    .stdout(std::process::Stdio::inherit())
    .stderr(std::process::Stdio::inherit());
  if let Some(key) = signed_in_key {
    command.env("FIRECRAWL_API_KEY", key);
  }
  let child = command.spawn();
  let outcome = match child {
    Ok(mut child) => match child.wait().await {
      Ok(status) if status.success() => Ok(()),
      Ok(status) => Err(format!("the Firecrawl MCP server stopped ({status})")),
      Err(e) => Err(format!(
        "the Firecrawl MCP server could not be watched: {e}"
      )),
    },
    Err(e) if e.kind() == std::io::ErrorKind::NotFound => Err(
      "The MCP server needs Node.js 22 or newer, and `npx` was not found on this machine. \
       Install Node.js from https://nodejs.org and try again."
        .to_string(),
    ),
    Err(e) => Err(format!("could not start the Firecrawl MCP server: {e}")),
  };
  let _ = stop_tx.send(());
  let _ = server.await;
  outcome
}

fn main() -> ExitCode {
  let cli = Cli::parse();
  // Parsing is CPU-bound, so more blocking threads than cores only adds
  // memory: each thread keeps its own allocator heap.
  let cores = std::thread::available_parallelism()
    .map(|n| n.get())
    .unwrap_or(4);
  let runtime = match tokio::runtime::Builder::new_multi_thread()
    .enable_all()
    .max_blocking_threads(cores.max(4))
    .build()
  {
    Ok(rt) => rt,
    Err(e) => {
      eprintln!("could not start the async runtime: {e}");
      return ExitCode::FAILURE;
    }
  };
  runtime.block_on(run(cli))
}

/// Engine for a person or agent on their own machine: private targets are
/// reachable unless they ask otherwise.
fn local_engine(public_only: bool, browser: BrowserMode) -> Option<Arc<Engine>> {
  let policy = if public_only {
    NetworkPolicy::PublicOnly
  } else {
    NetworkPolicy::AllowPrivate
  };
  match Engine::new(EngineConfig {
    policy,
    user_agent: std::env::var("FIRECRAWL_LOCAL_USER_AGENT").ok(),
    browser,
  }) {
    Ok(e) => Some(Arc::new(e)),
    Err(e) => {
      eprintln!("{e}");
      None
    }
  }
}

async fn run(cli: Cli) -> ExitCode {
  let browser = match cli.browser.to_ascii_lowercase().as_str() {
    "auto" => BrowserMode::Auto,
    "never" | "off" => BrowserMode::Never,
    "always" => BrowserMode::Always,
    other => {
      eprintln!("--browser must be auto, never or always, got '{other}'");
      return ExitCode::FAILURE;
    }
  };
  match cli.command {
    Command::Scrape {
      urls,
      format,
      full_page,
      markdown,
      timeout,
      concurrency,
      public_only,
      user_agent,
    } => {
      // A person at their own terminal may scrape their own localhost.
      let policy = if public_only {
        NetworkPolicy::PublicOnly
      } else {
        NetworkPolicy::AllowPrivate
      };
      let engine = match Engine::new(EngineConfig {
        policy,
        user_agent,
        browser,
      }) {
        Ok(e) => Arc::new(e),
        Err(e) => {
          eprintln!("{e}");
          return ExitCode::FAILURE;
        }
      };
      let opts = ScrapeOptions {
        formats: format.into_iter().map(Value::String).collect(),
        only_main_content: !full_page,
        timeout: Some(timeout),
        ..Default::default()
      };

      let single = urls.len() == 1;
      let cloud = Cloud::from_env();
      let results: Vec<Value> = stream::iter(urls.into_iter().map(|url| {
        let engine = engine.clone();
        let opts = opts.clone();
        let cloud = cloud.clone();
        async move {
          match firecrawl_local::cloud::scrape_with_fallback(&engine, &cloud, &url, &opts).await {
            Ok(data) => json!({ "success": true, "data": data }),
            Err(e) => json!({ "success": false, "url": url, "code": e.code, "error": e.message }),
          }
        }
      }))
      .buffered(concurrency.max(1))
      .collect()
      .await;
      engine.shutdown().await;

      let failed = results
        .iter()
        .any(|r| r.get("success").and_then(Value::as_bool) != Some(true));

      if markdown {
        for r in &results {
          // With only the markdown on screen, a warning is the one sign that
          // an empty or short result is not the whole page.
          if let Some(warning) = r.pointer("/data/warning").and_then(Value::as_str) {
            eprintln!("warning: {warning}");
          }
          match r.pointer("/data/markdown").and_then(Value::as_str) {
            Some(md) => println!("{md}\n"),
            None => eprintln!(
              "{}",
              r.get("error")
                .and_then(Value::as_str)
                .unwrap_or("no markdown produced")
            ),
          }
        }
      } else if single {
        println!("{}", results.into_iter().next().unwrap_or(Value::Null));
      } else {
        println!("{}", Value::Array(results));
      }

      if failed {
        ExitCode::FAILURE
      } else {
        ExitCode::SUCCESS
      }
    }
    Command::Crawl {
      url,
      limit,
      max_depth,
      entire_domain,
      include_paths,
      exclude_paths,
      concurrency,
      out,
      ignore_robots,
      public_only,
    } => {
      let Some(engine) = local_engine(public_only, browser) else {
        return ExitCode::FAILURE;
      };
      let opts = CrawlOptions {
        limit,
        max_discovery_depth: max_depth,
        include_paths,
        exclude_paths,
        crawl_entire_domain: entire_domain,
        ignore_robots_txt: ignore_robots,
        max_concurrency: concurrency,
        ..Default::default()
      };
      let started = std::time::Instant::now();
      let crawled = crawl::crawl(engine.clone(), &url, &opts, |_| {}).await;
      engine.shutdown().await;
      match crawled {
        Ok(outcome) => {
          let secs = started.elapsed().as_secs_f64();
          match out {
            Some(dir) => match crawl::write_pages(&dir, &outcome.pages).await {
              Ok(index) => {
                eprintln!(
                  "{} pages in {secs:.2}s ({:.1} pages/s), {} errors, {} skipped by robots.txt, saved to {}",
                  outcome.pages.len(),
                  outcome.pages.len() as f64 / secs.max(0.001),
                  outcome.errors.len(),
                  outcome.robots_blocked.len(),
                  dir.display()
                );
                for line in index {
                  println!("{line}");
                }
              }
              Err(e) => {
                eprintln!("{e}");
                return ExitCode::FAILURE;
              }
            },
            None => {
              println!(
                "{}",
                json!({
                  "success": true,
                  "status": "completed",
                  "total": outcome.pages.len(),
                  "completed": outcome.pages.len(),
                  "creditsUsed": 0,
                  "elapsedSeconds": secs,
                  "errors": outcome.errors,
                  "robotsBlocked": outcome.robots_blocked,
                  "data": outcome.pages,
                })
              );
            }
          }
          ExitCode::SUCCESS
        }
        Err(e) => {
          eprintln!("{}", e.message);
          ExitCode::FAILURE
        }
      }
    }
    Command::Map { url, search, limit } => {
      let Some(engine) = local_engine(false, browser) else {
        return ExitCode::FAILURE;
      };
      let opts = MapOptions {
        search,
        limit,
        ..Default::default()
      };
      let mapped = crawl::map(engine.clone(), &url, &opts).await;
      engine.shutdown().await;
      match mapped {
        Ok(links) => {
          println!("{}", json!({ "success": true, "links": links }));
          ExitCode::SUCCESS
        }
        Err(e) => {
          eprintln!("{}", e.message);
          ExitCode::FAILURE
        }
      }
    }
    Command::Search { query, limit } => match Cloud::from_env().search(&query, limit).await {
      Ok(payload) => {
        println!("{payload}");
        ExitCode::SUCCESS
      }
      Err(e) => {
        eprintln!("{}", e.message);
        ExitCode::FAILURE
      }
    },
    Command::FindTools { query, limit } => {
      match Cloud::from_env()
        .find_tools(&json!({ "query": query, "limit": limit }))
        .await
      {
        Ok(payload) => {
          println!("{payload}");
          ExitCode::SUCCESS
        }
        Err(e) => {
          eprintln!("{}", e.message);
          ExitCode::FAILURE
        }
      }
    }
    Command::Data {
      provider,
      capability,
      options,
    } => {
      let options: Value = match serde_json::from_str(&options) {
        Ok(v) => v,
        Err(e) => {
          eprintln!("--options is not valid JSON: {e}");
          return ExitCode::FAILURE;
        }
      };
      let call = json!({ "provider": provider, "capability": capability, "options": options });
      match Cloud::from_env().alexandria(&call).await {
        Ok(payload) => {
          println!("{payload}");
          ExitCode::SUCCESS
        }
        Err(e) => {
          eprintln!("{}", e.message);
          ExitCode::FAILURE
        }
      }
    }
    Command::Login { no_browser } => {
      let session = match LoginSession::start() {
        Ok(s) => s,
        Err(e) => {
          eprintln!("{e}");
          return ExitCode::FAILURE;
        }
      };
      println!("Sign in to Firecrawl:");
      println!("  {}", session.url);
      if !no_browser && login::open_browser(&session.url) {
        println!("Your browser should open now. Waiting for you to finish...");
      } else {
        println!("Open that link in your browser. Waiting for you to finish...");
      }
      match session.wait(std::time::Duration::from_secs(600)).await {
        Ok(signed_in) => match login::save(&signed_in) {
          Ok(path) => {
            match &signed_in.team_name {
              Some(team) => println!("Signed in to {team}. Login saved to {}.", path.display()),
              None => println!("Signed in. Login saved to {}.", path.display()),
            }
            ExitCode::SUCCESS
          }
          Err(e) => {
            eprintln!("Signed in, but could not save the login: {e}");
            ExitCode::FAILURE
          }
        },
        Err(e) => {
          eprintln!("{e}");
          ExitCode::FAILURE
        }
      }
    }
    Command::Mcp { public_only } => {
      let Some(engine) = local_engine(public_only, browser) else {
        return ExitCode::FAILURE;
      };
      tokio::spawn(engine.clone().trim_memory_when_idle());
      let served = launch_mcp(engine.clone()).await;
      engine.shutdown().await;
      match served {
        Ok(()) => ExitCode::SUCCESS,
        Err(e) => {
          eprintln!("{e}");
          ExitCode::FAILURE
        }
      }
    }
    Command::Init { agents, dry_run } => {
      let known = init::target_names();
      if let Some(bad) = agents.iter().find(|a| !known.contains(&a.as_str())) {
        eprintln!("Unknown tool '{bad}'. Known: {}.", known.join(", "));
        return ExitCode::FAILURE;
      }
      let Some(home) = std::env::var_os("HOME").map(std::path::PathBuf::from) else {
        eprintln!("HOME is not set.");
        return ExitCode::FAILURE;
      };
      let binary = match std::env::current_exe() {
        Ok(p) => p,
        Err(e) => {
          eprintln!("could not find this binary's path: {e}");
          return ExitCode::FAILURE;
        }
      };
      let report = init::run(&InitOptions {
        only: agents,
        dry_run,
        home,
        binary: binary.clone(),
      });
      if report.lines.is_empty() {
        println!("No supported AI tool found. Known: {}.", known.join(", "));
      } else {
        println!("Firecrawl MCP server:");
        for line in &report.lines {
          println!("{line}");
        }
        // The MCP server is the firecrawl-mcp package, run through npx.
        let has_npx = std::env::var_os("PATH")
          .map(|path| {
            std::env::split_paths(&path)
              .any(|dir| dir.join("npx").exists() || dir.join("npx.cmd").exists())
          })
          .unwrap_or(false);
        if !has_npx {
          println!("  Needs Node.js 22 or newer, and `npx` was not found. Install it from https://nodejs.org.");
        }
      }
      println!();
      println!("Use it from any app:");
      println!(
        "  {} serve            # Firecrawl API on http://127.0.0.1:3002",
        binary.display()
      );
      println!("  FIRECRAWL_API_URL=http://127.0.0.1:3002   # then your existing Firecrawl SDK code runs locally");
      println!();
      println!("What goes to Firecrawl cloud:");
      println!("  - your search queries (there is no search index on a laptop)");
      println!(
        "  - the URL of a page that blocked this machine, so Firecrawl can fetch it for you"
      );
      println!("  - Alexandria data-provider calls, once you sign in");
      println!("  - a random install ID and the name of your AI tool, to count installs");
      println!(
        "Pages that load fine here are never sent. FIRECRAWL_CLOUD=search keeps only search;"
      );
      println!("FIRECRAWL_CLOUD=off turns the cloud off. FIRECRAWL_API_KEY uses your account.");
      ExitCode::SUCCESS
    }
    Command::Serve {
      host,
      port,
      token,
      allowed_hosts,
      allow_private,
      user_agent,
    } => {
      let ip: std::net::IpAddr = match host.parse() {
        Ok(ip) => ip,
        Err(_) if host == "localhost" => std::net::IpAddr::from([127, 0, 0, 1]),
        Err(_) => {
          eprintln!("--host must be an IP address, got '{host}'");
          return ExitCode::FAILURE;
        }
      };
      let policy = if allow_private {
        NetworkPolicy::AllowPrivate
      } else {
        NetworkPolicy::PublicOnly
      };
      let engine = match Engine::new(EngineConfig {
        policy,
        user_agent,
        browser,
      }) {
        Ok(e) => Arc::new(e),
        Err(e) => {
          eprintln!("{e}");
          return ExitCode::FAILURE;
        }
      };
      let cfg = ServeConfig {
        addr: SocketAddr::new(ip, port),
        token: token.filter(|t| !t.is_empty()),
        allowed_hosts,
        cloud: Cloud::from_env().with_surface(firecrawl_local::cloud::Surface::Serve, None),
        use_client_key: true,
      };
      tokio::spawn(engine.clone().trim_memory_when_idle());
      let served = serve::serve(engine.clone(), cfg).await;
      engine.shutdown().await;
      match served {
        Ok(()) => ExitCode::SUCCESS,
        Err(e) => {
          eprintln!("{e}");
          ExitCode::FAILURE
        }
      }
    }
  }
}
