#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(crate) struct SuffixMatch<'a> {
  pub public_suffix: &'a str,
  pub is_icann: bool,
  pub is_private: bool,
}

fn fast_path_icann_suffix(hostname: &str) -> Option<&'static str> {
  if hostname.len() <= 3 {
    return None;
  }
  if hostname.ends_with(".com") {
    Some("com")
  } else if hostname.ends_with(".org") {
    Some("org")
  } else if hostname.ends_with(".edu") {
    Some("edu")
  } else if hostname.ends_with(".gov") {
    Some("gov")
  } else if hostname.ends_with(".net") {
    Some("net")
  } else if hostname.ends_with(".de") {
    Some("de")
  } else {
    None
  }
}

fn tail_n_labels(host: &str, label_count: usize) -> Option<&str> {
  if label_count == 0 {
    return None;
  }
  let mut remaining = label_count;
  for (dot_idx, _) in host.rmatch_indices('.') {
    remaining = remaining.checked_sub(1)?;
    if remaining == 0 {
      return host.get(dot_idx.checked_add(1)?..);
    }
  }
  if remaining == 1 { Some(host) } else { None }
}

fn last_label_fallback(hostname: &str) -> SuffixMatch<'_> {
  let suffix = match hostname.rfind('.') {
    Some(dot_idx) => hostname.get(dot_idx.saturating_add(1)..).unwrap_or(""),
    None => hostname,
  };
  SuffixMatch {
    public_suffix: suffix,
    is_icann: false,
    is_private: false,
  }
}

fn psl_lookup_unicode(hostname: &str, allow_private_domains: bool) -> SuffixMatch<'_> {
  if allow_private_domains {
    let Some(suffix) = psl::suffix(hostname.as_bytes()) else {
      return last_label_fallback(hostname);
    };
    let Ok(suffix_str) = std::str::from_utf8(suffix.as_bytes()) else {
      return last_label_fallback(hostname);
    };
    return match suffix.typ() {
      Some(psl::Type::Icann) => SuffixMatch {
        public_suffix: suffix_str,
        is_icann: true,
        is_private: false,
      },
      Some(psl::Type::Private) => SuffixMatch {
        public_suffix: suffix_str,
        is_icann: false,
        is_private: true,
      },
      None => SuffixMatch {
        public_suffix: suffix_str,
        is_icann: false,
        is_private: false,
      },
    };
  }

  let mut candidate = hostname;
  loop {
    let Some(suffix) = psl::suffix(candidate.as_bytes()) else {
      return last_label_fallback(hostname);
    };
    let Ok(suffix_str) = std::str::from_utf8(suffix.as_bytes()) else {
      return last_label_fallback(hostname);
    };
    match suffix.typ() {
      Some(psl::Type::Icann) => {
        return SuffixMatch {
          public_suffix: suffix_str,
          is_icann: true,
          is_private: false,
        };
      }
      None => {
        return SuffixMatch {
          public_suffix: suffix_str,
          is_icann: false,
          is_private: false,
        };
      }
      Some(psl::Type::Private) => match suffix_str.find('.') {
        Some(dot_idx) => {
          let Some(next) = suffix_str.get(dot_idx.saturating_add(1)..) else {
            return last_label_fallback(hostname);
          };
          candidate = next;
        }
        None => {
          return SuffixMatch {
            public_suffix: suffix_str,
            is_icann: false,
            is_private: false,
          };
        }
      },
    }
  }
}

/// Decode only lowercase `xn--` labels to Unicode so `psl` (which stores
/// Unicode PSL entries) matches punycode labels while preserving case
/// sensitivity on uppercase `XN--` inputs.
fn decode_lowercase_punycode_labels(hostname: &str) -> Option<String> {
  if !hostname.contains("xn--") {
    return None;
  }

  let mut decoded_any = false;
  let mut out = String::with_capacity(hostname.len());

  for (idx, label) in hostname.split('.').enumerate() {
    if idx > 0 {
      out.push('.');
    }
    if label.starts_with("xn--") && !label.bytes().any(|b| b.is_ascii_uppercase()) {
      let (unicode_label, res) = idna::domain_to_unicode(label);
      if res.is_ok()
        && !unicode_label.is_empty()
        && !unicode_label.contains('.')
        && unicode_label != label
      {
        out.push_str(&unicode_label);
        decoded_any = true;
        continue;
      }
    }
    out.push_str(label);
  }

  decoded_any.then_some(out)
}

/// Look up the public suffix of `hostname`, matching `tldts` suffix-trie semantics.
pub(crate) fn lookup_suffix(hostname: &str, allow_private_domains: bool) -> SuffixMatch<'_> {
  // Trailing dot produces an empty right-most label in tldts, which misses the
  // suffix trie and falls back to an empty public suffix.
  if hostname.is_empty() || hostname.ends_with('.') {
    return SuffixMatch {
      public_suffix: "",
      is_icann: false,
      is_private: false,
    };
  }

  if !allow_private_domains && let Some(fast) = fast_path_icann_suffix(hostname) {
    return SuffixMatch {
      public_suffix: fast,
      is_icann: true,
      is_private: false,
    };
  }

  if let Some(unicode_host) = decode_lowercase_punycode_labels(hostname) {
    let matched = psl_lookup_unicode(&unicode_host, allow_private_domains);
    let label_count = matched.public_suffix.split('.').count();
    if let Some(mapped) = tail_n_labels(hostname, label_count) {
      return SuffixMatch {
        public_suffix: mapped,
        is_icann: matched.is_icann,
        is_private: matched.is_private,
      };
    }
  }

  psl_lookup_unicode(hostname, allow_private_domains)
}

/// Extract the registrable domain from `hostname` given its matched `public_suffix`.
/// Mirrors `tldts-core/src/domain.ts`.
pub(crate) fn extract_domain<'a>(public_suffix: &str, hostname: &'a str) -> Option<&'a str> {
  let leading_dots = hostname.bytes().take_while(|&b| b == b'.').count();
  if public_suffix.len() == hostname.len().saturating_sub(leading_dots) {
    return None;
  }

  // Byte immediately before `public_suffix` is always an ASCII '.'.
  let prefix_end = hostname
    .len()
    .checked_sub(public_suffix.len())?
    .checked_sub(1)?;
  let before_suffix_dot = hostname.get(..prefix_end)?;
  match before_suffix_dot.rfind('.') {
    Some(dot_idx) => hostname.get(dot_idx.checked_add(1)?..),
    None => Some(hostname),
  }
}

/// Extract the subdomain portion preceding `domain` in `hostname`.
/// Mirrors `tldts-core/src/subdomain.ts`.
pub(crate) fn extract_subdomain<'a>(hostname: &'a str, domain: &str) -> &'a str {
  if domain.len() == hostname.len() {
    return "";
  }
  let end = hostname
    .len()
    .saturating_sub(domain.len())
    .saturating_sub(1);
  hostname.get(..end).unwrap_or("")
}

/// Extract the registrable label of `domain` before `public_suffix`.
/// Mirrors `tldts-core/src/domain-without-suffix.ts`.
pub(crate) fn extract_domain_without_suffix<'a>(domain: &'a str, public_suffix: &str) -> &'a str {
  let end = domain
    .len()
    .saturating_sub(public_suffix.len())
    .saturating_sub(1);
  domain.get(..end).unwrap_or("")
}
