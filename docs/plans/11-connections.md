# Step 11: Connection gaps

| Field        | Value                                                                |
| ------------ | -------------------------------------------------------------------- |
| Milestone    | M4.9                                                                 |
| Status       | Not started                                                          |
| Depends on   | 02                                                                   |
| Requirements | REQ-CONN-02, 04, 06, 07, 08, 09; REQ-EXPL-02; REQ-ENV-01; REQ-ERR-06 |
| Started      | -                                                                    |
| Finished     | -                                                                    |

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

## Design notes

- **SSH**: choose a pure-Rust SSH client (candidate: `russh`) to avoid a system OpenSSH dependency.
  The tunnel is a local port forward owned by the session; when the tunnel drops, the session is
  marked lost. Host key verification is required: first connect shows the fingerprint and asks;
  accepted keys are stored in app data (not `~/.ssh/known_hosts`, unless the user opts in).
- **Secrets**: SSH passwords and key passphrases go in the keyring with the same save modes as DB
  passwords (`conn:<uuid>:ssh-password`, `ssh:<profile-uuid>:passphrase`). Key file paths are
  picked with the native dialog from Rust.
- **TLS files**: load PEM files with `rustls-pemfile`; paths chosen via the native dialog from Rust
  and stored in the profile; contents are read at connect time, not stored in `app.db`.
- **URL**: parse `postgresql://` URLs into the form fields. A password in the URL is moved to the
  keyring and stripped; "URL only" mode warns if the user insists on keeping it in the URL (or
  refuses; decide).
- **Folders**: `folders` table from ADR-0004, plus `folder_id` and `sort_order` on `connections`.
- **Schema scope**: per-connection list of selected schemas and a pattern; the explorer and the
  completion catalog only load those.

## Tasks

### Backend

- [ ] Spike: SSH crate choice, agent support on Linux/macOS/Windows; record the decision.
- [ ] Tunnel lifecycle bound to the session; lost tunnel marks the session lost.
- [ ] Host key prompt and storage.
- [ ] SSH profiles (store migration) and keyring entries for SSH secrets.
- [ ] TLS CA, client cert and key loading; errors mapped to `ConnectErrorKind` with hints.
- [ ] URL parse/format with password stripping.
- [ ] Keep-alive, auto-disconnect timer, connect timeout setting, startup SQL after connect.
- [ ] Folders and ordering (store migration).
- [ ] Schema scope applied in metadata and catalog queries.

### IPC

- [ ] Commands for SSH profiles, host key decision, folder CRUD, reorder, file pickers for keys and
      certificates; capabilities and bindings.

### Frontend

- [ ] Connection dialog tabs: General, SSH, TLS, Options, Schemas.
- [ ] URL field synced with form fields.
- [ ] Explorer: folders, drag to reorder, rename inline.
- [ ] Schema selector with checkboxes and pattern filter; "N of M" label on the connection node.
- [ ] Failure view: Test Connection button and checklist (reachability, credentials, TLS, SSH).

### Tests

- [ ] Integration: SSH tunnel to the disposable server through a disposable SSH container
      (`scripts/test-pg.sh` gains an SSH sidecar on a fixed local port).
- [ ] Integration: wrong host key is refused; wrong passphrase gives the auth category.
- [ ] Integration: verify-full with a custom CA file succeeds; client cert auth succeeds.
- [ ] Canary: no SSH secret or passphrase appears in `app.db`, logs or IPC responses.
- [ ] Unit: URL round trip, including special characters and IPv6 hosts.
- [ ] UI: schema scope limits the explorer and completion.

### Docs

- [ ] Update ADR-0003 with SSH secret naming.
- [ ] Mark M4.9 done in `mvp-and-milestones.md`; update M2.2 "Not yet".

## Acceptance criteria

- [ ] A connection through an SSH tunnel runs queries, cancels and exports like a direct one.
- [ ] No new secret type is ever written outside the keyring (canary test).
- [ ] Introspection loads only the selected schemas.

## Risks and open questions

- SSH agent on Windows (named pipe vs Pageant) may need a later follow-up.
- Cancel over a tunnel: `CancelToken` opens a new connection; it must go through the tunnel too.

## Progress log

| Date | Note |
| ---- | ---- |
