# ADR-0001 — Desktop shell: Tauri 2 (over Electron)

- Status: **Accepted** (2026-10-19)
- Deciders: project owner + Claude (architect)

## Context

We are building a cross-platform (Linux, Windows, macOS) database IDE. The deciding factors, in order:

1. **Database-driver compatibility**: PostgreSQL first, then MySQL/MariaDB and SQLite, with SQL Server
   and others later.
2. **Security**: credentials, API keys, and raw DB sockets must never reach UI/renderer code.
3. **Cross-platform support**, including a dense UI with a code editor and large virtualized grids.
4. **Memory/footprint**: a developer tool runs all day next to other heavy apps.
5. **Maintainability**: one clear backend language, typed IPC, and testability.

Investigation found that DataGrip runs JDBC drivers in a **separate process** from its UI
(00-methodology, E2). We want the same isolation: the UI never holds a database connection.

## Options compared

| Criterion             | Tauri 2 (Rust backend, system WebView)                                                                                                                                                 | Electron (Node main process, bundled Chromium)                                                                                                |
| --------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------- |
| PostgreSQL            | `tokio-postgres`: async, cancellation via `CancelToken`, `DbError` exposes SQLSTATE, **position**, detail, hint; notices delivered as async messages. Excellent.                       | `pg`: mature; cancellation via `pg_cancel_backend` on a second connection; error `position` available. Excellent.                             |
| MySQL/MariaDB         | `mysql_async`: mature                                                                                                                                                                  | `mysql2`: mature, more widely used                                                                                                            |
| SQLite                | `rusqlite` (bundled SQLite, no system dependency)                                                                                                                                      | `better-sqlite3`: native addon, must be rebuilt per Electron ABI                                                                              |
| SQL Server            | `tiberius`: workable but smaller community                                                                                                                                             | `tedious`: mature                                                                                                                             |
| Oracle (later)        | `oracle` crate needs Oracle Instant Client                                                                                                                                             | `oracledb` thin mode is pure JS, no client needed                                                                                             |
| Isolation of secrets  | Natural: secrets live in the Rust process. The WebView can only call allow-listed commands (capabilities/permissions system).                                                          | Achievable with `contextIsolation` + `sandbox` + a narrow preload, but Node is in the same app and misconfiguration is a common failure mode. |
| OS credential store   | `keyring` crate (Secret Service/libsecret, macOS Keychain, Windows Credential Manager)                                                                                                 | `safeStorage` (built in) encrypts blobs. `keytar` is archived.                                                                                |
| Rendering consistency | System WebViews differ: WebView2 (Chromium), WKWebView, **WebKitGTK on Linux** (slower; known blank-window issue on some NVIDIA setups, workaround `WEBKIT_DISABLE_DMABUF_RENDERER=1`) | Identical Chromium everywhere                                                                                                                 |
| Footprint             | Installers about 5–15 MB; idle RAM roughly 2–4× lower                                                                                                                                  | Installers about 80–150 MB; Chromium + Node per app                                                                                           |
| E2E testing           | `tauri-driver` (WebDriver) on Linux/Windows only, no macOS. UI-level tests via Playwright against Vite with an IPC mock.                                                               | Playwright `_electron` on all platforms                                                                                                       |
| Team/language cost    | Two languages (Rust + TS). Rust's compile-time checks suit a security boundary.                                                                                                        | One language (TS)                                                                                                                             |
| Local env today       | Needs rustup + `build-essential`, `pkg-config`, `libwebkit2gtk-4.1-dev`, `librsvg2-dev` (not installed yet)                                                                            | Works with the installed Node 22                                                                                                              |

## Decision

Use **Tauri 2** with a **Rust backend** that owns every connection, secret, file operation, and AI
call. The frontend is React + TypeScript + Vite + Tailwind. The UI talks to the backend only through
typed Tauri commands and events, restricted by a minimal capability file.

Why Tauri wins for this product:

- **Security boundary by construction.** The WebView process cannot open sockets to the database or
  read the keyring. Only the narrow IPC surface we expose is reachable. For a tool that holds
  production credentials, this beats relying on Electron hardening flags.
- **Drivers are good enough where it matters.** PostgreSQL in Rust (`tokio-postgres`) is first class:
  it supports server-side cancellation and gives error positions and notices, all of which the SQL
  editor needs. MySQL and SQLite are also mature in Rust.
- **Footprint and startup** matter for an all-day developer tool.

## Consequences and mitigations

- **Linux WebKitGTK performance** (grid, Monaco):
  - Virtualize all large views (render only visible rows and columns).
  - Page results from the backend (never send a full result set across IPC).
  - Use a performance budget test (e.g. 100k rows × 20 cols must scroll at ≥ 50 fps in WebKitGTK).
  - Document the NVIDIA DMABUF workaround.
- **Weaker drivers for some engines** (Oracle, and to a lesser degree SQL Server): the
  `DatabaseAdapter` trait (ADR-0002) keeps the door open to an **out-of-process driver sidecar** (for
  example a Node or JVM helper over stdio JSON-RPC) for engines without a solid Rust driver, without
  changing the UI.
- **E2E on macOS**:
  - UI behaviour is covered by Playwright against the Vite build with a mocked IPC layer.
  - Real-backend E2E runs via `tauri-driver` on Linux in CI.
  - macOS gets a manual smoke checklist per release.
- **Toolchain setup** (one time) on this machine needs:
  - rustup (user-level, no sudo).
  - `sudo apt install build-essential pkg-config libwebkit2gtk-4.1-dev librsvg2-dev libxdo-dev libssl-dev`.
    `libssl-dev` is only needed if a dependency pulls in OpenSSL. We prefer `rustls`.

## Revisit if

- WebKitGTK cannot meet the grid/editor performance budget after virtualization, or
- more than one priority engine needs a non-Rust driver sidecar.
