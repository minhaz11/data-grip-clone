# Step 02: Quality and safety infrastructure

| Field        | Value                                                                          |
| ------------ | ------------------------------------------------------------------------------ |
| Milestone    | M0.2                                                                           |
| Status       | Not started                                                                    |
| Depends on   | -                                                                              |
| Requirements | ADR-0003 (redaction, secret scanning); REQ-ERR-12; overview "Testing strategy" |
| Started      | -                                                                              |
| Finished     | -                                                                              |

## Goal

The safety nets the architecture promised are in place before secrets of new kinds (SSH keys, AI
API keys) and multi-step UI flows (schema tools, transactions) arrive: UI end-to-end tests, secret
scanning in CI, a redacting logger, and builds checked on macOS and Windows as well as Linux.

## Scope

- Playwright E2E against the Vite build with the in-memory backend, plus axe checks.
- gitleaks (or equivalent) in CI.
- A redacting logger in Rust, with tests.
- macOS CI job (build, clippy, unit tests, frontend checks); Windows build smoke.
- macOS setup instructions and a pinned Node version.

## Out of scope

- `tauri-driver` desktop E2E (Linux only; add in step 19 if still wanted).
- Integration tests on macOS/Windows runners (Docker availability differs; keep them on Linux).

## Design notes

- **E2E**: `tests/e2e/` with Playwright. The app already runs in a browser with a non-persistent
  in-memory backend (`npm run dev`, `ipc/memoryBackend.ts`); E2E drives that build. First flows:
  create a data source, connect, run a query, see results, edit and submit a row (memory backend
  must support what the flow needs, or the flow stops at what it supports).
- **Logger**: `tracing` + `tracing-subscriber` with a redaction layer. Redact: password fields,
  connection strings (rebuild without password), `sk-ant-...`-style keys, and any field named in a
  deny list. Log file under `<app_data>/logs/`, rotated, size-capped. No row data in logs.
- **Secret scanning**: gitleaks GitHub Action on push and PR, with an allow-list for the
  throwaway test credentials pattern in `scripts/test-pg.sh` if it trips.
- **Node**: add `.nvmrc` (22) and `engines` already says `>=22`; the README should say how to
  switch (the default Node on the main dev machine is 16).

## Tasks

### Backend

- [ ] Add `tracing` setup in `src-tauri` (file + stderr in dev), with rotation and size cap.
- [ ] Implement the redaction layer and unit tests for each redaction rule.
- [ ] Log connection lifecycle and job start/finish (no SQL text by default; a debug setting may
      include SQL with literals redacted).

### CI

- [ ] Add gitleaks job; confirm it passes on the current history.
- [ ] Add a `macos-latest` job: frontend checks, `cargo fmt`, `clippy -D warnings`, `cargo test`.
- [ ] Add a `windows-latest` job that at least builds the workspace and runs unit tests.
- [ ] Add the Playwright job (Linux), uploading traces on failure.

### Frontend / E2E

- [ ] Scaffold `tests/e2e` with Playwright config pointing at the Vite build.
- [ ] Flow: create data source, connect, explorer expands.
- [ ] Flow: run a query, see the grid, export dialog opens (export itself stays a Rust test).
- [ ] Flow: destructive statement asks for confirmation; Cancel is focused.
- [ ] axe scan on the main workbench, connection dialog and settings dialog.

### Docs

- [ ] README: macOS prerequisites (Xcode CLT, rustup, Node 22) and `.nvmrc`.
- [ ] README: how to run E2E.
- [ ] Update ADR-0003 consequences: logger and scanning are now in place.

## Acceptance criteria

- [ ] A unit test proves each redaction rule (password, DSN, API key pattern, deny-listed field).
- [ ] A test asserts no secret from a connection create/test/connect cycle appears in the log file.
- [ ] gitleaks runs on every PR and fails on a planted test secret (verified once, then removed).
- [ ] CI is green on Linux and macOS; Windows build job is green.
- [ ] E2E suite runs in CI with zero axe violations on the scanned screens.

## Risks and open questions

- macOS runners lack Secret Service; keyring tests must use the memory store or the macOS
  Keychain. Check which tests touch the real keyring.
- Playwright against WebKit approximates WebKitGTK and WKWebView but is not identical.

## Progress log

| Date | Note |
| ---- | ---- |
