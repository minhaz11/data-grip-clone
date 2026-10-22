# Step 14: Local file history

| Field        | Value       |
| ------------ | ----------- |
| Milestone    | M5.2        |
| Status       | Not started |
| Depends on   | -           |
| Requirements | REQ-HIST-03 |
| Started      | -           |
| Finished     | -           |

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
- **Diff**: Monaco's diff editor, already bundled with the editor features (check the generated
  Monaco entry includes it; add it if not).

## Tasks

### Backend

- [ ] Store migration for revisions; insert and prune.
- [ ] Revision triggers in `quarry-workspace` save path (time-based, before run, before format).
- [ ] Commands `revisions_list(console)`, `revision_read(id)`, `revision_restore(id)`.

### Frontend

- [ ] "Local history" action on a console tab.
- [ ] Revision list with time and reason; diff view; Restore (creates a revision of the current
      text first).
- [ ] Settings: retention by count and age.

### Tests

- [ ] Unit: autosave bursts create one revision, not hundreds.
- [ ] Unit: restore is undoable (a revision of the replaced text exists).
- [ ] Store: migration on empty and upgraded databases.

### Docs

- [ ] Mark M5.2 done in `mvp-and-milestones.md`.

## Acceptance criteria

- [ ] After deleting all text and saving, the previous text can be restored.
- [ ] Revisions are pruned within the configured limits.

## Risks and open questions

- Consoles can be renamed in step 12; revisions must follow the rename (key by a stable id, not
  the file name, or migrate on rename).

## Progress log

| Date | Note |
| ---- | ---- |
