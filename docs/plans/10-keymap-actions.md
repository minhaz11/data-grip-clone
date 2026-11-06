# Step 10: Keymap and action registry

| Field        | Value                  |
| ------------ | ---------------------- |
| Milestone    | M5.3                   |
| Status       | Done                   |
| Depends on   | 01                     |
| Requirements | REQ-KEY-01, REQ-KEY-02 |
| Started      | 2026-10-23             |
| Finished     | 2026-10-23             |

## Goal

Every action in the app is registered once, with a name, a context and default bindings, and
users can remap shortcuts and see conflicts.

## Scope

- Central action registry replacing the fixed `CommandId` list in `lib/keymap.ts`.
- Context-sensitive resolution by focused panel (editor, grid, explorer, global).
- User overrides stored in settings.
- Settings page: search actions, rebind, reset, conflict view.
- macOS defaults (Cmd vs Ctrl) reviewed.

## Out of scope

- Importing keymaps from other IDEs.

## Design notes

- **Registry**: `lib/actions.ts` with `{ id, title, context, defaultBindings, run, enabled() }`.
  Existing 12 command ids keep their names so persisted settings stay valid.
- **Contexts**: focus tracking per panel; resolution order is focused context first, then global.
  Monaco has its own keybindings; register editor-context actions with Monaco so they do not
  fight.
- **Platform**: `chordOf` maps Meta to Ctrl today so Cmd works on macOS. Decide whether to show
  Cmd in labels on macOS and whether some defaults differ (e.g. Ctrl+Tab vs Cmd+Shift+]).
- **Storage**: overrides in the existing `settings` store (`settings_get/set`), keyed by action id.
- **Used by**: the search palette (step 12) lists actions from this registry; later steps register
  their actions here instead of adding ad-hoc key handlers.

## Tasks

### Frontend

- [x] `actions.ts` registry and migrate the 12 existing commands.
- [x] Migrate ad-hoc key handlers in the grid, explorer and editor to registered actions.
- [x] Focus-context tracking and resolution.
- [x] Monaco integration for editor-context actions.
- [x] Settings > Keymap: search, rebind by pressing keys, remove binding, reset one / reset all.
- [x] Conflict detection within the same context and global vs context; shown inline.
- [x] macOS label rendering (Cmd, Option) and reviewed defaults.

### Tests

- [x] Unit: resolution picks the focused context over global.
- [x] Unit: conflicts are detected and reported.
- [x] UI: rebinding an action works immediately and survives restart.
- [x] UI: a rebound chord no longer triggers the old action.

### Docs

- [x] A keymap table in the docs generated from the registry (or listed by hand once).
- [x] Mark M5.3 done in `mvp-and-milestones.md`.

## Acceptance criteria

- [x] No key handler outside the registry (search the code for `onKeyDown` handlers that dispatch
      commands).
- [x] Every registered action can be rebound and reset.
- [x] Conflicts are visible before they are saved.

## Risks and open questions

- WebKitGTK and WKWebView swallow some chords (e.g. Ctrl+W, Cmd+Q). List the reserved ones per
  platform and block binding them.

## Progress log

| Date       | Note                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                              |
| ---------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 2026-10-23 | Registry in `lib/actions.ts` (27 actions: the 13 existing ids kept, plus grid and explorer commands); resolution, labels, conflicts and reserved chords in `lib/keymap.ts`; overrides in `Settings.keymap` (validated in Rust: at most 500 ids, 4 chords each).                                                                                                                                                                                                                                                                                                                                                   |
| 2026-10-23 | Contexts come from the nearest `data-action-context` ancestor of the focused element (editor, grid, explorer). One capture-phase window listener runs global and editor actions, so Monaco never sees a bound chord; grid and explorer actions run in those panels' handlers through `useContextActions`.                                                                                                                                                                                                                                                                                                         |
| 2026-10-23 | Not actions (documented, not rebindable): arrow/Page/Home/End navigation in lists, trees and the grid, and Enter/Tab/Escape in dialogs, menus and cell editors. A search for `onKeyDown` finds only those.                                                                                                                                                                                                                                                                                                                                                                                                        |
| 2026-10-23 | macOS: "Ctrl" in a binding is Cmd and the physical Control key is "Control" (before, both were Ctrl). Labels use ⌘⌥⇧⌃. Defaults differ where the system owns the chord: tab switching (⌃Tab, ⇧⌘] / ⇧⌘[ instead of ⌘Tab and Option-arrows, which move by word), ⌘1 and ⌘4 for the panels, ⌘N for a new data source, ⌃Q for quick info, ⌘Backspace and ⌘I in the grid. Reserved chords (⌘Q, ⌘H, ⌥⌘H, ⌘M, ⌘Tab, ⌘Space, ⇧⌘3/4/5; Alt+F4, Alt+Tab, Ctrl+Alt+Delete) cannot be bound. Still to check by hand in the packaged app (step 19): whether the default macOS menu's Close Window (⌘W) reaches the page first. |
| 2026-10-23 | Where text is typed (global and editor), a binding without Ctrl or Alt must be a function key. Same-context conflicts block Save; a context action hiding a global one is shown as a warning.                                                                                                                                                                                                                                                                                                                                                                                                                     |
| 2026-10-23 | `docs/keymap.md` is generated from the registry by a file snapshot test (`npm run keymap:doc` rewrites it; it is in `.prettierignore`).                                                                                                                                                                                                                                                                                                                                                                                                                                                                           |
| 2026-10-23 | The Add button and the shortcut recorder are one element focused on click: WebKit does not focus buttons on click, and a newly mounted recorder lost focus there.                                                                                                                                                                                                                                                                                                                                                                                                                                                 |
