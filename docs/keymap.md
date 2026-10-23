# Keyboard shortcuts

<!-- Generated from apps/desktop/src/lib/actions.ts by keymapDoc.test.ts. Do not edit. -->
<!-- Regenerate with `npm run keymap:doc`. -->

Default bindings of every action. Change them in Settings > Keymap: add a shortcut by pressing
it, remove one, or reset an action or all of them. An action of the focused panel (SQL editor,
result grid, Database Explorer) wins over an "Everywhere" action with the same shortcut, and
conflicts are shown before saving.

Arrow keys, Page Up/Down and Home/End move within lists, trees and the grid, and Enter, Tab and
Escape work as usual in dialogs and cell editors; these are not rebindable.

On macOS, `⌘` is Command and `⌃` is Control. Some defaults differ there because the system
owns the usual chord (Command-Q quits, Command-Tab switches apps, Option-arrows move by word).
These chords cannot be bound: on macOS `⌘Q`, `⌘H`, `⌥⌘H`, `⌘M`, `⌘Tab`, `⌘Space` and
`⇧⌘3`/`4`/`5`; on Windows and Linux `Alt+F4`, `Alt+Tab` and `Ctrl+Alt+Delete`. Where text is
typed (everywhere and in the SQL editor), a shortcut without Ctrl or Alt must be a function key.

| Action | Where | Windows and Linux | macOS |
| ------ | ----- | ----------------- | ----- |
| New console | Everywhere | `Ctrl+Shift+Q` | `⇧⌘Q` |
| Close tab | Everywhere | `Ctrl+W`, `Ctrl+F4` | `⌘W`, `⌘F4` |
| Next tab | Everywhere | `Ctrl+Tab`, `Alt+Right` | `⌃Tab`, `⇧⌘]` |
| Previous tab | Everywhere | `Ctrl+Shift+Tab`, `Alt+Left` | `⌃⇧Tab`, `⇧⌘[` |
| Show or hide the Database Explorer | Everywhere | `Alt+1` | `⌘1` |
| Show or hide the results panel | Everywhere | `Alt+4` | `⌘4` |
| Settings | Everywhere | `Ctrl+Alt+S` | `⌥⌘S` |
| New data source | Everywhere | `Alt+Insert` | `⌘N` |
| Run statement or selection | Everywhere | `Ctrl+Enter` | `⌘Enter` |
| Run whole console | Everywhere | `Ctrl+Shift+F10` | `⇧⌘F10` |
| Stop the running query | Everywhere | `Ctrl+F2` | `⌘F2` |
| Query history | Everywhere | `Ctrl+Alt+E` | `⌥⌘E` |
| Format SQL | SQL editor | `Ctrl+Alt+L` | `⌥⌘L` |
| Next error | SQL editor | `F8` | `F8` |
| Previous error | SQL editor | `Shift+F8` | `⇧F8` |
| Select all cells | Result grid | `Ctrl+A` | `⌘A` |
| Copy selected cells | Result grid | `Ctrl+C` | `⌘C` |
| Edit cell | Result grid | `Enter`, `F2` | `Enter`, `F2` |
| Delete selected rows | Result grid | `Delete` | `Delete`, `⌘Backspace` |
| Add row | Result grid | `Insert` | `⌘I` |
| Column menu | Result grid | `Shift+F10`, `ContextMenu` | `⇧F10`, `ContextMenu` |
| Quick info | Database Explorer | `Ctrl+Q` | `⌃Q` |
| Refresh | Database Explorer | `Ctrl+F5` | `⌘F5` |
| Delete data source | Database Explorer | `Delete` | `Delete`, `⌘Backspace` |
| Duplicate data source | Database Explorer | `Ctrl+D` | `⌘D` |
| Context menu | Database Explorer | `Shift+F10`, `ContextMenu` | `⇧F10`, `ContextMenu` |
