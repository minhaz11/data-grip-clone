# Step 11: Connection gaps

| Field        | Value                                                                |
| ------------ | -------------------------------------------------------------------- |
| Milestone    | M4.9                                                                 |
| Status       | Done                                                                 |
| Depends on   | 02                                                                   |
| Requirements | REQ-CONN-02, 04, 06, 07, 08, 09; REQ-EXPL-02; REQ-ENV-01; REQ-ERR-06 |
| Started      | 2026-10-24                                                           |
| Finished     | 2026-10-24                                                           |

## Goal

Users can reach databases behind a bastion (SSH tunnels) or with custom certificates, enter a
connection as a URL, organize connections in folders, and limit introspection to the schemas they
care about.

## Scope

- SSH tunnels with password, key file (with passphrase) and agent auth; reusable SSH profiles.
- TLS CA file, client certificate and client key (PEM).
- URL/DSN preview and "URL only" mode.
- Options: keep-alive, auto-disconnect, connect timeout, startup SQL.
- Rename, reorder, folders, colour inherited from folder.
- Schema scope selector ("N of M schemas").
- Failure view with Test Connection and a short checklist.

## Out of scope

- Driver-specific connection types (sockets, pgpass) and export/import of definitions (Later).
- Nested folders (one level for now), SSH jump hosts, encrypted TLS client keys.

## Design notes

- **SSH**: choose a pure-Rust SSH client (candidate: `russh`) to avoid a system OpenSSH dependency.
  The tunnel is a local port forward owned by the session; when the tunnel drops, the session is
  marked lost. Host key verification is required: first connect shows the fingerprint and asks;
  accepted keys are stored in app data (not `~/.ssh/known_hosts`, unless the user opts in).
- **Secrets**: SSH passwords and key passphrases go in the keyring with the same save modes as DB
  passwords. They belong to the SSH profile: `ssh:<profile-uuid>:password` and
  `ssh:<profile-uuid>:passphrase` (decided: a profile shared by several data sources needs one
  secret). Key file paths are picked with the native dialog from Rust.
- **TLS files**: load PEM files with `rustls-pemfile`; paths chosen via the native dialog from Rust
  and stored in the profile; contents are read at connect time, not stored in `app.db`.
- **URL**: parse `postgresql://` URLs into the form fields. A password in the URL is moved to the
  keyring and stripped. Decided: URLs never keep a password, also in "URL only" mode (it moves
  to the Password field). The URL itself is never stored (its fields are), so the parser lives
  in the UI (`features/connections/url.ts`).
- **Folders**: `folders` table from ADR-0004, plus `folder_id` and `sort_order` on `connections`.
- **Schema scope**: per-connection list of selected schemas and a pattern; the explorer and the
  completion catalog only load those.

## Tasks

### Backend

- [x] Spike: SSH crate choice, agent support on Linux/macOS/Windows; record the decision.
- [x] Tunnel lifecycle bound to the session; lost tunnel marks the session lost.
- [x] Host key prompt and storage.
- [x] SSH profiles (store migration) and keyring entries for SSH secrets.
- [x] TLS CA, client cert and key loading; errors mapped to `ConnectErrorKind` with hints.
- [x] URL parse/format with password stripping.
- [x] Keep-alive, auto-disconnect timer, connect timeout setting, startup SQL after connect.
- [x] Folders and ordering (store migration).
- [x] Schema scope applied in metadata and catalog queries.

### IPC

- [x] Commands for SSH profiles, host key decision, folder CRUD, reorder, file pickers for keys and
      certificates; capabilities and bindings.

### Frontend

- [x] Connection dialog tabs: General, SSH, TLS, Options, Schemas.
- [x] URL field synced with form fields.
- [x] Explorer: folders, drag to reorder, rename inline.
- [x] Schema selector with checkboxes and pattern filter; "N of M" label on the connection node.
- [x] Failure view: Test Connection button and checklist (reachability, credentials, TLS, SSH).

### Tests

- [x] Integration: SSH tunnel to the disposable server through a disposable SSH container
      (`scripts/test-pg.sh` gains an SSH sidecar on a fixed local port).
- [x] Integration: wrong host key is refused; wrong passphrase gives the auth category.
- [x] Integration: verify-full with a custom CA file succeeds; client cert auth succeeds.
- [x] Canary: no SSH secret or passphrase appears in `app.db`, logs or IPC responses.
- [x] Unit: URL round trip, including special characters and IPv6 hosts.
- [x] UI: schema scope limits the explorer and completion.

### Docs

- [x] Update ADR-0003 with SSH secret naming.
- [x] Mark M4.9 done in `mvp-and-milestones.md`; update M2.2 "Not yet".

## Acceptance criteria

- [x] A connection through an SSH tunnel runs queries, cancels and exports like a direct one.
- [x] No new secret type is ever written outside the keyring (canary test).
- [x] Introspection loads only the selected schemas.

## Risks and open questions

- SSH agent on Windows (named pipe vs Pageant) may need a later follow-up.
- Cancel over a tunnel: `CancelToken` opens a new connection; it must go through the tunnel too.

## Progress log

| Date       | Note                                                                                                                                                                                                                                                                                                                             |
| ---------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 2026-10-24 | Spike: `russh` 0.64 (pure Rust, `ring` like the rest of the TLS stack, no system OpenSSH). Agent: `SSH_AUTH_SOCK` on Linux/macOS (tested with a private `ssh-agent`); Windows tries the OpenSSH agent pipe, then Pageant (built, not tested on Windows).                                                                         |
| 2026-10-24 | The tunnel is `ConnectOptions::guard` plus a dial address: every session opened from the parameters (forks, DDL and edit side connections, cancel) goes through it and keeps it alive; it closes with the last one. The forward is probed at open time so an unreachable database is a clear SSH error, not a closed connection. |
| 2026-10-24 | Host keys: refused handshakes report the presented key; "Trust" sends only the fingerprint back and the backend accepts it only if it matches the key it saw. Trusted keys live in `ssh_known_hosts` (app.db).                                                                                                                   |
| 2026-10-24 | Test harness: `scripts/test-pg.sh up` now makes a test CA (server certificate for localhost and 127.0.0.1, client certificate for role `quarry_cert`, an unrelated CA) and starts `quarry-test-ssh` (Alpine sshd, fixed host key, key/passphrase/password logins) on 127.0.0.1:52222 sharing a network with the database.        |
| 2026-10-24 | Schema scope is filtered in SQL (names plus LIKE patterns from `*`/`?`); `pg_catalog` functions stay in completion. Edits reach live sessions through `Session::set_schema_scope`, so no reconnect is needed. Other option changes apply at the next connect.                                                                    |
| 2026-10-24 | Auto-disconnect checks every 30 s: idle time counts from the last session use; running statements and exports hold a busy guard, and an open transaction in any session of the source prevents it.                                                                                                                               |
