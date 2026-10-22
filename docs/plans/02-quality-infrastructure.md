# Step 02: Quality and safety infrastructure

| Field        | Value                                                                          |
| ------------ | ------------------------------------------------------------------------------ |
| Milestone    | M0.2                                                                           |
| Status       | In progress                                                                    |
| Depends on   | -                                                                              |
| Requirements | ADR-0003 (redaction, secret scanning); REQ-ERR-12; overview "Testing strategy" |
| Started      | 2026-10-22                                                                     |
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

- [x] Add `tracing` setup in `src-tauri` (file + stderr in dev), with rotation and size cap.
- [x] Implement the redaction layer and unit tests for each redaction rule.
- [x] Log connection lifecycle and job start/finish (no SQL text by default; a debug setting may
      include SQL with literals redacted).

### CI

- [x] Add gitleaks job; confirm it passes on the current history.
- [x] Add a `macos-latest` job: frontend checks, `cargo fmt`, `clippy -D warnings`, `cargo test`.
- [x] Add a `windows-latest` job that at least builds the workspace and runs unit tests.
- [x] Add the Playwright job (Linux), uploading traces on failure.

### Frontend / E2E

- [x] Scaffold `tests/e2e` with Playwright config pointing at the Vite build.
- [x] Flow: create data source, connect, explorer expands.
- [x] Flow: run a query, see the grid, export dialog opens (export itself stays a Rust test).
- [x] Flow: destructive statement asks for confirmation; Cancel is focused.
- [x] axe scan on the main workbench, connection dialog and settings dialog.

### Docs

- [x] README: macOS prerequisites (Xcode CLT, rustup, Node 22) and `.nvmrc`.
- [x] README: how to run E2E.
- [x] Update ADR-0003 consequences: logger and scanning are now in place.

## Acceptance criteria

- [x] A unit test proves each redaction rule (password, DSN, API key pattern, deny-listed field).
- [x] A test asserts no secret from a connection create/test/connect cycle appears in the log file.
- [x] gitleaks fails on a planted test secret (verified locally with the pinned release, then
      removed) and finds nothing in the current history.
- [ ] gitleaks runs on every PR (needs the first CI run on GitHub).
- [ ] CI is green on Linux and macOS; Windows build job is green (needs the first CI run).
- [x] E2E suite has zero axe violations on the scanned screens (local: WebKit and Chromium, light
      and dark theme, 3 consecutive green runs).
- [ ] E2E suite runs green in CI (needs the first CI run).

## Risks and open questions

- macOS and Windows runners: the only test that touches the real OS keyring is `#[ignore]`d, and
  integration tests run only on Linux, so the new jobs should not need a credential store.
- The Windows job has never run; `keyring`, `rustls` and Tauri build on Windows, but this
  workspace has not been compiled there yet.
- Playwright against WebKit approximates WebKitGTK and WKWebView but is not identical.

## Progress log

| Date       | Note                                                                                                                                                                                                                                                                                                                                                                               |
| ---------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 2026-10-22 | Logger: new `quarry-logging` crate. Each event is buffered and redacted as a whole before writing (URL credentials, secret-named fields, JSON fields, `sk-ant-` keys), size-capped at 5 MB with 3 rotations, in the OS log dir. Verified by launching the app: `~/Library/Logs/dev.quarry.desktop/quarry.log`. SQL text is never logged (the optional debug-SQL idea was dropped). |
| 2026-10-22 | The log canary runs in its own test binary: a thread-local subscriber lost events because parallel tests share tracing's per-callsite interest cache.                                                                                                                                                                                                                              |
| 2026-10-22 | E2E mocks at the IPC boundary (a fake `__TAURI_INTERNALS__`, like `@tauri-apps/api/mocks`), so the real client code path runs and production code has no test hooks.                                                                                                                                                                                                               |
| 2026-10-22 | axe found real violations, all fixed: close buttons inside the editor tablist; muted, accent, danger and success text below 4.5:1 on some backgrounds in both themes; white text on the PROD badge. Text tokens are now checked against every background; badge text picks black or white by contrast.                                                                             |
| 2026-10-22 | gitleaks: CI downloads the pinned release and verifies its checksum instead of using the action (no license or token needed). Local scan of all 11 commits: no leaks.                                                                                                                                                                                                              |
