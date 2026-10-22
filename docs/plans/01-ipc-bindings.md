# Step 01: Generated IPC bindings and docs alignment

| Field        | Value                                          |
| ------------ | ---------------------------------------------- |
| Milestone    | M0.1                                           |
| Status       | Not started                                    |
| Depends on   | -                                              |
| Requirements | Overview "IPC contract principles" 1; ADR-0001 |
| Started      | -                                              |
| Finished     | -                                              |

## Goal

Rust and TypeScript cannot drift: the TS types for every IPC command, event and `Channel` payload
are generated from the Rust types, and CI fails if the generated file is stale. The architecture
docs describe the code as it is, and the test suite is reliable on macOS.

## Scope

- Generate TS bindings for all 26 commands and their argument/return types, the
  `connection-status` event, and the `ExecEvent` / export progress `Channel` payloads.
- Replace hand-written types in `apps/desktop/src/ipc/types.ts`.
- Fix the unreliable explorer timing test.
- Align `docs/architecture/overview.md` with the actual crates and the TS-side SQL splitter.

## Out of scope

- New commands (each later step adds its own, using the generator from day one).
- Moving the SQL splitter/classifier to Rust (decide here, implement later if chosen).

## Design notes

- **Generator**: evaluate `tauri-specta` (v2 line, for Tauri 2) with `specta` derives. If it cannot
  express something we use (internally tagged enums with `rename_all_fields`, `Channel<T>`), fall
  back to `specta` + `specta-typescript` for types only and keep the thin hand-written `invoke`
  wrappers in `client.ts`.
- **Where derives go**: IPC types live in `crates/db-core` (`exec.rs`, `metadata.rs`, `lib.rs`),
  `crates/connections`, `crates/store` (settings, workspace), and `apps/desktop/src-tauri/src`
  (`exec.rs`, `results.rs`, `sessions.rs`, `error.rs`). Put `specta` behind a feature flag in the
  domain crates so they stay usable without it.
- **Output**: `apps/desktop/src/ipc/bindings.ts`, committed. A Rust test regenerates it into memory
  and compares with the file on disk; a mismatch fails `cargo test` with a "run the export" hint.
  An `npm run bindings` (or `cargo run --bin export-bindings`) script rewrites it.
- **Serde parity**: the M3.3 bug came from `rename_all` vs `rename_all_fields`. The existing
  Rust-side JSON contract tests stay; add one generated-vs-serialized check per tagged enum.

## Tasks

### Backend

- [ ] Spike: confirm the chosen generator handles tagged enums with `rename_all_fields`, `Option`
      fields, `Channel<T>` payloads, and `u64` (decide `number` vs `bigint` mapping).
- [ ] Add `specta` derives (feature-gated) to IPC types in `db-core`.
- [ ] Add derives to IPC types in `connections` and `store`.
- [ ] Add derives to IPC types in `src-tauri` (`ExecEvent`, `StatementError`, `JobStatus`,
      `StatusEvent`, `SessionStatus`, results and export types, `AppError`).
- [ ] Add the export entry point (test-time comparison plus a write mode).
- [ ] Add the staleness test to `cargo test --workspace`.

### IPC / Frontend

- [ ] Generate `apps/desktop/src/ipc/bindings.ts` and commit it.
- [ ] Make `ipc/types.ts` re-export generated types; delete hand-written duplicates.
- [ ] Keep `client.ts` `Backend` interface typed by the generated types.
- [ ] Type `memoryBackend.ts` against the same generated types; fix any drift it reveals.
- [ ] Add `npm run bindings` and mention it in the root README.

### Tests

- [ ] Fix `explorerTree.test.tsx` "expands a 1,000-table level within the 1 s budget": either
      measure render work only (not suite scheduling), raise the bound with a comment, or run it
      in its own Vitest project with no parallel files.
- [ ] Run the full frontend suite 5 times in a row on macOS with no failures.

### Docs

- [ ] Update `overview.md` "Repository layout (target)" to show existing crates and mark planned
      ones as planned.
- [ ] Record where the SQL splitter and classifier live (TS `lib/sql/`) in a short ADR-0006,
      including why, and whether REQ-EDIT-03 "in Rust" is dropped or deferred.
- [ ] Add a "Generated bindings" note to the IPC section of `overview.md`.

## Acceptance criteria

- [ ] No hand-written TS type duplicates a Rust IPC type.
- [ ] Changing a Rust IPC field without regenerating fails `cargo test`.
- [ ] `npm run typecheck` fails if the UI uses a field the Rust side no longer sends.
- [ ] All Rust and frontend checks in the root README pass; frontend suite passes 5 runs in a row.
- [ ] `overview.md` matches the crates in `Cargo.toml`.

## Risks and open questions

- `tauri-specta` release cadence against Tauri 2.x minor versions; pin exact versions.
- `u64` values (row counts, byte sizes) above 2^53: decide whether any can exceed it; if so,
  serialize as strings.
- Bundle/compile time impact of `specta` derives: keep them behind a feature.

## Progress log

| Date | Note |
| ---- | ---- |
