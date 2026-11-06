# Step 19: Hardening and release

| Field        | Value                            |
| ------------ | -------------------------------- |
| Milestone    | Phase 7                          |
| Status       | In progress                      |
| Depends on   | all                              |
| Requirements | Phase 7 in mvp-and-milestones.md |
| Started      | 2026-10-24                       |
| Finished     | -                                |

## Goal

The app survives real-world failures, its safety and credential claims are audited, and it ships
as installers for Linux, Windows and macOS with user-facing docs. Installers are unsigned for
now (see Out of scope).

## Scope

- Fault injection tests.
- Large-result soak tests.
- Credential and execution-safety audit.
- Installers (unsigned for now).
- User docs and release procedure.
- Final name: "Quarry" stays (identifier `dev.quarry.desktop`).

## Out of scope

- Code signing (Apple Developer ID with notarization, Windows code-signing certificate): not
  needed for now (decided 2026-11-05). Until it is added, macOS Gatekeeper and Windows SmartScreen
  warn on first launch; the user guide explains how to open the app anyway.
- Auto-update (decide separately; it adds a signing and hosting dependency).
- A `tauri-driver` desktop smoke test: tauri-driver has no macOS support, and the Playwright
  suite (real UI, fake IPC) plus the Rust integration and fault suites cover the same ground;
  the release checklist covers the real app on each OS.

## Design notes

- **Fault injection**: put a TCP proxy between tests and the disposable server (for example a
  small Rust proxy in the test harness, or Toxiproxy in a container) that can drop, delay or reset
  connections on command. Scenarios: drop mid-query, drop mid-page fetch, drop during export,
  server restart, permission denied mid-script, SSH tunnel drop.
- **Soak**: 1M and 10M row results scrolled, sorted, filtered and exported repeatedly for an hour;
  track RSS of both processes and handle counts.
- **Audit**: a checklist walk-through of every command in `capabilities/default.json`, every place a
  secret is handled, every path that runs SQL, and every confirmation; record findings in
  `docs/security/`.
- **Installers**: the build and publish pipeline is step 20. This step adds the signing
  certificates (macOS Developer ID and notarization, Windows code signing) as CI secrets and
  verifies the signed result on clean machines.

## Tasks

### Tests

- [x] Fault-injection proxy in the test harness.
- [x] Each fault scenario has an integration test with the expected UI state (lost, retry, error).
- [x] Soak test script and a recorded baseline (memory, time per page).

### Audit

- [x] Capability and command review.
- [x] Secret handling review (DB, SSH, AI key; keyring save modes; canary tests up to date).
- [x] Execution safety review (classifier coverage, every confirmation path tested).
- [x] `cargo audit` and `npm audit` clean or assessed in `docs/security/dependency-advisories.md`.
- [x] Revisit the `freezePrototype` trade-off with the current Monaco version.

### Release

- [x] Choose and apply the final product name and app identifier: "Quarry" and
      `dev.quarry.desktop`, already applied.
- [x] A release checklist (what to verify on each OS before announcing a release).

### Docs

- [x] User docs: install per OS, supported databases and versions, limitations.
- [x] Release procedure in `docs/`.
- [ ] Mark Phase 7 done in `mvp-and-milestones.md`.

## Acceptance criteria

- [x] Every fault scenario ends in a clear, recoverable UI state with no hang and no data loss.
- [ ] Soak run shows no unbounded memory growth.
- [x] Audit findings are fixed or recorded with a decision.
- [ ] Installers install and launch on a clean machine for each OS (unsigned for now).

## Risks and open questions

- Unsigned installers: Gatekeeper and SmartScreen warnings may put some users off until signing
  is added.
- WebKitGTK differences across Linux distributions; pick a supported distro list.

## Progress log

| Date       | Note                                                                                                                                                                                                                                                                                                                                                                                                                                                 |
| ---------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 2026-10-24 | Fault injection: `crates/db-postgres/tests/fault_pg.rs` with a TCP proxy (`tests/support/fault_proxy.rs`) that drops, stalls, refuses and resumes. Six scenarios pass (drop mid-query, between pages, during export; server restart; silent network; permission denied mid-script); the SSH tunnel drop was already covered in `ssh_pg.rs`.                                                                                                          |
| 2026-10-24 | Soak: `scripts/soak.sh` runs `soak_pg.rs` (page, sort, filter, export a large result in rounds, sampling resident memory). Baseline in `docs/release-procedure.md`: 3 minutes, 1M rows, 30 rounds, memory flat at 8 to 12 MB. This measures the backend process; the WebView process during a long scroll is still to be measured by hand on the real app, so the soak criterion stays open.                                                         |
| 2026-10-24 | Audit recorded in `docs/security/audit-2026-10.md`; no blocking findings (file paths in data source drafts and UI-side confirmations accepted with reasons; read-only is enforced by the server). `cargo audit`: `rustls-webpki` updated to 0.103.16 for RUSTSEC-2026-0382; the rest assessed. `npm audit`: five DOMPurify advisories in Monaco's vendored copy, none reachable. `freezePrototype` stays off (Monaco 0.57 still assigns `toString`). |
| 2026-10-24 | Waiting on decisions and accounts outside the code: the final product name and app identifier, an Apple Developer ID (and notarization secrets), a Windows code-signing certificate, and installs on clean machines per OS.                                                                                                                                                                                                                          |
| 2026-11-05 | Decisions: the name stays "Quarry" (`dev.quarry.desktop`), and code signing is out of scope for now, so the certificate tasks moved to Out of scope and the clean-machine check is for unsigned installers.                                                                                                                                                                                                                                          |
