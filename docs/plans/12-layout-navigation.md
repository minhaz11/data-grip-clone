# Step 12: Layout, navigation and explorer

| Field        | Value                                                                                             |
| ------------ | ------------------------------------------------------------------------------------------------- |
| Milestone    | M4.10                                                                                             |
| Status       | Done                                                                                              |
| Depends on   | 05, 10                                                                                            |
| Requirements | REQ-LAYOUT-02, 04, 06; REQ-NAV-01, 02, 03; REQ-TREE-01; REQ-EXPL-03, 04, 05; REQ-CONSOLE-01 to 03 |
| Started      | 2026-10-24                                                                                        |
| Finished     | 2026-10-24                                                                                        |

## Goal

Moving around the app is fast from the keyboard: a search palette finds objects, consoles and
actions; Go to DDL works from the tree and the editor; tabs and consoles can be managed fully.

## Scope

- Editor tabs: pin, close others, reopen closed, overflow dropdown, path tooltip.
- Consoles: rename, duplicate, delete; scratch files not bound to a connection; attach action.
- Status bar: current schema, transaction state (from step 03), encoding.
- Panels: Escape returns focus to the editor; hide all panels.
- Search palette over objects, consoles and actions with type filters and quick actions.
- Go to DDL (Ctrl+B), reveal in tree, back/forward, recent consoles switcher.
- Explorer: item-type filter, expand/collapse all, Force Refresh with last refresh time, cancel slow
  loads, next/previous match in speed search.

## Out of scope

- Undocking panels, editor split, bookmarks (Later backlog).
- Tree virtualization unless the step 04 performance test shows it is needed.

## Design notes

- **Palette**: one component fed by providers: actions (step 10 registry), consoles (`console_list`),
  and objects. Object search needs a catalog-wide name list per connected source; reuse the
  completion catalog (`Relations` query) and extend it with routines and sequences. Type prefixes:
  `/tables`, `/views`, `/routines`, `/consoles`, `/actions`.
- **Go to DDL**: resolve the identifier under the caret with the completion context code
  (`completionContext.ts`), then open step 05's DDL tab or the table viewer.
- **Consoles on disk**: rename/delete must go through `quarry-workspace` validated names and
  atomic operations; deleting asks for confirmation and closes the tab.
- **Scratch files**: a console with no bound data source; running asks to attach one.

## Tasks

### Backend

- [x] `console_rename`, `console_duplicate`, `console_delete` in `quarry-workspace` with tests.
- [x] Catalog name list for the palette (extend the completion catalog).
- [x] Explorer load cancel (abort a slow metadata query).

### IPC

- [x] Commands above; capabilities and bindings.

### Frontend

- [x] Tab context menu: pin, close others, close to the right, reopen closed (stack), path tooltip.
- [x] Overflow dropdown for many tabs.
- [x] Console rename/duplicate/delete; scratch console; attach to data source.
- [x] Status bar: schema, transaction state, encoding.
- [x] Escape to editor; hide all panels toggle.
- [x] Search palette with providers, type prefixes and quick actions (open DDL, open data, run
      action).
- [x] Go to DDL from tree and editor; reveal in tree.
- [x] Back/forward history across tabs and caret positions; recent consoles switcher.
- [x] Explorer multi-select (Shift/Ctrl+click, Shift+arrows) for Show DDL and other bulk
      actions (moved from step 05).
- [x] Explorer: item-type filter, expand/collapse all, Force Refresh with last refresh time,
      loading spinner with cancel, next/previous match.

### Tests

- [x] Unit: palette ranking (exact, prefix, fuzzy) and type prefixes.
- [x] UI: reopen closed restores the last closed console with its text.
- [x] UI: Go to DDL from an aliased column reference opens the right table.
- [x] Workspace: console rename keeps undo history and the tab binding.
- [x] axe scan of the palette.

### Docs

- [x] Mark M4.10 done in `mvp-and-milestones.md`.

## Acceptance criteria

- [x] Every item in Scope is reachable by keyboard alone.
- [x] Palette returns results for a 1,000-table schema in under 100 ms after the catalog loads.
- [x] Deleting a console asks first and never deletes a file outside the consoles directory.

## Risks and open questions

- Double-Shift detection in WebViews is unreliable; use a chord as the primary binding.

## Progress log

| Date       | Note                                                                                                                                                                                                                                                       |
| ---------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 2026-10-24 | Bindings: Search everywhere Ctrl+Shift+A, Go to object Ctrl+N (Cmd+O), Recent tabs Ctrl+E, Back/Forward Ctrl+Alt+Left/Right (Cmd+[ / Cmd+]), Reopen closed Ctrl+Shift+T, Hide all panels Ctrl+Shift+F12, Go to DDL Ctrl+B, Reveal Alt+F1. No double-Shift. |
| 2026-10-24 | The palette's object list is one new metadata level, `catalog` (relations, sequences, user routines in the schema scope), cached like the completion catalog. Ranking: exact, prefix, word start, substring, fuzzy; ties by length then name.              |
| 2026-10-24 | App shortcuts no longer fire while a modal dialog has focus (the palette needs Ctrl+Enter for Open data; it also keeps other dialogs from running queries behind them).                                                                                    |
| 2026-10-24 | Console rename hard-links then removes, so it never replaces another console; delete refuses links and only removes regular files in the consoles directory. Monaco models are keyed by tab id, so a rename keeps undo history.                            |
| 2026-10-24 | Explorer load cancel cancels on the shared session only when no statement runs there; otherwise the UI just stops waiting, so a user's query is never cancelled by accident.                                                                               |
