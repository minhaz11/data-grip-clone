# Release procedure

How a version of Quarry goes from `main` to installers. The pipeline itself is described in
[`plans/20-release-automation.md`](plans/20-release-automation.md).

## 1. Before the release PR is merged

- CI is green on `main` (Linux, macOS, Windows build; E2E; gitleaks).
- `cargo audit` and `npm audit` reviewed: anything new is fixed or assessed in
  [`security/dependency-advisories.md`](security/dependency-advisories.md).
- Integration and fault suites pass against the disposable server:

  ```bash
  scripts/test-pg.sh up && scripts/test-pg.sh seed
  cargo test --workspace -- --ignored
  ```

- For a release that changes how results are read, paged or exported, run the soak and compare
  with the last baseline (below):

  ```bash
  scripts/soak.sh 60 10000000
  ```

- Read the release PR's `CHANGELOG.md` section; edit it in the PR if a line is unclear.

## 2. Release

1. Merge the release PR (`chore: release vX.Y.Z`). This tags the version and starts the release
   workflow: a draft release, the three-OS build, and publishing once every build has passed.
2. If a build fails, the release stays a draft. Fix the cause on `main` if needed, re-run the
   failed job from the Actions page, and the release is published when all builds pass.

## 3. Release checklist (before announcing)

On a clean machine (or a fresh VM) per OS, with the installers from the release:

- [ ] **macOS** (Apple silicon and Intel): the `.dmg` opens; the app launches without a Gatekeeper
      block once signing is in place (until then: Control-click > Open); the window renders.
- [ ] **Windows 10 and 11**: the `.msi` and the setup `.exe` install and uninstall; the app
      launches; SmartScreen does not block a signed build.
- [ ] **Linux** (Ubuntu 22.04 and 24.04, Fedora): the AppImage runs after `chmod +x`; the `.deb`
      installs with its dependencies; the window renders.
- [ ] On each OS: add a data source to a PostgreSQL server, save the password "forever", quit and
      start again: the password comes back from the system credential store.
- [ ] On each OS: run a query, page through and export the result, open Settings, and quit with an
      open manual transaction (the app asks first).
- [ ] The version in About and in the installer file names matches the release.
- [ ] The release notes match `CHANGELOG.md`.

## Soak baseline

Recorded 2026-10-24 on macOS (Apple silicon), PostgreSQL 16 in Docker, release build,
`scripts/soak.sh 3 1000000`: 30 rounds over a 1,000,000-row result, each round paging (24 pages
of 500 rows at the start, middle and end), sorting, filtering and exporting the whole result to
CSV.

| Measure                                | Value                                                              |
| -------------------------------------- | ------------------------------------------------------------------ |
| Resident memory of the backend process | 8 to 12 MB through all rounds; 12.0 MB after warm-up, peak 12.0 MB |
| Time per page (unsorted / sorted)      | about 3 ms / 3 to 5 ms                                             |
| Export of 1,000,000 rows to CSV        | 1.1 to 3.0 s                                                       |

This covers the Rust side (sessions, cursors, export). The WebView side (the grid while
scrolling a large result) is not measured by this script; check it by hand before a release that
changes the grid.
