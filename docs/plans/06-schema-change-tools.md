# Step 06: Schema change tools

| Field        | Value                                           |
| ------------ | ----------------------------------------------- |
| Milestone    | M4.5                                            |
| Status       | Done                                            |
| Depends on   | 03, 05                                          |
| Requirements | REQ-SCHEMA-01 to 07, REQ-SCHEMA-15, REQ-EXPL-16 |
| Started      | 2026-10-23                                      |
| Finished     | 2026-10-23                                      |

## Goal

Users can create, modify, drop, truncate and rename tables from forms. They always see the exact
statements first, the change applies in one transaction or not at all, and read-only and
production rules apply as strictly as in the console.

## Scope

- Create Table and Modify Table dialog with a live DDL preview.
- Drop, Truncate and Rename dialogs with statement previews.
- Transactional apply with per-statement errors.
- Staleness marking and explorer refresh after DDL.

## Out of scope

- Editing view/routine source (Later: REQ-SCHEMA-10).
- Rename refactoring across consoles (Later: REQ-SCHEMA-08).
- Safe-delete dependency analysis (Later: REQ-SCHEMA-14).

## Design notes

- **Model**: an engine-neutral `TableModel` in `db-core` (columns, PK, uniques, indexes, FKs,
  checks, comments). Step 05's catalog reading fills it for Modify Table.
- **Builders** (`crates/db-postgres/src/schema_edit.rs`): `create_table(model)` and
  `alter_table(original, edited)`, both returning `Vec<String>` statements. The diff covers add,
  drop, rename and alter column (type, default, nullability, identity), constraints and indexes.
  Type names are allow-listed or validated with `format_type`/`regtype`, as edits do today.
- **Preview**: the UI calls a pure preview command on every form change; the same builder output
  is what Apply runs (same pattern as M4.2 row edits).
- **Manual edit**: the preview can be edited as raw SQL. Once edited, regeneration stops and the
  dialog shows "edited manually"; Apply then runs that text through the normal statement classifier
  and guards.
- **Apply**: one transaction on a short-lived connection (as row edits do), so an open console
  transaction (step 03) is never mixed in. Per-statement error: "Statement N of M failed", rollback,
  dialog stays open.
- **Guards**: read-only sources block every schema tool (REQ-SCHEMA-15). Production sources confirm
  with the statements. Drop with CASCADE, or of several objects, requires typing the object name.

## Tasks

### Backend

- [x] `TableModel` and related types in `db-core`.
- [x] Load `TableModel` from the catalog (reuse step 04/05 queries).
- [x] `create_table` builder with unit tests.
- [x] `alter_table` diff builder with unit tests per change kind.
- [x] Drop builder (IF EXISTS, CASCADE; names always schema-qualified), Truncate builder
      (RESTART IDENTITY, CASCADE), Rename builders (table, column, schema).
- [x] `schema_apply(source_id, statements)` running one transaction on a short-lived connection,
      reporting the failing statement index.

### IPC

- [x] Commands `table_model`, `schema_preview` (one command over the `SchemaChange` union) and
      `schema_apply`; capabilities and bindings.

### Frontend

- [x] Table dialog: columns grid (name, type with suggestions, not null, default, identity,
      comment), PK, uniques, indexes, FKs (target as `schema.table`, column lists, ON
      DELETE/UPDATE, deferrable), checks.
- [x] Live preview pane; "edited manually" state; Reset to generated.
- [x] Modify Table opens the same dialog prefilled.
- [x] Drop dialog listing exact statements, options, typed-name confirmation when required.
- [x] Truncate dialog with options and preview.
- [x] Rename dialog with preview.
- [x] Explorer context actions: New table, Modify table, Drop, Truncate, Rename.
- [x] After apply: refresh the affected explorer nodes; mark metadata stale after DDL runs from a
      console, with a Refresh affordance.

### Tests

- [x] Integration: create a table with every column/constraint kind, then compare with the catalog.
- [x] Integration: each alter kind; a failing statement mid-script rolls back everything.
- [x] Integration: read-only source rejects apply (client and server side).
- [x] UI: drop with CASCADE cannot be confirmed without the typed name.
- [x] UI: production source requires confirmation for every schema tool (automated test per tool).
- [x] UI: manual edit stops regeneration and goes through the classifier.

### Docs

- [x] Mark M4.5 done in `mvp-and-milestones.md` (Phase 4 continues with M4.7, M4.8, M4.10).

## Acceptance criteria

- [x] No schema change runs without a preview of the exact statements and a confirm.
- [x] A failing statement leaves the database unchanged.
- [x] Every destructive or production path has an automated test proving the confirmation.
- [x] Explorer reflects the change without a manual refresh.

## Risks and open questions

- Column type changes that need `USING`: decided. The builder emits a plain `ALTER COLUMN ... TYPE`;
  when a cast needs an expression the server error names the statement, and the user adds `USING`
  through Edit SQL (which then runs through the classifier like console SQL).
- Column reorder is not supported by PostgreSQL; the dialog does not offer it.

## Deviations from the plan

- **One preview command**: `schema_preview(change)` takes a tagged `SchemaChange` union instead of
  five commands. It is a pure function on the adapter (`DatabaseAdapter::preview_schema`), so it
  needs no connection.
- **Names are always qualified** in drop, truncate and rename; there is no qualify option.
- **Identifiers are quoted only when needed** (`ident()` with a reserved keyword list), so previews
  read like hand-written SQL; type names pass a strict grammar check, and expressions (defaults,
  checks, index columns) are used as written, as the dialog says.
- **Column renames are followed** through keys, foreign keys and the PK, so renaming a column does
  not drop and recreate constraints that did not otherwise change. An unchanged model produces no
  statements (integration-tested on a real table).
- **No stale mark after a failed apply**: the apply is one transaction, so a failure changes
  nothing. Console DDL marks the source stale (a banner with Refresh).
- **Modal renders through a portal** on `document.body`. Inside the explorer the resizable panel's
  pointer handling took focus from dialog inputs.
- `SchemaChange::AlterTable` boxes its two models (clippy `large_enum_variant`); the IPC shape is
  unchanged.

## Progress log

| Date       | Note                                                                                                                                                                                               |
| ---------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 2026-10-23 | Built on a `TableModel` read from the catalog; Modify diffs the loaded model against the edited one, ordered so drops of changed constraints come before column changes and new constraints after. |
| 2026-10-23 | The explorer's resize handle took pointer focus from dialog inputs in tests; `Modal` now renders through a portal.                                                                                 |
| 2026-10-23 | Checks: 88 Rust unit, 51 PostgreSQL integration, 143 frontend unit (a production confirmation test for each of the five tools), 24 E2E.                                                            |
