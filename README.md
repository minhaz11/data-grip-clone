# Quarry (working name)

A desktop database IDE: Tauri 2 (Rust backend) + React/TypeScript. Design docs live in [`docs/`](docs/README.md).

## Prerequisites (Linux)

- Node.js ≥ 22 and npm
- Rust (stable) via [rustup](https://rustup.rs)
- Tauri system libraries:

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

## Integration tests (disposable PostgreSQL)

```bash
scripts/test-pg.sh up                               # quarry-test-pg on 127.0.0.1:55432, TLS on, throwaway password
scripts/test-pg.sh seed                             # optional: sample "shop" schema for manual browsing
cargo test -p quarry-db-postgres -- --ignored
scripts/test-pg.sh down
```

The harness refuses any endpoint other than `127.0.0.1:55432`, so it can never touch other
databases. Credentials and the self-signed certificate live in `target/test-pg/` (gitignored).

## Layout

| Path                       | Purpose                                                |
| -------------------------- | ------------------------------------------------------ |
| `apps/desktop/src`         | React UI (`app/` shell, `features/<module>/`, `ipc/`)  |
| `apps/desktop/src-tauri`   | Tauri entry crate: IPC commands, capability allow-list |
| `crates/store`             | Local app storage (SQLite: settings, workspace state)  |
| `docs/reverse-engineering` | Evidence-tagged study of reference workflows           |
| `docs/architecture`        | Overview, ADRs, MVP and milestones                     |
