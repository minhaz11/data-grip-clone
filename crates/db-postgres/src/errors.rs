//! Maps driver failures to [`ConnectError`] categories with actionable hints.

use std::error::Error as _;
use std::io;
use std::time::Duration;

use quarry_db_core::{ConnectError, ConnectErrorKind as Kind, ConnectParams, DbError};

pub fn err(kind: Kind, message: impl Into<String>, hint: impl Into<String>) -> ConnectError {
    ConnectError {
        kind,
        message: message.into(),
        hint: hint.into(),
        sqlstate: None,
    }
}

/// Error from a query on an open session.
pub fn db_error(e: &tokio_postgres::Error) -> DbError {
    if e.code().is_some_and(|c| c.code() == "34000") {
        return unknown_cursor(); // invalid_cursor_name
    }
    match e.as_db_error() {
        Some(db) => DbError {
            message: db.message().to_owned(),
            detail: db.detail().map(str::to_owned),
            hint: db.hint().map(str::to_owned),
            sqlstate: Some(db.code().code().to_owned()),
            position: match db.position() {
                Some(tokio_postgres::error::ErrorPosition::Original(p)) => Some(*p),
                _ => None,
            },
            connection_lost: false,
            // query_canceled: user cancel or statement_timeout
            cancelled: db.code().code() == "57014",
        },
        None => DbError {
            message: e.to_string(),
            detail: None,
            hint: e
                .is_closed()
                .then(|| "Reconnect to the data source.".to_owned()),
            sqlstate: None,
            position: None,
            connection_lost: e.is_closed(),
            cancelled: false,
        },
    }
}

pub fn unknown_cursor() -> DbError {
    DbError {
        message: "This result is no longer available on the server.".into(),
        detail: None,
        hint: Some("Run the query again.".into()),
        sqlstate: None,
        position: None,
        connection_lost: false,
        cancelled: false,
    }
}

pub fn session_closed() -> DbError {
    DbError {
        message: "The connection is closed.".into(),
        detail: None,
        hint: Some("Reconnect to the data source.".into()),
        sqlstate: None,
        position: None,
        connection_lost: true,
        cancelled: false,
    }
}

pub fn dns(params: &ConnectParams, detail: &str) -> ConnectError {
    err(
        Kind::Dns,
        format!("Could not resolve host \"{}\" ({detail}).", params.host),
        "Check the host name, your network connection, or VPN.",
    )
}

pub fn timeout(params: &ConnectParams, after: Duration) -> ConnectError {
    err(
        Kind::Timeout,
        format!(
            "No response from {}:{} within {}s.",
            params.host,
            params.port,
            after.as_secs()
        ),
        "Check the host and port, firewalls or VPN, or increase the connect timeout.",
    )
}

pub fn tls_setup(detail: String) -> ConnectError {
    err(
        Kind::Tls,
        format!("Could not set up TLS: {detail}."),
        "Choose another SSL mode or fix the system certificate store.",
    )
}

/// Classifies a tokio-postgres error. `password_supplied` turns an auth failure without a password
/// into `PasswordRequired`, so the UI can prompt instead of showing a scary error.
pub fn classify(
    e: &tokio_postgres::Error,
    params: &ConnectParams,
    password_supplied: bool,
) -> ConnectError {
    if let Some(db) = e.as_db_error() {
        let code = db.code().code();
        let (kind, hint) = sqlstate_kind(code, params, password_supplied);
        return ConnectError {
            kind,
            message: format!("{} ({code}).", db.message().trim_end_matches('.')),
            hint,
            sqlstate: Some(code.to_owned()),
        };
    }

    // tokio-postgres refuses client-side when the server asks for a password and none is set.
    if !password_supplied && chain_mentions(e, "password missing") {
        let (kind, hint) = sqlstate_kind("28P01", params, false);
        return err(
            kind,
            format!(
                "The server requires a password for \"{}\".",
                params.username
            ),
            hint,
        );
    }

    // Walk the source chain for the underlying cause.
    let mut source = e.source();
    while let Some(cause) = source {
        if let Some(tls) = cause.downcast_ref::<rustls::Error>() {
            return tls_error(&tls.to_string(), params);
        }
        if let Some(io) = cause.downcast_ref::<io::Error>() {
            if let Some(inner) = io.get_ref().and_then(|i| i.downcast_ref::<rustls::Error>()) {
                return tls_error(&inner.to_string(), params);
            }
            return io_error(io.kind(), &io.to_string(), params);
        }
        source = cause.source();
    }

    let text = e.to_string();
    if text.contains("TLS") || text.contains("tls") {
        return tls_error(&text, params);
    }
    err(
        Kind::Other,
        format!("Connection failed: {text}."),
        "See the message above for details.",
    )
}

pub fn sqlstate_kind(
    code: &str,
    params: &ConnectParams,
    password_supplied: bool,
) -> (Kind, String) {
    match code {
        // invalid_password, invalid_authorization_specification
        "28P01" | "28000" if !password_supplied => (
            Kind::PasswordRequired,
            "Enter the password for this user.".into(),
        ),
        "28P01" | "28000" => (
            Kind::Auth,
            format!(
                "Check the user name (\"{}\") and password.",
                params.username
            ),
        ),
        "3D000" => (
            Kind::DatabaseMissing,
            format!(
                "Database \"{}\" does not exist on this server. Check the name, or connect to \"postgres\" to list databases.",
                params.database
            ),
        ),
        // too_many_connections, cannot_connect_now, admin_shutdown, crash_shutdown
        "53300" | "57P03" | "57P01" | "57P02" => (
            Kind::ServerUnavailable,
            "The server is busy, starting up, or shutting down. Try again shortly.".into(),
        ),
        _ => (Kind::Other, "See the server message above.".into()),
    }
}

fn chain_mentions(e: &tokio_postgres::Error, needle: &str) -> bool {
    let mut cause: Option<&dyn std::error::Error> = Some(e);
    while let Some(c) = cause {
        if c.to_string().contains(needle) {
            return true;
        }
        cause = c.source();
    }
    false
}

fn io_error(kind: io::ErrorKind, text: &str, params: &ConnectParams) -> ConnectError {
    let endpoint = format!("{}:{}", params.host, params.port);
    match kind {
        io::ErrorKind::ConnectionRefused => err(
            Kind::Refused,
            format!("Connection to {endpoint} was refused."),
            "Check that the server is running and listening on this host and port.",
        ),
        io::ErrorKind::TimedOut => timeout(params, params.connect_timeout),
        io::ErrorKind::ConnectionReset
        | io::ErrorKind::ConnectionAborted
        | io::ErrorKind::UnexpectedEof => err(
            Kind::Other,
            format!("{endpoint} closed the connection ({text})."),
            "The port may belong to a different service, or a proxy dropped the connection.",
        ),
        _ => err(
            Kind::Other,
            format!("Network error talking to {endpoint}: {text}."),
            "Check the host, port and network.",
        ),
    }
}

fn tls_error(detail: &str, params: &ConnectParams) -> ConnectError {
    let hint = if detail.contains("does not support TLS") || detail.contains("not support TLS") {
        "The server does not accept TLS. Use SSL mode \"Prefer\" or \"Disable\", or enable TLS on the server."
    } else if ["UnknownIssuer", "unknown issuer", "CaUsedAsEndEntity"]
        .iter()
        .any(|m| detail.contains(m))
    {
        "The certificate is not signed by a trusted authority (e.g. self-signed). Use SSL mode \"Require\" to encrypt without verification, or trust its CA."
    } else if detail.contains("NotValidForName") || detail.contains("not valid for name") {
        "The certificate does not match this host name. Use the name on the certificate, or SSL mode \"Verify CA\"."
    } else {
        "Check the server's TLS configuration or choose a different SSL mode."
    };
    err(
        Kind::Tls,
        format!(
            "TLS connection to {}:{} failed: {detail}.",
            params.host, params.port
        ),
        hint,
    )
}

#[cfg(test)]
mod tests {
    use super::*;
    use quarry_db_core::TlsMode;

    fn params() -> ConnectParams {
        ConnectParams {
            host: "db.example".into(),
            port: 5432,
            database: "orders".into(),
            username: "app".into(),
            password: None,
            tls: TlsMode::Prefer,
            connect_timeout: Duration::from_secs(3),
            read_only: false,
            application_name: "quarry".into(),
        }
    }

    #[test]
    fn auth_without_password_asks_for_one() {
        assert_eq!(
            sqlstate_kind("28P01", &params(), false).0,
            Kind::PasswordRequired
        );
        assert_eq!(sqlstate_kind("28P01", &params(), true).0, Kind::Auth);
    }

    #[test]
    fn known_sqlstates_map_to_categories() {
        let (kind, hint) = sqlstate_kind("3D000", &params(), true);
        assert_eq!(kind, Kind::DatabaseMissing);
        assert!(hint.contains("\"orders\""));
        assert_eq!(
            sqlstate_kind("53300", &params(), true).0,
            Kind::ServerUnavailable
        );
        assert_eq!(sqlstate_kind("XX000", &params(), true).0, Kind::Other);
    }

    #[test]
    fn io_kinds_map_to_categories() {
        assert_eq!(
            io_error(io::ErrorKind::ConnectionRefused, "", &params()).kind,
            Kind::Refused
        );
        assert_eq!(
            io_error(io::ErrorKind::TimedOut, "", &params()).kind,
            Kind::Timeout
        );
    }

    #[test]
    fn tls_hints_are_specific() {
        assert!(
            tls_error("server does not support TLS", &params())
                .hint
                .contains("Prefer")
        );
        assert!(
            tls_error("invalid peer certificate: UnknownIssuer", &params())
                .hint
                .contains("Require")
        );
        // openssl `req -x509` self-signed certs carry CA:TRUE and fail this way instead.
        let ca_as_leaf = "invalid peer certificate: Other(OtherError(CaUsedAsEndEntity))";
        assert!(tls_error(ca_as_leaf, &params()).hint.contains("Require"));
    }
}
