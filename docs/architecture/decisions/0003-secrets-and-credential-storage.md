# ADR-0003 — Secrets: OS credential store, backend-only

- Status: **Accepted** (2026-10-19)

## Decision

- Database passwords, SSH key passphrases, and AI API keys are stored only in the **OS credential store**
  via the Rust `keyring` crate:
  - Linux: Secret Service (gnome-keyring/KWallet via libsecret).
  - macOS: Keychain.
  - Windows: Credential Manager.
- Keyring entries are named `service = "<app-id>"`, `account = "conn:<connection-uuid>:password"` (and similar).
- Connection metadata in the local SQLite DB (ADR-0004) stores only a `secret_ref` and a `save_mode`:
  - `persist`: stored in the keyring.
  - `session`: in memory until the app quits.
  - `never`: prompt on every connect.
- **Secrets never cross IPC to the frontend.** The UI may send a secret once (on save/test) through a
  write-only command. No command ever returns a secret. Saved-password fields show
  "•••• (stored)" and a "Change…" action.
- If the keyring is unavailable (e.g. headless Linux without Secret Service), we **do not** fall back to
  plaintext. We show an actionable error and offer `session` mode only.
- Logs and diagnostics pass through a redaction layer:
  - Connection strings are rebuilt without passwords.
  - Known secret fields are replaced with `***`.
  - API keys matching `sk-ant-…`-style patterns are scrubbed.
  - Unit tests assert redaction.
- Test fixtures use throw-away credentials for a disposable Docker container. Production credentials
  never enter the repo; secret scanning (e.g. `gitleaks`) runs in CI.

## Consequences

- Linux users need a running Secret Service. Ubuntu GNOME provides gnome-keyring, which is present
  on this machine.
- Export/import of connection profiles excludes secrets by design.
