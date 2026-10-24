# Step 14: Local file history

| Field        | Value       |
| ------------ | ----------- |
| Milestone    | M5.2        |
| Status       | Done        |
| Depends on   | -           |
| Requirements | REQ-HIST-03 |
| Started      | 2026-10-24  |
| Finished     | 2026-10-24  |

## Goal

Users can see earlier versions of a console and restore one, so an accidental overwrite or a
deleted query is never lost.

## Scope

- Automatic revisions of console files on save, with labels for "before run" and "before
  external change".
- A history view with a diff against the current text and Restore.
- Retention limits.

## Out of scope

- Version control integration.

## Design notes

- **Storage**: a `console_revisions` table in `app.db` (console name, created at, reason, text,
  size) or compressed files under `<app_data>/history/`. Prefer the table for atomicity with
  pruning; cap text size at the existing 16 MB console limit.
- **When**: autosave runs every 400 ms; do not create a revision per autosave. Create one when the
  text changed and at least N minutes passed since the last revision, before each run, before a
  format, and before restore.
- **Diff**: decided against Monaco's diff editor: a small line diff (`lib/diff.ts`, LCS with
  the common start and end trimmed) renders an accessible table, works in the jsdom tests and
  adds nothing to the Monaco bundle.

## Tasks

### Backend

- [x] Store migration for revisions; insert and prune.
- [x] Revision triggers in `quarry-workspace` save path (time-based, before run, before format).
- [x] Commands `revisions_list(console)`, `revision_read(id)`, `revision_restore(id)`.

### Frontend

- [x] "Local history" action on a console tab.
- [x] Revision list with time and reason; diff view; Restore (creates a revision of the current
      text first).
- [x] Settings: retention by count and age.

### Tests

- [x] Unit: autosave bursts create one revision, not hundreds.
- [x] Unit: restore is undoable (a revision of the replaced text exists).
- [x] Store: migration on empty and upgraded databases.

### Docs

- [x] Mark M5.2 done in `mvp-and-milestones.md`.

## Acceptance criteria

- [x] After deleting all text and saving, the previous text can be restored.
- [x] Revisions are pruned within the configured limits.

## Risks and open questions

- Consoles can be renamed in step 12; revisions must follow the rename (key by a stable id, not
  the file name, or migrate on rename).

## Progress log

| Date       | Note                                                                                                                                                                                                                  |
| ---------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 2026-10-24 | A save keeps the text it replaces when: the last revision is older than the interval (5 min default), the save removes more than half of the text, or the file changed outside Quarry since it last read or wrote it. |
| 2026-10-24 | Explicit revisions before a run, a format, a restore and a console delete. Repeats of the latest revision and blank text are never stored. Revisions follow a console rename.                                         |
| 2026-10-24 | Retention: 100 per console and 30 days by default (Settings), pruned on every insert.                                                                                                                                 |
