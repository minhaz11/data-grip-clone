# Quarry (working name)

A desktop database IDE: Tauri 2 (Rust backend) + React/TypeScript. Design docs live in [`docs/`](docs/README.md).

## Prerequisites

All platforms:

- Node.js 22 or newer and npm (`.nvmrc` pins 22: run `nvm use` if your default Node is older)
- Rust (stable) via [rustup](https://rustup.rs)

macOS: Xcode Command Line Tools (`xcode-select --install`). No other system libraries are needed.

Linux: the Tauri system libraries:

```bash
sudo apt install -y build-essential pkg-config libwebkit2gtk-4.1-dev libxdo-dev libssl-dev libayatana-appindicator3-dev librsvg2-dev
```

On NVIDIA proprietary drivers, if the window renders blank, run with `WEBKIT_DISABLE_DMABUF_RENDERER=1`.

## Develop

```bash
npm install
npm run tauri dev        # desktop app (Rust backend + Vite)
npm run dev              # UI only in a browser, with a non-persistent in-memory backend
```

## Checks (same as CI)

```bash
npm run format:check && npm run lint && npm run typecheck && npm test
cargo fmt --all --check && cargo clippy --workspace --all-targets -- -D warnings && cargo test --workspace
```

## UI end-to-end tests

Playwright drives the production Vite build in WebKit and Chromium, with the Rust backend replaced by
a fake IPC layer (`tests/e2e/fake-ipc.js`), and scans key screens with axe (WCAG 2.1 A/AA).

```bash
npx playwright install chromium webkit                # once
npm run test:e2e
```

## Logs

The desktop app writes a redacted, size-capped log (5 MB, 3 rotations) to the OS log directory, for
example `~/Library/Logs/dev.quarry.desktop/quarry.log` on macOS or
`~/.local/share/dev.quarry.desktop/logs/quarry.log` on Linux. Secrets are masked before writing; SQL
text and row data are never logged. Set `QUARRY_LOG=debug` (or any `tracing` filter) for more detail.

## IPC bindings

Every type that crosses IPC is generated from Rust into `apps/desktop/src/ipc/bindings.ts`. After
changing a Rust IPC type, regenerate and commit it; `cargo test` fails while it is stale.

```bash
npm run bindings
```

## Integration tests (disposable PostgreSQL)

```bash
scripts/test-pg.sh up                               # quarry-test-pg on 127.0.0.1:55432, TLS on, throwaway password
scripts/test-pg.sh seed                             # sample "shop" schema (cursor tests need it; also for browsing)
cargo test -p quarry-db-postgres -- --ignored
scripts/test-pg.sh down
```

The harness refuses any endpoint other than `127.0.0.1:55432`, so it can never touch other
databases. Credentials and the self-signed certificate live in `target/test-pg/` (gitignored).

## Releases

Releases are automated (details and one-time setup in
[`docs/plans/20-release-automation.md`](docs/plans/20-release-automation.md)):

1. Every push to `main` updates a release PR (`chore: release vX.Y.Z`, branch `release/next`) with
   the next version and a `CHANGELOG.md` section. `feat` commits bump minor, everything else bumps
   patch, and breaking changes bump major (minor while on 0.x). Run the "Release PR" workflow by hand
   to force a bump.
2. Merging that PR builds Linux, Windows and macOS installers and publishes them as a GitHub
   release. If any build fails, the release stays a draft.

```bash
npm run test:release                                # unit tests for the version script
node scripts/release/version.mjs current            # version in the app files
```

## Layout

| Path                       | Purpose                                                |
| -------------------------- | ------------------------------------------------------ |
| `apps/desktop/src`         | React UI (`app/` shell, `features/<module>/`, `ipc/`)  |
| `apps/desktop/src-tauri`   | Tauri entry crate: IPC commands, capability allow-list |
| `crates/store`             | Local app storage (SQLite: settings, workspace state)  |
| `docs/reverse-engineering` | Evidence-tagged study of reference workflows           |
| `docs/architecture`        | Overview, ADRs, MVP and milestones                     |
