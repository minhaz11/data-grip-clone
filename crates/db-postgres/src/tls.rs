//! rustls configuration per [`TlsMode`], following libpq semantics.

use std::path::Path;
use std::sync::Arc;

use quarry_db_core::{TlsFiles, TlsMode};
use rustls::client::WebPkiServerVerifier;
use rustls::client::danger::{HandshakeSignatureValid, ServerCertVerified, ServerCertVerifier};
use rustls::crypto::{CryptoProvider, verify_tls12_signature, verify_tls13_signature};
use rustls::pki_types::pem::PemObject;
use rustls::pki_types::{CertificateDer, PrivateKeyDer, ServerName, UnixTime};
use rustls::{
    CertificateError, ClientConfig, DigitallySignedStruct, RootCertStore, SignatureScheme,
};

pub fn provider() -> Arc<CryptoProvider> {
    Arc::new(rustls::crypto::ring::default_provider())
}

/// Why a TLS configuration could not be built; `file` names the PEM file at fault.
#[derive(Debug)]
pub struct SetupError {
    pub message: String,
    pub file: Option<String>,
}

impl SetupError {
    fn plain(message: impl Into<String>) -> Self {
        Self {
            message: message.into(),
            file: None,
        }
    }

    fn file(path: &Path, message: impl std::fmt::Display) -> Self {
        Self {
            message: format!("{}: {message}", path.display()),
            file: Some(path.display().to_string()),
        }
    }
}

/// Builds the TLS client config for a mode and optional PEM files. `Disable` never reaches TLS,
/// but gets a valid config because tokio-postgres always wants a connector. As in libpq, a CA file
/// makes `Require` verify the chain (like `VerifyCa`).
pub fn client_config(mode: TlsMode, files: &TlsFiles) -> Result<ClientConfig, SetupError> {
    let provider = provider();
    let builder = ClientConfig::builder_with_provider(Arc::clone(&provider))
        .with_safe_default_protocol_versions()
        .map_err(|e| SetupError::plain(e.to_string()))?;
    let roots = || match &files.ca {
        Some(path) => ca_roots(path),
        None => native_roots(),
    };
    let verifier: Arc<dyn ServerCertVerifier> = match mode {
        TlsMode::Require if files.ca.is_some() => {
            Arc::new(IgnoreHostName(webpki(roots()?, provider)?))
        }
        TlsMode::Disable | TlsMode::Prefer | TlsMode::Require => {
            Arc::new(AcceptAnyCertificate(provider))
        }
        TlsMode::VerifyCa => Arc::new(IgnoreHostName(webpki(roots()?, provider)?)),
        TlsMode::VerifyFull => webpki(roots()?, provider)?,
    };
    let builder = builder
        .dangerous()
        .with_custom_certificate_verifier(verifier);
    match (&files.cert, &files.key) {
        (None, None) => Ok(builder.with_no_client_auth()),
        (Some(cert), Some(key)) => {
            let chain = read_certs(cert)?;
            let key_der = read_key(key)?;
            builder
                .with_client_auth_cert(chain, key_der)
                .map_err(|e| SetupError::file(key, format!("does not match the certificate ({e})")))
        }
        (Some(_), None) => Err(SetupError::plain(
            "a client certificate needs its private key file too",
        )),
        (None, Some(_)) => Err(SetupError::plain(
            "a client key needs its certificate file too",
        )),
    }
}

fn read(path: &Path) -> Result<Vec<u8>, SetupError> {
    std::fs::read(path).map_err(|e| SetupError::file(path, format!("cannot be read ({e})")))
}

fn read_certs(path: &Path) -> Result<Vec<CertificateDer<'static>>, SetupError> {
    let pem = read(path)?;
    let certs = CertificateDer::pem_slice_iter(&pem)
        .collect::<Result<Vec<_>, _>>()
        .map_err(|e| SetupError::file(path, format!("is not a PEM certificate file ({e})")))?;
    if certs.is_empty() {
        return Err(SetupError::file(path, "contains no PEM certificate"));
    }
    Ok(certs)
}

fn read_key(path: &Path) -> Result<PrivateKeyDer<'static>, SetupError> {
    let pem = read(path)?;
    PrivateKeyDer::from_pem_slice(&pem).map_err(|e| {
        SetupError::file(
            path,
            format!("is not an unencrypted PEM private key (PKCS#8, PKCS#1 or SEC1) ({e})"),
        )
    })
}

fn ca_roots(path: &Path) -> Result<RootCertStore, SetupError> {
    let mut roots = RootCertStore::empty();
    let (added, _) = roots.add_parsable_certificates(read_certs(path)?);
    if added == 0 {
        return Err(SetupError::file(path, "contains no usable CA certificate"));
    }
    Ok(roots)
}

fn native_roots() -> Result<RootCertStore, SetupError> {
    let native = rustls_native_certs::load_native_certs();
    let mut roots = RootCertStore::empty();
    roots.add_parsable_certificates(native.certs);
    if roots.is_empty() {
        return Err(SetupError::plain(
            "no trusted root certificates were found on this system",
        ));
    }
    Ok(roots)
}

fn webpki(
    roots: RootCertStore,
    provider: Arc<CryptoProvider>,
) -> Result<Arc<WebPkiServerVerifier>, SetupError> {
    WebPkiServerVerifier::builder_with_provider(Arc::new(roots), provider)
        .build()
        .map_err(|e| SetupError::plain(e.to_string()))
}

/// `require`/`prefer`: encrypt, but do not authenticate the server (libpq behaviour).
/// Handshake signatures are still checked so the session key is bound to the presented cert.
#[derive(Debug)]
struct AcceptAnyCertificate(Arc<CryptoProvider>);

impl ServerCertVerifier for AcceptAnyCertificate {
    fn verify_server_cert(
        &self,
        _end_entity: &CertificateDer<'_>,
        _intermediates: &[CertificateDer<'_>],
        _server_name: &ServerName<'_>,
        _ocsp_response: &[u8],
        _now: UnixTime,
    ) -> Result<ServerCertVerified, rustls::Error> {
        Ok(ServerCertVerified::assertion())
    }

    fn verify_tls12_signature(
        &self,
        message: &[u8],
        cert: &CertificateDer<'_>,
        dss: &DigitallySignedStruct,
    ) -> Result<HandshakeSignatureValid, rustls::Error> {
        verify_tls12_signature(
            message,
            cert,
            dss,
            &self.0.signature_verification_algorithms,
        )
    }

    fn verify_tls13_signature(
        &self,
        message: &[u8],
        cert: &CertificateDer<'_>,
        dss: &DigitallySignedStruct,
    ) -> Result<HandshakeSignatureValid, rustls::Error> {
        verify_tls13_signature(
            message,
            cert,
            dss,
            &self.0.signature_verification_algorithms,
        )
    }

    fn supported_verify_schemes(&self) -> Vec<SignatureScheme> {
        self.0.signature_verification_algorithms.supported_schemes()
    }
}

/// `verify-ca`: the chain must lead to a trusted root; the host name is not checked.
#[derive(Debug)]
struct IgnoreHostName(Arc<WebPkiServerVerifier>);

impl ServerCertVerifier for IgnoreHostName {
    fn verify_server_cert(
        &self,
        end_entity: &CertificateDer<'_>,
        intermediates: &[CertificateDer<'_>],
        server_name: &ServerName<'_>,
        ocsp_response: &[u8],
        now: UnixTime,
    ) -> Result<ServerCertVerified, rustls::Error> {
        match self
            .0
            .verify_server_cert(end_entity, intermediates, server_name, ocsp_response, now)
        {
            Err(rustls::Error::InvalidCertificate(
                CertificateError::NotValidForName | CertificateError::NotValidForNameContext { .. },
            )) => Ok(ServerCertVerified::assertion()),
            other => other,
        }
    }

    fn verify_tls12_signature(
        &self,
        message: &[u8],
        cert: &CertificateDer<'_>,
        dss: &DigitallySignedStruct,
    ) -> Result<HandshakeSignatureValid, rustls::Error> {
        self.0.verify_tls12_signature(message, cert, dss)
    }

    fn verify_tls13_signature(
        &self,
        message: &[u8],
        cert: &CertificateDer<'_>,
        dss: &DigitallySignedStruct,
    ) -> Result<HandshakeSignatureValid, rustls::Error> {
        self.0.verify_tls13_signature(message, cert, dss)
    }

    fn supported_verify_schemes(&self) -> Vec<SignatureScheme> {
        self.0.supported_verify_schemes()
    }
}
