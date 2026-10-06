/// Why a request left the fire-pdf async path.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum FallbackReason {
  Http400,
  Http401,
  Http404,
  Http410,
  Http413,
  Http429,
  Http502,
  Http503,
  Http5xx,
  NetworkError,
  DeadlineTooClose,
  TerminalFailed,
  TerminalExpired,
  TerminalCancelled,
  PollingTimeout,
  Result503,
}

impl FallbackReason {
  pub fn as_str(self) -> &'static str {
    match self {
      Self::Http400 => "http_400",
      Self::Http401 => "http_401",
      Self::Http404 => "http_404",
      Self::Http410 => "http_410",
      Self::Http413 => "http_413",
      Self::Http429 => "http_429",
      Self::Http502 => "http_502",
      Self::Http503 => "http_503",
      Self::Http5xx => "http_5xx",
      Self::NetworkError => "network_error",
      Self::DeadlineTooClose => "deadline_too_close",
      Self::TerminalFailed => "terminal_failed",
      Self::TerminalExpired => "terminal_expired",
      Self::TerminalCancelled => "terminal_cancelled",
      Self::PollingTimeout => "polling_timeout",
      Self::Result503 => "result_503",
    }
  }

  pub fn is_terminal(self) -> bool {
    matches!(
      self,
      Self::TerminalFailed | Self::TerminalExpired | Self::TerminalCancelled
    )
  }
}

#[derive(Debug, thiserror::Error)]
pub enum FirePdfError {
  #[error("fire-pdf async failed: {}", .0.as_str())]
  Async(FallbackReason),

  #[error("FirePDF request failed: {0}")]
  Transport(String),

  #[error("FirePDF responded with status {0}")]
  Status(u16),

  #[error("FirePDF response does not match the expected schema: {0}")]
  Schema(String),

  #[error("{0}")]
  Contract(&'static str),

  #[error(
    "PDF ({0} bytes) exceeds the FirePDF inline ceiling and by-reference submission was unavailable"
  )]
  InlineCeiling(usize),
}
