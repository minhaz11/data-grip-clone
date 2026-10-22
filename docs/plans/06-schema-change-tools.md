# Step 06: Schema change tools

| Field        | Value                                           |
| ------------ | ----------------------------------------------- |
| Milestone    | M4.5                                            |
| Status       | Not started                                     |
| Depends on   | 03, 05                                          |
| Requirements | REQ-SCHEMA-01 to 07, REQ-SCHEMA-15, REQ-EXPL-16 |
| Started      | -                                               |
| Finished     | -                                               |

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

- [ ] `TableModel` and related types in `db-core`.
- [ ] Load `TableModel` from the catalog (reuse step 04/05 queries).
- [ ] `create_table` builder with unit tests.
- [ ] `alter_table` diff builder with unit tests per change kind.
- [ ] Drop builder (IF EXISTS, CASCADE, qualify auto/always/never), Truncate builder (RESTART
      IDENTITY, CASCADE), Rename builders (table, column, schema).
- [ ] `schema_apply(source_id, statements)` running one transaction on a short-lived connection,
      reporting the failing statement index.

### IPC

- [ ] Commands `schema_preview_create`, `schema_preview_alter`, `schema_preview_drop`,
      `schema_preview_truncate`, `schema_preview_rename`, `schema_apply`; capabilities and
      bindings.

### Frontend

- [ ] Table dialog: columns grid (name, type with suggestions, not null, default, identity,
      comment), PK, uniques, indexes, FKs (target picker, column pairs, ON DELETE/UPDATE,
      deferrable), checks.
- [ ] Live preview pane; "edited manually" state; Reset to generated.
- [ ] Modify Table opens the same dialog prefilled.
- [ ] Drop dialog listing exact statements, options, typed-name confirmation when required.
- [ ] Truncate dialog with options and preview.
- [ ] Rename dialog with preview.
- [ ] Explorer context actions: New table, Modify table, Drop, Truncate, Rename.
- [ ] After apply: refresh the affected explorer nodes; mark metadata stale after DDL run from a
      console or a failed apply, with a Refresh affordance.

### Tests

- [ ] Integration: create a table with every column/constraint kind, then compare with the catalog.
- [ ] Integration: each alter kind; a failing statement mid-script rolls back everything.
- [ ] Integration: read-only source rejects apply (client and server side).
- [ ] UI: drop with CASCADE cannot be confirmed without the typed name.
- [ ] UI: production source requires confirmation for every schema tool (automated test per tool).
- [ ] UI: manual edit stops regeneration and goes through the classifier.

### Docs

- [ ] Mark M4.5 (and Phase 4) done in `mvp-and-milestones.md`.

## Acceptance criteria

- [ ] No schema change runs without a preview of the exact statements and a confirm.
- [ ] A failing statement leaves the database unchanged.
- [ ] Every destructive or production path has an automated test proving the confirmation.
- [ ] Explorer reflects the change without a manual refresh.

## Risks and open questions

- Column type changes that need `USING`: offer a field for the expression, or refuse and point to
  the console? Decide.
- Column reorder is not supported by PostgreSQL; the dialog must not offer it.

## Progress log

| Date | Note |
| ---- | ---- |
