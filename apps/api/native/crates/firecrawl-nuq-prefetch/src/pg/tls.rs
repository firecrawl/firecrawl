//! Pure-Rust `rustls` (`ring`) TLS connector for `tokio-postgres` covering all
//! five PostgreSQL `sslmode` modes without OpenSSL.

use std::sync::Arc;

use rustls::client::WebPkiServerVerifier;
use rustls::client::danger::{HandshakeSignatureValid, ServerCertVerified, ServerCertVerifier};
use rustls::crypto::{
  CryptoProvider, WebPkiSupportedAlgorithms, verify_tls12_signature, verify_tls13_signature,
};
use rustls::pki_types::pem::PemObject;
use rustls::pki_types::{CertificateDer, ServerName, UnixTime};
use rustls::{
  CertificateError, ClientConfig, DigitallySignedStruct, Error as RustlsError, RootCertStore,
  SignatureScheme,
};
use thiserror::Error;
use tokio_postgres_rustls::MakeRustlsConnect;

use crate::pg::config::PgSslMode;

/// Errors returned when constructing the PostgreSQL TLS configuration.
#[derive(Debug, Error)]
pub enum PgTlsError {
  #[error("failed to read sslrootcert PEM file: {0}")]
  ReadRootCert(String),
  #[error("no trusted CA certificates available for {0}")]
  NoRootCertificates(&'static str),
  #[error("failed to initialize rustls client config: {0}")]
  RustlsInit(String),
}

/// Builds a `MakeRustlsConnect` configured for the requested `sslmode`.
///
/// For `PgSslMode::Disable`, callers should connect with `tokio_postgres::NoTls`.
pub fn build_rustls_connector(
  ssl_mode: PgSslMode,
  ssl_root_cert: Option<&str>,
) -> Result<MakeRustlsConnect, PgTlsError> {
  firecrawl_core::telemetry::ensure_crypto_provider();
  let provider = Arc::new(rustls::crypto::ring::default_provider());

  // Match libpq: `sslmode=require` with `sslrootcert` verifies the CA chain
  // (`verify-ca`); `sslmode=no-verify` explicitly disables verification.
  let tls_config = match (ssl_mode, ssl_root_cert) {
    (PgSslMode::Disable | PgSslMode::Prefer | PgSslMode::NoVerify, _)
    | (PgSslMode::Require, None) => {
      let verifier = Arc::new(NoCertificateVerification::new(&provider));
      ClientConfig::builder_with_provider(provider)
        .with_safe_default_protocol_versions()
        .map_err(|err| PgTlsError::RustlsInit(err.to_string()))?
        .dangerous()
        .with_custom_certificate_verifier(verifier)
        .with_no_client_auth()
    }
    (PgSslMode::Require, Some(_)) | (PgSslMode::VerifyCa, _) => {
      let roots = Arc::new(load_root_store(ssl_mode, ssl_root_cert)?);
      let webpki = WebPkiServerVerifier::builder_with_provider(roots, Arc::clone(&provider))
        .build()
        .map_err(|err| PgTlsError::RustlsInit(err.to_string()))?;
      let verifier = Arc::new(VerifyCaOnlyVerifier { inner: webpki });
      ClientConfig::builder_with_provider(provider)
        .with_safe_default_protocol_versions()
        .map_err(|err| PgTlsError::RustlsInit(err.to_string()))?
        .dangerous()
        .with_custom_certificate_verifier(verifier)
        .with_no_client_auth()
    }
    (PgSslMode::VerifyFull, _) => {
      let roots = load_root_store(ssl_mode, ssl_root_cert)?;
      ClientConfig::builder_with_provider(provider)
        .with_safe_default_protocol_versions()
        .map_err(|err| PgTlsError::RustlsInit(err.to_string()))?
        .with_root_certificates(roots)
        .with_no_client_auth()
    }
  };

  Ok(MakeRustlsConnect::new(tls_config))
}

fn load_root_store(
  ssl_mode: PgSslMode,
  ssl_root_cert: Option<&str>,
) -> Result<RootCertStore, PgTlsError> {
  let mut roots = RootCertStore::empty();

  if let Some(path) = ssl_root_cert.filter(|p| *p != "system") {
    let iter = CertificateDer::pem_file_iter(path)
      .map_err(|err| PgTlsError::ReadRootCert(err.to_string()))?;
    for cert_res in iter {
      let cert = cert_res.map_err(|err| PgTlsError::ReadRootCert(err.to_string()))?;
      roots
        .add(cert)
        .map_err(|err| PgTlsError::ReadRootCert(err.to_string()))?;
    }
  } else {
    let native = rustls_native_certs::load_native_certs();
    for cert in native.certs {
      let _ = roots.add(cert);
    }
  }

  if roots.is_empty() {
    return Err(PgTlsError::NoRootCertificates(ssl_mode.as_str()));
  }

  Ok(roots)
}

/// Verifier for `sslmode=prefer` / `sslmode=require`: encrypts transport and
/// verifies TLS handshake signatures while skipping CA and hostname checks.
#[derive(Debug)]
struct NoCertificateVerification {
  supported: WebPkiSupportedAlgorithms,
}

impl NoCertificateVerification {
  fn new(provider: &CryptoProvider) -> Self {
    Self {
      supported: provider.signature_verification_algorithms,
    }
  }
}

impl ServerCertVerifier for NoCertificateVerification {
  fn verify_server_cert(
    &self,
    _end_entity: &CertificateDer<'_>,
    _intermediates: &[CertificateDer<'_>],
    _server_name: &ServerName<'_>,
    _ocsp_response: &[u8],
    _now: UnixTime,
  ) -> Result<ServerCertVerified, RustlsError> {
    Ok(ServerCertVerified::assertion())
  }

  fn verify_tls12_signature(
    &self,
    message: &[u8],
    cert: &CertificateDer<'_>,
    dss: &DigitallySignedStruct,
  ) -> Result<HandshakeSignatureValid, RustlsError> {
    verify_tls12_signature(message, cert, dss, &self.supported)
  }

  fn verify_tls13_signature(
    &self,
    message: &[u8],
    cert: &CertificateDer<'_>,
    dss: &DigitallySignedStruct,
  ) -> Result<HandshakeSignatureValid, RustlsError> {
    verify_tls13_signature(message, cert, dss, &self.supported)
  }

  fn supported_verify_schemes(&self) -> Vec<SignatureScheme> {
    self.supported.supported_schemes()
  }
}

/// Verifier for `sslmode=verify-ca`: enforces full CA chain, validity, EKU, and
/// signature verification via `WebPkiServerVerifier` while permitting hostname
/// mismatches (which `WebPkiServerVerifier` checks only after chain verification).
#[derive(Debug)]
struct VerifyCaOnlyVerifier {
  inner: Arc<WebPkiServerVerifier>,
}

impl ServerCertVerifier for VerifyCaOnlyVerifier {
  fn verify_server_cert(
    &self,
    end_entity: &CertificateDer<'_>,
    intermediates: &[CertificateDer<'_>],
    server_name: &ServerName<'_>,
    ocsp_response: &[u8],
    now: UnixTime,
  ) -> Result<ServerCertVerified, RustlsError> {
    match self
      .inner
      .verify_server_cert(end_entity, intermediates, server_name, ocsp_response, now)
    {
      Ok(verified) => Ok(verified),
      Err(RustlsError::InvalidCertificate(
        CertificateError::NotValidForName | CertificateError::NotValidForNameContext { .. },
      )) => Ok(ServerCertVerified::assertion()),
      Err(err) => Err(err),
    }
  }

  fn verify_tls12_signature(
    &self,
    message: &[u8],
    cert: &CertificateDer<'_>,
    dss: &DigitallySignedStruct,
  ) -> Result<HandshakeSignatureValid, RustlsError> {
    self.inner.verify_tls12_signature(message, cert, dss)
  }

  fn verify_tls13_signature(
    &self,
    message: &[u8],
    cert: &CertificateDer<'_>,
    dss: &DigitallySignedStruct,
  ) -> Result<HandshakeSignatureValid, RustlsError> {
    self.inner.verify_tls13_signature(message, cert, dss)
  }

  fn supported_verify_schemes(&self) -> Vec<SignatureScheme> {
    self.inner.supported_verify_schemes()
  }
}

#[cfg(test)]
mod tests {
  use std::time::Duration;

  use super::*;

  // Test-only self-signed X.509 certificates (no private keys) valid through 2126.
  const TRUSTED_CA_PEM: &[u8] = b"\
-----BEGIN CERTIFICATE-----
MIIBmzCCAUGgAwIBAgIUKdM+BaH+2fezrtNpIcSWQyT6cRowCgYIKoZIzj0EAwIw
GjEYMBYGA1UEAwwPVGVzdCBUcnVzdGVkIENBMCAXDTI2MTEyNjAzMjAzNFoYDzIx
MjYxMTAyMDMyMDM0WjAaMRgwFgYDVQQDDA9UZXN0IFRydXN0ZWQgQ0EwWTATBgcq
hkjOPQIBBggqhkjOPQMBBwNCAAQx+81O8Ro11NAwDLBAudRTfl2TXA39UE18aUE3
cWuxjRHGHKEjGf+mG/+MpgXLxpODh23/hOrlCpsK71+FqBO8o2MwYTAdBgNVHQ4E
FgQUr71TDMbvHskPK5xdvv7+e8ABUOkwHwYDVR0jBBgwFoAUr71TDMbvHskPK5xd
vv7+e8ABUOkwDwYDVR0TAQH/BAUwAwEB/zAOBgNVHQ8BAf8EBAMCAQYwCgYIKoZI
zj0EAwIDSAAwRQIgJurAjrMEGfAZ4IM8fPmYfUJjmcttvIQ4tsrXxBsfVuUCIQDu
QNPS07MPkvKwMWlKCnwW/OU10warzee+e267Ku/wZg==
-----END CERTIFICATE-----
";

  const TRUSTED_LEAF_PEM: &[u8] = b"\
-----BEGIN CERTIFICATE-----
MIIByTCCAW+gAwIBAgIUJ3nBh4jyT1gIedKCHhQDzw9eWE4wCgYIKoZIzj0EAwIw
GjEYMBYGA1UEAwwPVGVzdCBUcnVzdGVkIENBMCAXDTI2MTEyNjAzMjAzNFoYDzIx
MjYxMTAyMDMyMDM0WjAZMRcwFQYDVQQDDA5kYi5leGFtcGxlLmNvbTBZMBMGByqG
SM49AgEGCCqGSM49AwEHA0IABK2fC+3u99A0d5Q+MOCQlE9iiJvN5m1ZUF8TZouD
U6lDJ3tKUfUrPvwu4PjnXwZY2Oo1sk7rlGBzslq/zkVHhn2jgZEwgY4wDAYDVR0T
AQH/BAIwADAOBgNVHQ8BAf8EBAMCB4AwEwYDVR0lBAwwCgYIKwYBBQUHAwEwGQYD
VR0RBBIwEIIOZGIuZXhhbXBsZS5jb20wHQYDVR0OBBYEFJBQuKXNWK4v7pahSmxX
5eyntHe8MB8GA1UdIwQYMBaAFK+9UwzG7x7JDyucXb7+/nvAAVDpMAoGCCqGSM49
BAMCA0gAMEUCIQC4CchuotCyBqR5gcD+043LyEY+TFSurf4yUXdjU++WdAIgB7z1
EHRUfMjwoRFASVg/tR23RqN5y7wdGHLuNPm+yAU=
-----END CERTIFICATE-----
";

  const UNTRUSTED_LEAF_PEM: &[u8] = b"\
-----BEGIN CERTIFICATE-----
MIIByzCCAXGgAwIBAgIUKk+GshW/mw490pkpjA+2jZS4UYowCgYIKoZIzj0EAwIw
HDEaMBgGA1UEAwwRVGVzdCBVbnRydXN0ZWQgQ0EwIBcNMjYxMTI2MDMyMDM0WhgP
MjEyNjExMDIwMzIwMzRaMBkxFzAVBgNVBAMMDmRiLmV4YW1wbGUuY29tMFkwEwYH
KoZIzj0CAQYIKoZIzj0DAQcDQgAEbMiF538lYXNtXgxparkiQorJhrVyJESFHmRW
/s67LdJjuv9OxoNAFBTAkFRFnSrnqqrAtORoFFPJ0QZfmtRwpqOBkTCBjjAMBgNV
HRMBAf8EAjAAMA4GA1UdDwEB/wQEAwIHgDATBgNVHSUEDDAKBggrBgEFBQcDATAZ
BgNVHREEEjAQgg5kYi5leGFtcGxlLmNvbTAdBgNVHQ4EFgQUj9nVrFe4UGjNqcVq
iRT4EnNNoAwwHwYDVR0jBBgwFoAUVT7HUjoLEzBpv66DEILCFQWBBu4wCgYIKoZI
zj0EAwIDSAAwRQIgVJiyfSvP9Iekms7GDKcUoiCuvZB3YC4+iOxrqEx2bIUCIQD4
KU4+dXlMQIaCnGyC1/e7iGb//FQGEEdY1gKZrDH8Jw==
-----END CERTIFICATE-----
";

  fn parse_cert(pem: &[u8]) -> Option<CertificateDer<'static>> {
    CertificateDer::from_pem_slice(pem).ok()
  }

  #[test]
  fn builds_connectors_and_routes_require_with_root_cert_through_verify_ca() {
    assert!(build_rustls_connector(PgSslMode::Prefer, None).is_ok());
    assert!(build_rustls_connector(PgSslMode::Require, None).is_ok());
    assert!(build_rustls_connector(PgSslMode::NoVerify, Some("/nonexistent/ignored.pem")).is_ok());
    // `sslmode=require` with `sslrootcert` must load and verify the CA bundle.
    assert!(matches!(
      build_rustls_connector(PgSslMode::Require, Some("/nonexistent/ca-bundle.pem")),
      Err(PgTlsError::ReadRootCert(_))
    ));
    assert!(matches!(
      build_rustls_connector(PgSslMode::VerifyFull, Some("/nonexistent/ca-bundle.pem")),
      Err(PgTlsError::ReadRootCert(_))
    ));
  }

  #[test]
  fn verify_ca_and_verify_full_enforce_issuer_and_hostname_rules() {
    firecrawl_telemetry::ensure_crypto_provider();
    let provider = Arc::new(rustls::crypto::ring::default_provider());

    let ca_cert = parse_cert(TRUSTED_CA_PEM);
    let trusted_leaf = parse_cert(TRUSTED_LEAF_PEM);
    let untrusted_leaf = parse_cert(UNTRUSTED_LEAF_PEM);
    assert!(ca_cert.is_some() && trusted_leaf.is_some() && untrusted_leaf.is_some());
    let (Some(ca_cert), Some(trusted_leaf), Some(untrusted_leaf)) =
      (ca_cert, trusted_leaf, untrusted_leaf)
    else {
      return;
    };

    let mut roots = RootCertStore::empty();
    assert!(roots.add(ca_cert).is_ok());
    let webpki = WebPkiServerVerifier::builder_with_provider(Arc::new(roots), provider).build();
    assert!(webpki.is_ok());
    let Ok(webpki) = webpki else { return };

    let verify_ca = VerifyCaOnlyVerifier {
      inner: Arc::clone(&webpki),
    };
    let matching_host = ServerName::try_from("db.example.com");
    let mismatched_host = ServerName::try_from("other.example.com");
    assert!(matching_host.is_ok() && mismatched_host.is_ok());
    let (Ok(matching_host), Ok(mismatched_host)) = (matching_host, mismatched_host) else {
      return;
    };
    // 2027-01-15T08:00:00Z, well inside the 100-year validity window of the fixtures.
    let now = UnixTime::since_unix_epoch(Duration::from_secs(1_800_000_000));

    // verify-full: accepts matching host signed by trusted CA; rejects wrong host and untrusted CA.
    assert!(
      webpki
        .verify_server_cert(&trusted_leaf, &[], &matching_host, &[], now)
        .is_ok()
    );
    assert!(
      webpki
        .verify_server_cert(&trusted_leaf, &[], &mismatched_host, &[], now)
        .is_err()
    );
    assert!(
      webpki
        .verify_server_cert(&untrusted_leaf, &[], &matching_host, &[], now)
        .is_err()
    );

    // verify-ca: accepts matching and mismatched hosts signed by trusted CA; rejects untrusted CA.
    assert!(
      verify_ca
        .verify_server_cert(&trusted_leaf, &[], &matching_host, &[], now)
        .is_ok()
    );
    assert!(
      verify_ca
        .verify_server_cert(&trusted_leaf, &[], &mismatched_host, &[], now)
        .is_ok()
    );
    assert!(
      verify_ca
        .verify_server_cert(&untrusted_leaf, &[], &mismatched_host, &[], now)
        .is_err()
    );
  }

  #[test]
  fn load_root_store_propagates_invalid_cert_error_in_pem_bundle() {
    let tmp = std::env::temp_dir().join(format!("firecrawl-nuq-bad-ca-{}.pem", std::process::id()));
    let invalid_pem = "-----BEGIN CERTIFICATE-----\nAAAA\n-----END CERTIFICATE-----\n";
    let wrote = std::fs::write(&tmp, invalid_pem);
    assert!(wrote.is_ok());
    let res = load_root_store(PgSslMode::VerifyCa, tmp.to_str());
    let _ = std::fs::remove_file(&tmp);
    assert!(matches!(res, Err(PgTlsError::ReadRootCert(_))));
  }
}
