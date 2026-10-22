# Step 15: Snippets

| Field        | Value       |
| ------------ | ----------- |
| Milestone    | M5.5        |
| Status       | Not started |
| Depends on   | 10          |
| Requirements | REQ-SNIP-01 |
| Started      | -           |
| Finished     | -           |

## Goal

Users can type a short abbreviation and expand it into a SQL template with tab stops, and manage
their own snippets.

## Scope

- Built-in snippets for common PostgreSQL statements.
- User snippets: abbreviation, description, body with variables, dialect scope.
- Expansion from completion and by an expand key.
- Import/export of user snippets as JSON.

## Out of scope

- Variables computed by expressions (beyond simple ones like current date or selected text).

## Design notes

- **Format**: Monaco snippet syntax (`${1:name}`, `$0`), which Monaco expands natively through
  completion items with `insertTextRules: InsertAsSnippet`. A literal `$` in a body is escaped as
  `\$`, which matters for PostgreSQL dollar quotes and `$1` parameters.
- **Storage**: `snippets` table from ADR-0004 (store migration).
- **Expand key**: Tab after an abbreviation, registered as an editor-context action in step 10's
  registry.

## Tasks

### Backend

- [ ] Store migration for `snippets`; CRUD commands; import/export with the Rust-side dialog.

### Frontend

- [ ] Built-in snippet set (select, insert, update with where, create table, CTE, explain).
- [ ] Completion provider for snippets, scoped by dialect.
- [ ] Settings > Snippets: list, edit, add, delete, import, export.

### Tests

- [ ] Unit: dollar quotes and `$1` in bodies survive expansion.
- [ ] UI: abbreviation + Tab expands and moves through tab stops.

### Docs

- [ ] Mark M5.5 done in `mvp-and-milestones.md`.

## Acceptance criteria

- [ ] A user snippet created in Settings expands in a console without restart.
- [ ] Export then import on a fresh profile restores the same snippets.

## Risks and open questions

- Tab conflicts with completion acceptance and with indentation; resolve in the action registry.

## Progress log

| Date | Note |
| ---- | ---- |
