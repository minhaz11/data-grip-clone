# Step 10: Keymap and action registry

| Field        | Value                  |
| ------------ | ---------------------- |
| Milestone    | M5.3                   |
| Status       | Not started            |
| Depends on   | 01                     |
| Requirements | REQ-KEY-01, REQ-KEY-02 |
| Started      | -                      |
| Finished     | -                      |

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

- [ ] `actions.ts` registry and migrate the 12 existing commands.
- [ ] Migrate ad-hoc key handlers in the grid, explorer and editor to registered actions.
- [ ] Focus-context tracking and resolution.
- [ ] Monaco integration for editor-context actions.
- [ ] Settings > Keymap: search, rebind by pressing keys, remove binding, reset one / reset all.
- [ ] Conflict detection within the same context and global vs context; shown inline.
- [ ] macOS label rendering (Cmd, Option) and reviewed defaults.

### Tests

- [ ] Unit: resolution picks the focused context over global.
- [ ] Unit: conflicts are detected and reported.
- [ ] UI: rebinding an action works immediately and survives restart.
- [ ] UI: a rebound chord no longer triggers the old action.

### Docs

- [ ] A keymap table in the docs generated from the registry (or listed by hand once).
- [ ] Mark M5.3 done in `mvp-and-milestones.md`.

## Acceptance criteria

- [ ] No key handler outside the registry (search the code for `onKeyDown` handlers that dispatch
      commands).
- [ ] Every registered action can be rebound and reset.
- [ ] Conflicts are visible before they are saved.

## Risks and open questions

- WebKitGTK and WKWebView swallow some chords (e.g. Ctrl+W, Cmd+Q). List the reserved ones per
  platform and block binding them.

## Progress log

| Date | Note |
| ---- | ---- |
