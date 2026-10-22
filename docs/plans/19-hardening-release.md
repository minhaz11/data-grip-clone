# Step 19: Hardening and release

| Field        | Value                            |
| ------------ | -------------------------------- |
| Milestone    | Phase 7                          |
| Status       | Not started                      |
| Depends on   | all                              |
| Requirements | Phase 7 in mvp-and-milestones.md |
| Started      | -                                |
| Finished     | -                                |

## Goal

The app survives real-world failures, its safety and credential claims are audited, and it ships
as signed installers for Linux, Windows and macOS with user-facing docs.

## Scope

- Fault injection tests.
- Large-result soak tests.
- Credential and execution-safety audit.
- Signed installers.
- User docs and release procedure.
- Final name (replace the "Quarry" working name).

## Out of scope

- Auto-update (decide separately; it adds a signing and hosting dependency).

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

- [ ] Fault-injection proxy in the test harness.
- [ ] Each fault scenario has an integration test with the expected UI state (lost, retry, error).
- [ ] Soak test script and a recorded baseline (memory, time per page).
- [ ] `tauri-driver` desktop smoke test on Linux (optional, if still valuable after step 02's E2E).

### Audit

- [ ] Capability and command review.
- [ ] Secret handling review (DB, SSH, AI key; keyring save modes; canary tests up to date).
- [ ] Execution safety review (classifier coverage, every confirmation path tested).
- [ ] `cargo audit` and `npm audit` clean or assessed in `docs/security/dependency-advisories.md`.
- [ ] Revisit the `freezePrototype` trade-off with the current Monaco version.

### Release

- [ ] Choose and apply the final product name and app identifier.
- [ ] Obtain a macOS Developer ID certificate and add the `APPLE_*` secrets used by step 20.
- [ ] Obtain a Windows code-signing certificate and wire it into step 20's Windows build.
- [ ] A release checklist (what to verify on each OS before announcing a release).

### Docs

- [ ] User docs: install per OS, supported databases and versions, limitations.
- [ ] Release procedure in `docs/`.
- [ ] Mark Phase 7 done in `mvp-and-milestones.md`.

## Acceptance criteria

- [ ] Every fault scenario ends in a clear, recoverable UI state with no hang and no data loss.
- [ ] Soak run shows no unbounded memory growth.
- [ ] Audit findings are fixed or recorded with a decision.
- [ ] Signed installers install and launch on a clean machine for each OS.

## Risks and open questions

- Signing certificates cost money and take time to obtain; start that early.
- WebKitGTK differences across Linux distributions; pick a supported distro list.

## Progress log

| Date | Note |
| ---- | ---- |
