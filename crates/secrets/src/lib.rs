//! Secret handling (ADR-0003). Secrets live in the OS credential store ("forever") or in process
//! memory ("until restart"); never in app.db, logs, or IPC responses.

use std::collections::HashMap;
use std::fmt;
use std::sync::Mutex;

use zeroize::Zeroizing;

/// A secret value. Zeroized on drop, redacted in `Debug`, and intentionally **not** `Serialize`, so
/// it cannot be returned to the frontend by accident. It is `Deserialize` so the UI can send one in.
#[derive(Clone, PartialEq, Eq)]
pub struct SecretString(Zeroizing<String>);

impl SecretString {
    pub fn new(value: String) -> Self {
        Self(Zeroizing::new(value))
    }

    /// Access the plaintext. Call sites should be few and obvious (driver connect, keyring write).
    pub fn expose(&self) -> &str {
        &self.0
    }
}

impl fmt::Debug for SecretString {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.write_str("SecretString(***)")
    }
}

impl<'de> serde::Deserialize<'de> for SecretString {
    fn deserialize<D: serde::Deserializer<'de>>(d: D) -> Result<Self, D::Error> {
        String::deserialize(d).map(Self::new)
    }
}

#[derive(Debug, thiserror::Error)]
pub enum SecretError {
    #[error(
        "the system credential store is unavailable ({0}); save the password \"until restart\" instead"
    )]
    Unavailable(String),
    #[error("credential store error: {0}")]
    Backend(String),
}

/// A place secrets can be kept. Implementations must make `delete` idempotent.
pub trait CredentialStore: Send + Sync {
    fn set(&self, account: &str, secret: &SecretString) -> Result<(), SecretError>;
    fn get(&self, account: &str) -> Result<Option<SecretString>, SecretError>;
    fn delete(&self, account: &str) -> Result<(), SecretError>;
}

/// OS credential store: Secret Service (Linux), Keychain (macOS), Credential Manager (Windows).
/// Calls may block (D-Bus, unlock prompts): run them off the UI thread.
pub struct KeyringStore {
    service: String,
}

impl KeyringStore {
    pub fn new(service: impl Into<String>) -> Self {
        Self {
            service: service.into(),
        }
    }

    fn entry(&self, account: &str) -> Result<keyring::Entry, SecretError> {
        keyring::Entry::new(&self.service, account).map_err(map_keyring_error)
    }
}

fn map_keyring_error(e: keyring::Error) -> SecretError {
    match e {
        keyring::Error::NoDefaultStore | keyring::Error::NoStorageAccess(_) => {
            SecretError::Unavailable(e.to_string())
        }
        other => SecretError::Backend(other.to_string()),
    }
}

impl CredentialStore for KeyringStore {
    fn set(&self, account: &str, secret: &SecretString) -> Result<(), SecretError> {
        self.entry(account)?
            .set_password(secret.expose())
            .map_err(map_keyring_error)
    }

    fn get(&self, account: &str) -> Result<Option<SecretString>, SecretError> {
        match self.entry(account)?.get_password() {
            Ok(value) => Ok(Some(SecretString::new(value))),
            Err(keyring::Error::NoEntry) => Ok(None),
            Err(e) => Err(map_keyring_error(e)),
        }
    }

    fn delete(&self, account: &str) -> Result<(), SecretError> {
        match self.entry(account)?.delete_credential() {
            Ok(()) | Err(keyring::Error::NoEntry) => Ok(()),
            Err(e) => Err(map_keyring_error(e)),
        }
    }
}

/// Process-memory store: secrets vanish when the app exits. Also the test double for the keyring.
#[derive(Default)]
pub struct MemoryStore {
    entries: Mutex<HashMap<String, SecretString>>,
}

impl MemoryStore {
    fn map(&self) -> std::sync::MutexGuard<'_, HashMap<String, SecretString>> {
        self.entries.lock().unwrap_or_else(|p| p.into_inner())
    }
}

impl CredentialStore for MemoryStore {
    fn set(&self, account: &str, secret: &SecretString) -> Result<(), SecretError> {
        self.map().insert(account.to_owned(), secret.clone());
        Ok(())
    }

    fn get(&self, account: &str) -> Result<Option<SecretString>, SecretError> {
        Ok(self.map().get(account).cloned())
    }

    fn delete(&self, account: &str) -> Result<(), SecretError> {
        self.map().remove(account);
        Ok(())
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn debug_never_shows_plaintext() {
        let s = SecretString::new("hunter2".into());
        assert_eq!(format!("{s:?}"), "SecretString(***)");
        assert_eq!(format!("{:?}", Some(&s)), "Some(SecretString(***))");
    }

    #[test]
    fn deserializes_from_a_json_string() {
        let s: SecretString = serde_json::from_str("\"pw\"").expect("decode");
        assert_eq!(s.expose(), "pw");
    }

    #[test]
    fn memory_store_set_get_delete_is_idempotent() {
        let store = MemoryStore::default();
        assert!(store.get("a").expect("get").is_none());
        store.set("a", &SecretString::new("x".into())).expect("set");
        assert_eq!(store.get("a").expect("get").expect("some").expose(), "x");
        store.delete("a").expect("delete");
        store.delete("a").expect("delete twice");
        assert!(store.get("a").expect("get").is_none());
    }

    /// Talks to the real OS credential store. Run explicitly:
    /// `cargo test -p quarry-secrets -- --ignored keyring_round_trip`
    #[test]
    #[ignore = "uses the real OS credential store"]
    fn keyring_round_trip() {
        let store = KeyringStore::new("dev.quarry.desktop.test");
        let account = format!("conn:test-{}:password", std::process::id());
        store
            .set(&account, &SecretString::new("round-trip".into()))
            .expect("set");
        assert_eq!(
            store.get(&account).expect("get").expect("some").expose(),
            "round-trip"
        );
        store.delete(&account).expect("delete");
        assert!(store.get(&account).expect("get after delete").is_none());
        store.delete(&account).expect("delete is idempotent");
    }
}
