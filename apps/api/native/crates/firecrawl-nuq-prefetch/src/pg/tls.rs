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

  let tls_config = match ssl_mode {
    PgSslMode::Disable | PgSslMode::Prefer | PgSslMode::Require => {
      let verifier = Arc::new(NoCertificateVerification::new(&provider));
      ClientConfig::builder_with_provider(provider)
        .with_safe_default_protocol_versions()
        .map_err(|err| PgTlsError::RustlsInit(err.to_string()))?
        .dangerous()
        .with_custom_certificate_verifier(verifier)
        .with_no_client_auth()
    }
    PgSslMode::VerifyCa => {
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
    PgSslMode::VerifyFull => {
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
      let _ = roots.add(cert);
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
  use super::*;

  #[test]
  fn builds_connectors_for_require_prefer_and_errors_on_missing_root_file() {
    assert!(build_rustls_connector(PgSslMode::Prefer, None).is_ok());
    assert!(build_rustls_connector(PgSslMode::Require, None).is_ok());
    assert!(matches!(
      build_rustls_connector(PgSslMode::VerifyFull, Some("/nonexistent/ca-bundle.pem")),
      Err(PgTlsError::ReadRootCert(_))
    ));
  }
}
