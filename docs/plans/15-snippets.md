# Step 15: Snippets

| Field        | Value       |
| ------------ | ----------- |
| Milestone    | M5.5        |
| Status       | Done        |
| Depends on   | 10          |
| Requirements | REQ-SNIP-01 |
| Started      | 2026-10-24  |
| Finished     | 2026-10-24  |

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

- [x] Store migration for `snippets`; CRUD commands; import/export with the Rust-side dialog.

### Frontend

- [x] Built-in snippet set (select, insert, update with where, create table, CTE, explain).
- [x] Completion provider for snippets, scoped by dialect.
- [x] Settings > Snippets: list, edit, add, delete, import, export.

### Tests

- [x] Unit: dollar quotes and `$1` in bodies survive expansion.
- [x] UI: abbreviation + Tab expands and moves through tab stops.

### Docs

- [x] Mark M5.5 done in `mvp-and-milestones.md`.

## Acceptance criteria

- [x] A user snippet created in Settings expands in a console without restart.
- [x] Export then import on a fresh profile restores the same snippets.

## Risks and open questions

- Tab conflicts with completion acceptance and with indentation; resolve in the action registry.

## Progress log

| Date       | Note                                                                                                                                                                                                                                        |
| ---------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 2026-10-24 | Tab conflict resolved in the registry: `editor.expandSnippet` (Tab) declines unless the word before the caret is an abbreviation, so Tab still indents, accepts a suggestion or moves to the next tab stop. Handlers can now decline a key. |
| 2026-10-24 | Quick suggestions are off while a snippet is filled in (`snippetsPreventQuickSuggestions`), otherwise Tab accepted a suggestion instead of moving on (seen in Chromium). Snippet completions match the abbreviation's start only.           |
| 2026-10-24 | Built-ins ship in the UI; a user snippet with the same abbreviation replaces one ("Customize"). New Monaco models default to LF line endings (Chromium chose CRLF); files that use CRLF keep it.                                            |
