# Step 01: Generated IPC bindings and docs alignment

| Field        | Value                                          |
| ------------ | ---------------------------------------------- |
| Milestone    | M0.1                                           |
| Status       | Done                                           |
| Depends on   | -                                              |
| Requirements | Overview "IPC contract principles" 1; ADR-0001 |
| Started      | 2026-10-22                                     |
| Finished     | 2026-10-22                                     |

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
- Moving the SQL splitter/classifier to Rust (decided: deferred, see ADR-0006).

## Design notes (as built)

- **Generator: `ts-rs` 12.0.1**, types only. `tauri-specta` is still a release candidate
  (2.0.0-rc.26) and `specta` 2.0.0-rc.27 refuses `u64`/`usize` without per-field overrides. `ts-rs`
  is stable, reads the same serde attributes (`tag`, `rename_all`, `rename_all_fields`, `flatten`,
  `skip_serializing_if`), and maps large ints globally with `Config::with_large_int("number")`. The
  `invoke` wrappers in `client.ts` stay hand-written, guarded by the command-list test below.
- **Derives**: `#[cfg_attr(feature = "ts", derive(ts_rs::TS))]` in `db-core`, `store` and
  `connections` (optional `ts` feature), and `#[cfg_attr(test, derive(ts_rs::TS))]` in `src-tauri`.
  The desktop crate's dev-dependencies turn the `ts` features on, so release builds carry no `ts-rs`.
- **Omitted fields**: `skip_serializing_if` fields also carry `ts(optional)` so they generate as
  `field?: T` (what the JSON actually does), not `field: T | null`.
- **Output**: `apps/desktop/src/ipc/bindings.ts`, committed, excluded from Prettier and ESLint.
  `src-tauri/src/bindings.rs` renders it in a test, which fails with an "is stale" message when
  the file differs. `npm run bindings` rewrites it (`UPDATE_BINDINGS=1`).
- **Command names**: a second test checks that `build.rs`, `capabilities/default.json`,
  `generate_handler!` in `lib.rs`, and the `invoke('...')` names in `ipc/client.ts` list exactly the
  same commands.
- **UI-owned types** stay in `types.ts`: `WorkspaceState` and its tab types (Rust stores the
  workspace as an opaque JSON blob), `DEFAULT_SETTINGS`, and the `Cell` alias.
- **Serde parity**: generated types come from the same serde attributes, so the M3.3 class of bug
  (`rename_all` vs `rename_all_fields`) now shows up as a type error. The Rust JSON contract tests
  stay.

## Tasks

### Backend

- [x] Spike: confirm the chosen generator handles tagged enums with `rename_all_fields`, `Option`
      fields, `Channel<T>` payloads, and `u64` (decide `number` vs `bigint` mapping).
- [x] Add derives (feature-gated) to IPC types in `db-core`.
- [x] Add derives to IPC types in `connections` and `store`.
- [x] Add derives to IPC types in `src-tauri` (`ExecEvent`, `StatementError`, `JobStatus`,
      `StatusEvent`, `SessionStatus`, results and export types, `AppError`).
- [x] Add the export entry point (test-time comparison plus a write mode).
- [x] Add the staleness test to `cargo test --workspace`.

### IPC / Frontend

- [x] Generate `apps/desktop/src/ipc/bindings.ts` and commit it.
- [x] Make `ipc/types.ts` re-export generated types; delete hand-written duplicates.
- [x] Keep `client.ts` `Backend` interface typed by the generated types.
- [x] Type `memoryBackend.ts` against the same generated types; fix any drift it reveals.
- [x] Add `npm run bindings` and mention it in the root README.

### Tests

- [x] Fix `explorerTree.test.tsx` "expands a 1,000-table level within the 1 s budget": either
      measure render work only (not suite scheduling), raise the bound with a comment, or run it
      in its own Vitest project with no parallel files.
- [x] Run the full frontend suite 5 times in a row on macOS with no failures.

### Docs

- [x] Update `overview.md` "Repository layout (target)" to show existing crates and mark planned
      ones as planned.
- [x] Record where the SQL splitter and classifier live (TS `lib/sql/`) in a short ADR-0006,
      including why, and whether REQ-EDIT-03 "in Rust" is dropped or deferred.
- [x] Add a "Generated bindings" note to the IPC section of `overview.md`.

## Acceptance criteria

- [x] No hand-written TS type duplicates a Rust IPC type.
- [x] Changing a Rust IPC field without regenerating fails `cargo test`.
- [x] `npm run typecheck` fails if the UI uses a field the Rust side no longer sends.
- [x] All Rust and frontend checks in the root README pass; frontend suite passes 5 runs in a row.
- [x] `overview.md` matches the crates in `Cargo.toml`.

## Risks and open questions

- `u64` as `number`: row counts, byte sizes and milliseconds stay far below 2^53. If a field could
  exceed it, serialize it as a string and override its TS type.
- `ts-rs` emits types without Prettier formatting; the file is ignored by Prettier and ESLint.

## Progress log

| Date       | Note                                                                                                                                                                                                                                                                                                                                            |
| ---------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 2026-10-22 | Chose `ts-rs` over `tauri-specta` (RC) and `specta` (RC, no global u64 mapping) after a spike against our serde shapes.                                                                                                                                                                                                                         |
| 2026-10-22 | Generating types caught real drift: a test fixture omitted `StatementError.detail`, which Rust always sends.                                                                                                                                                                                                                                    |
| 2026-10-22 | Timing test: wall-clock budgets cannot be reliable inside a parallel suite (load average 15 to 31 on this Mac). It now waits on the store instead of polling the DOM, and runs in a `perf` Vitest project after the `unit` project, one file at a time; the default test timeout is 20 s for jsdom UI flows. Five consecutive full runs passed. |
| 2026-10-22 | Found while verifying: CI never ran `scripts/test-pg.sh seed`, which the cursor integration tests need. Added the step; all 34 integration tests pass against the disposable server.                                                                                                                                                            |
| 2026-10-22 | Found while writing ADR-0006: read-only sources allow `SET default_transaction_read_only = off`. Added as the first task of step 03.                                                                                                                                                                                                            |
