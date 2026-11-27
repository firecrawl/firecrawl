use std::io::{self, Write};
use std::process::ExitCode;

use firecrawl_worker::nuq_prefetch;

#[cfg(target_os = "linux")]
#[global_allocator]
static ALLOCATOR: tikv_jemallocator::Jemalloc = tikv_jemallocator::Jemalloc;

const USAGE: &str = "\
Usage: firecrawl-worker <ROLE> [OPTIONS]

Roles:
  nuq-prefetch    Prefetch queued NuQ jobs

Options:
  -h, --help      Print this help message
  -V, --version   Print version information

Run 'firecrawl-worker <ROLE> --help' for role options.
";

fn main() -> ExitCode {
  let mut args = std::env::args_os().skip(1);
  let output = match args.next().as_deref() {
    Some(role) if role == "nuq-prefetch" => return nuq_prefetch::run_cli(args),
    Some(flag) if flag == "-h" || flag == "--help" => USAGE,
    Some(flag) if flag == "-V" || flag == "--version" => {
      concat!("firecrawl-worker ", env!("CARGO_PKG_VERSION"), "\n")
    }
    role => {
      let error = if role.is_none() {
        "a worker role is required"
      } else {
        "unknown worker role"
      };
      let _ = writeln!(io::stderr().lock(), "error: {error}; see --help");
      return ExitCode::from(2);
    }
  };

  let mut stdout = io::stdout().lock();
  match stdout
    .write_all(output.as_bytes())
    .and_then(|()| stdout.flush())
  {
    Ok(()) => ExitCode::SUCCESS,
    Err(err) if err.kind() == io::ErrorKind::BrokenPipe => ExitCode::SUCCESS,
    Err(err) => {
      let _ = writeln!(io::stderr().lock(), "failed to write output: {err}");
      ExitCode::FAILURE
    }
  }
}
