# 01 — Layout, Navigation and Shortcuts

## Sources

All fetched 2026-10-19 from official JetBrains DataGrip help (content reached us through the fetch tool's page-to-markdown + summarising step, so wording is a relay, not a verbatim copy).

- https://www.jetbrains.com/help/datagrip/guided-tour-around-the-user-interface.html
- https://www.jetbrains.com/help/datagrip/tool-windows.html
- https://www.jetbrains.com/help/datagrip/database-tool-window.html
- https://www.jetbrains.com/help/datagrip/services-tool-window.html
- https://www.jetbrains.com/help/datagrip/files-tool-window.html
- https://www.jetbrains.com/help/datagrip/using-code-editor.html
- https://www.jetbrains.com/help/datagrip/code-editor.html
- https://www.jetbrains.com/help/datagrip/code-editor-navigation.html
- https://www.jetbrains.com/help/datagrip/navigating-through-the-source-code.html
- https://www.jetbrains.com/help/datagrip/database-object-and-file-navigation.html
- https://www.jetbrains.com/help/datagrip/searching-everywhere.html
- https://www.jetbrains.com/help/datagrip/mastering-keyboard-shortcuts.html
- https://www.jetbrains.com/help/datagrip/reference-keymap-win-default.html
- https://www.jetbrains.com/help/datagrip/auto-completing-code.html
- https://www.jetbrains.com/help/datagrip/code-completion.html
- https://www.jetbrains.com/help/datagrip/reformat-and-rearrange-code.html
- https://www.jetbrains.com/help/datagrip/query-consoles.html
- https://www.jetbrains.com/help/datagrip/run-a-query.html
- https://www.jetbrains.com/help/datagrip/query-execution.html
- https://www.jetbrains.com/help/datagrip/database-explorer.html

Fetch attempts that returned HTTP 404 (guessed URLs; not used): user-interface-overview.html, manipulating-the-editor-tabs.html, windows-and-linux-keymap.html, working-with-the-files-tool-window.html, working-with-the-project-tool-window.html, running-sql-queries.html.

## Evidence legend

- [DOC] stated in fetched official docs.
- [CFG] observed in the user's local DataGrip 2026.2.6 config (~/.config/JetBrains/DataGrip2026.2/options/window.layouts.xml) on Linux.
- [ASSUMPTION] our inference, not verified.

## Observed workflows

1. **Understand the default main window.** Open the IDE → window header shows project widget, VCS widget and a single tool-window bar with icons for Database Explorer, Services, AI Assistant, Files [DOC]. Main menu on Windows/Linux can be merged with the toolbar, hidden under a hamburger (Alt+\), or shown above the toolbar [DOC]. Areas named by the docs: toolbar, Database Explorer, Files, query console, data editor and viewer, Services (query result tabs), navigation bar, status bar [DOC]. Toolbar, navigation bar and status bar are each toggled under View | Appearance [DOC].
2. **Tool-window placement.** Tool windows dock to the sides and bottom of the main window by default; they can be moved, resized, hidden, undocked to separate windows [DOC]. Local layout: "Database" LEFT with weight 0.25; "Project" and "Structure" RIGHT (Structure as a split); "Version Control", "Find", "Run", "Debug", "Inspection" BOTTOM [CFG]. Docs say Files (the renamed Project view) sits on the right by default [DOC], consistent with the CFG "Project" entry [ASSUMPTION that the layout id "Project" is the Files window].
3. **Show / hide a tool window.** Click its bar icon, use View | Tool Windows, or a shortcut such as Alt+2 for Files [DOC]. Hide active window with Shift+Escape or the header Hide button; hide/restore all with Ctrl+Shift+F12 [DOC]. Escape returns focus from a tool window to the editor; F12 jumps from editor to the last active tool window [DOC].
4. **Rearrange tool windows.** Drag bar icons; right-click an icon to Hide or Move to Top/Left/Bottom/Right; header menu offers View Mode, Move to, Resize, Remove from Sidebar [DOC]. Stretch commands move window edges via Ctrl+Alt+Shift+arrows [DOC]. Optional separate side tool-window bars (View | Appearance | Tool Window Bars); with them hidden, double-press-and-hold Alt reveals them; "Show Tool Window Names" is a bar context-menu toggle [DOC].
5. **Browse the Database Explorer.** Tree of data sources → schemas → tables and other objects; with no data sources it shows quick actions for creating one or using demo sources [DOC]. Typing starts speed search with a filter toggle [DOC]. "N of M" button under a data source selects extra schemas to introspect [DOC]. Toolbar: New, Data Source Properties, Refresh, Deactivate, Jump to Query Console, Edit Data, Go to DDL, Compare Schema Structure, View Options, Expand/Collapse All, Scroll from Editor, Hide [DOC]. View Options control grouping (databases/schemas, server objects, object elements, schema-object kinds, by prefix), sorting, an item filter (green dot when active), and visibility toggles for namespaces, empty groups, intermediate nodes, virtual objects, query files [DOC]. Context-menu categories: Basic, Copy/Paste, Navigation, Execution, Introspection Level, SQL Scripts, Object Actions, Tools, Import/Export, Diagrams, Diagnostics [DOC]. Data sources can be grouped into folders (F6 or drag; Alt+Shift+Up/Down reorders), colors via Set Color [DOC].
6. **Open table data / console / DDL from the tree.** Select a table and F4 → data editor; select a data source and F4 → its default console; Ctrl+B → DDL; Ctrl+Q → quick documentation [DOC].
7. **Services tool window.** Shows query consoles, SQL files, database objects attached to data sources, query log output and result sets; also Run/Debug, Docker, Kubernetes service types [DOC]. Database toolbar: Jump to Query Console, Deactivate (green dot = active session), Transaction Mode and Isolation, Commit and Roll back (manual mode only), Cancel Running Statements [DOC]. Tabs per console: Output (statements, errors, timestamps, rows affected, duration, autocommit mode), Result (grid with pagination, edit, export, view as Table/Tree/Text/Transpose), Query Plan [DOC]. Ctrl+Shift+T toggles the services tree; Alt+Home focuses its navigation bar when hidden [DOC].
8. **Files tool window.** Alt+2; views Files, Open Files, Changed Files, Scratches and Consoles; project directory first, attached directories next; query consoles under Scratches and Consoles | Database Consoles [DOC]. Options: preview tab, single-click open, always select opened file, file details, sort, folders on top; context menu includes Run, Attach Data Source, Change Dialect, Rename, Refactor, Local History [DOC].
9. **Editor tabs.** One tab per open file; default tab limit 10 [DOC]; pin keeps a tab through Close Other Tabs and limit eviction [DOC]; tab bar can move to another edge or hide, one row or multiple rows, alphabetical sort [DOC]; hidden tabs in a dropdown [DOC]; preview tab (italic) replaced by next selected file until edited or double-clicked [DOC]; split right/down via context menu or drag to edge, Normalize Splits, Unsplit [DOC]; detach into own window (drag or Shift+F4) and Dock back [DOC]; query console tab titles are shortened to 36 chars by default [DOC, in managing-data-sources; see file 02]. Hovering a console tab shows its file path [DOC].
10. **Search Everywhere.** Shift twice, or Navigate | Search Everywhere; default shows recent files [DOC]. Tab key cycles scope (database objects, files, symbols, actions, text) [DOC]. "Include non-project items" checkbox (Alt+N) [DOC]. Filter button narrows by file type or data sources; "Open in Find Tool Window" sends results to Find [DOC]. Database tab accepts `/tables`, `/tables <name>` style commands; type filter categories: Databases & Schemas, Tables, Scripting, Types [DOC]. Context data sources come from the active console, data editor or selected sources [DOC]. Also: `/` settings tags, math expressions, text search tab with whole-word/case/regex, user abbreviations [DOC]. Result quick actions: Go to DDL Ctrl+B, Jump to source F4, Modify table Ctrl+F6, Select in Alt+F1, Quick doc Ctrl+Q, SQL generator Ctrl+Alt+G [DOC].
11. **Navigate from code to objects.** Ctrl+B on an object → declaration/DDL; Alt+Shift+B selects the referenced object in Database Explorer [DOC]. Alt+F1 "Select In" popup: from a console/file to Files View or Database Explorer [DOC]. Alt+Home activates the navigation bar to browse objects, consoles, files [DOC]. Ctrl+Alt+F12 browses file path in the OS file manager [DOC]. Ctrl+E recent files and consoles [DOC]. Ctrl+Tab switcher (open files, consoles, tool windows) [DOC]. Back/Forward Ctrl+Alt+Left/Right; Last Edit Location Ctrl+Shift+Backspace; Ctrl+G line:column; Ctrl+F12 structure popup; bookmarks F11/Ctrl+F11/Shift+F11; F2/Shift+F2 next/previous issue [DOC].
12. **Run SQL.** In a console, Ctrl+Enter executes the statement per Query Execution settings; if several statements, a chooser appears with a "run all" item [DOC]. Results open in the Services window; each query reuses a result tab unless "Open results in new tab" is set; tabs can be pinned [DOC]. Settings path: Database | Query Execution [DOC].
13. **Completion and format.** Completion pops up automatically while typing; Ctrl+Space invokes it manually [DOC]. Enter inserts to the left of the caret, Tab replaces characters to the right [DOC]. Reformat selection (or whole file if no selection) with Ctrl+Alt+L [DOC].

## Keyboard shortcuts

Windows/Linux defaults of the predefined Windows keymap. The docs do not publish a separate Linux table in the pages fetched; Linux conflicts with desktop shortcuts are possible (not verified from a fetched page).

| Action                                                                                      | Windows/Linux                                                                     | Source |
| ------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------- | ------ |
| Execute statement (console) / Submit changes (data editor)                                  | Ctrl+Enter                                                                        | [DOC]  |
| Run whole query file / Run item                                                             | Ctrl+Shift+F10                                                                    | [DOC]  |
| Cancel running statements / Deactivate                                                      | Ctrl+F2                                                                           | [DOC]  |
| Browse Query History                                                                        | Ctrl+Alt+E                                                                        | [DOC]  |
| New query console (data source selected)                                                    | Ctrl+Shift+Q                                                                      | [DOC]  |
| Jump to Query Console                                                                       | Ctrl+Shift+F10                                                                    | [DOC]  |
| Open default console / open data of selected node                                           | F4                                                                                | [DOC]  |
| New (data source, console, driver)                                                          | Alt+Insert                                                                        | [DOC]  |
| Data Source Properties dialog                                                               | Ctrl+Alt+Shift+S                                                                  | [DOC]  |
| Refresh node / Force refresh                                                                | Ctrl+F5 / Ctrl+Shift+F5                                                           | [DOC]  |
| Go to DDL / Go to Declaration                                                               | Ctrl+B                                                                            | [DOC]  |
| Select referenced object in Database Explorer                                               | Alt+Shift+B                                                                       | [DOC]  |
| Modify object                                                                               | Ctrl+F6                                                                           | [DOC]  |
| SQL Generator / Generate DDL to clipboard / Generate DDL to console                         | Ctrl+Alt+G / Ctrl+Alt+Shift+G / Ctrl+Alt+Shift+B                                  | [DOC]  |
| Full-text search in data                                                                    | Ctrl+Alt+Shift+F                                                                  | [DOC]  |
| Show Diagram / popup                                                                        | Ctrl+Alt+Shift+U / Ctrl+Alt+U                                                     | [DOC]  |
| Search Everywhere                                                                           | Shift, Shift                                                                      | [DOC]  |
| Find Action                                                                                 | Ctrl+Shift+A                                                                      | [DOC]  |
| Go to File / Go to Symbol / Go to Line:Col                                                  | Ctrl+Shift+N / Ctrl+Alt+Shift+N / Ctrl+G                                          | [DOC]  |
| Database object by name                                                                     | listed as "⌘ O" (a macOS key) in the fetched text; Windows/Linux value not stated | [DOC]  |
| Recent files and consoles                                                                   | Ctrl+E                                                                            | [DOC]  |
| Switcher                                                                                    | Ctrl+Tab                                                                          | [DOC]  |
| Back / Forward                                                                              | Ctrl+Alt+Left / Ctrl+Alt+Right                                                    | [DOC]  |
| Last edit location                                                                          | Ctrl+Shift+Backspace                                                              | [DOC]  |
| Next / previous editor tab                                                                  | Alt+Right / Alt+Left                                                              | [DOC]  |
| Close active tab                                                                            | Ctrl+F4                                                                           | [DOC]  |
| Detach tab to window                                                                        | Shift+F4                                                                          | [DOC]  |
| Show Files / Find / Run / Debug / Problems / Structure / Services / VCS / Commit / Terminal | Alt+2 / 3 / 4 / 5 / 6 / 7 / 8 / 9 / 0 / Alt+F12                                   | [DOC]  |
| Show Database Explorer                                                                      | none in the Windows keymap page; "⌘1" (macOS) appears in other pages              | [DOC]  |
| Hide tool window / hide all / jump to last                                                  | Shift+Escape / Ctrl+Shift+F12 / F12                                               | [DOC]  |
| Navigation bar                                                                              | Alt+Home                                                                          | [DOC]  |
| Select In popup                                                                             | Alt+F1                                                                            | [DOC]  |
| Basic completion                                                                            | Ctrl+Space                                                                        | [DOC]  |
| Type-matching completion / Second basic                                                     | Ctrl+Shift+Space / Ctrl+Alt+Space                                                 | [DOC]  |
| Complete current statement                                                                  | Ctrl+Shift+Enter                                                                  | [DOC]  |
| Quick documentation                                                                         | Ctrl+Q                                                                            | [DOC]  |
| Parameter info                                                                              | Ctrl+P (when auto popup off)                                                      | [DOC]  |
| Reformat selection / whole file / auto-indent                                               | Ctrl+Alt+L / Ctrl+Alt+Shift+L / Ctrl+Alt+I                                        | [DOC]  |
| Comment line / block                                                                        | Ctrl+/ / Ctrl+Shift+/                                                             | [DOC]  |
| Duplicate line / Delete line                                                                | Ctrl+D / Ctrl+Y                                                                   | [DOC]  |
| Find / Replace / Find in Files                                                              | Ctrl+F / Ctrl+R / Ctrl+Shift+F                                                    | [DOC]  |
| Rename                                                                                      | Shift+F6                                                                          | [DOC]  |
| Find usages                                                                                 | Alt+F7                                                                            | [DOC]  |
| Show context actions                                                                        | Alt+Enter                                                                         | [DOC]  |
| Extend / shrink selection                                                                   | Ctrl+W / Ctrl+Shift+W                                                             | [DOC]  |
| Settings                                                                                    | Ctrl+Alt+S                                                                        | [DOC]  |
| Live template list in context                                                               | Ctrl+J                                                                            | [DOC]  |
| Structure popup                                                                             | Ctrl+F12                                                                          | [DOC]  |

## Edge cases and error states

- Shortcuts may not be detected on non-English keyboard layouts; function keys and OS-global shortcuts can conflict [DOC].
- Ctrl+Y is "Delete Line" in the Windows keymap but is also cited as Delete Row in result grids; context decides [DOC].
- Same key, different context: Ctrl+Enter = execute in console, submit in data editor; Ctrl+F2 = Deactivate in Explorer and cancel in Services [DOC].
- Power Save Mode disables code completion [DOC]. If the completion popup fails to appear when the machine is busy, invoke manually [DOC].
- Reformat uses selection if present, otherwise the file; a "Disable formatting" option exists per dialect [DOC].
- Settings window is non-modal and project-specific by default [DOC].
- "Speed Search Filter" and tree "Scroll from Editor" are disabled when Autoscroll from Editor is on [DOC].
- Files over 20 MB open only the first 2.5 MB in the editor [DOC, run-a-query].
- Query-execution chooser can be replaced by fixed behaviour (smallest/largest statement, whole script, everything from caret) and by configurable behaviour outside a statement and for selections [DOC].

## Implementation requirements for our app

- REQ-LAYOUT-01 (MVP): Left-docked connection tree, bottom-docked results/log panel, central tabbed editor area; panel sizes persisted per workspace.
- REQ-LAYOUT-02 (MVP): Panels show/hide by keyboard and bar buttons; Escape returns focus to the editor; a "hide all panels" toggle exists.
- REQ-LAYOUT-03 (Later): Drag panels between edges; undock a panel or editor tab into a separate window (Tauri multi-window).
- REQ-LAYOUT-04 (MVP): Editor tabs with pin, close-others, reopen-closed, overflow dropdown, per-tab path tooltip.
- REQ-LAYOUT-05 (Later): Editor split (right/down), preview-tab behaviour, tab sort/placement options.
- REQ-LAYOUT-06 (MVP): Status bar with caret line:col, encoding, active connection/schema, and transaction state.
- REQ-NAV-01 (MVP): Global search palette (double-Shift equivalent plus a chord) with scopes: objects, files/consoles, actions; `/tables <name>` style type filter; results carry quick actions (open DDL, open data).
- REQ-NAV-02 (MVP): Go to DDL on Ctrl+B equivalent from both tree and editor identifiers; "reveal in tree" action from editor.
- REQ-NAV-03 (MVP): Back/forward navigation history and a recent files/consoles popup with a switcher chord.
- REQ-NAV-04 (Later): Bookmarks, structure popup, next/previous problem.
- REQ-KEY-01 (MVP): Central action registry with remappable default keymap; defaults mirror the table above where no conflict exists (execute Ctrl+Enter, cancel Ctrl+F2, history Ctrl+Alt+E, new console Ctrl+Shift+Q, reformat Ctrl+Alt+L, completion Ctrl+Space). These are our own defaults; verify Linux desktop conflicts.
- REQ-KEY-02 (MVP): Context-sensitive bindings resolved by focused panel; a conflict view in settings.
- REQ-EXEC-01 (MVP): Execute honours a "what to run" policy: statement at caret, selection, or whole script, with an optional chooser; unsafe DELETE/UPDATE without WHERE warning toggle.
- REQ-EXEC-02 (MVP): Result tab reuse by default with option for a new tab per run and pinnable tabs.
- REQ-TREE-01 (MVP): Explorer tree with speed search, item-type filter, "N of M schemas" selection, refresh/force refresh, expand/collapse all.
- REQ-TREE-02 (Later): View-option matrix (grouping by object kind, prefix grouping, sorting), folders for connections, color tags.

## Limitations / not verified

- No live UI capture of DataGrip was made; everything is from fetched help text, relayed through a summarising fetch tool, so exact labels may differ from the live UI.
- Windows/Linux shortcut for "Show Database Explorer" and for "Go to database object by name" was not stated for those platforms in fetched pages. Some pages mention macOS keys.
- The Windows predefined-keymap page did not list Execute, New Console or Jump to Console; those values come from query-consoles.html, services-tool-window.html and code-editor.html.
- No Linux-specific keymap page was successfully fetched (windows-and-linux-keymap.html returned 404).
- Editor-tab page manipulating-the-editor-tabs.html returned 404; tab behaviour is from using-code-editor.html only.
- Exact behaviour of "Jump to data source" and "Navigate to table" as dedicated named actions is not documented in fetched pages; Search Everywhere's Database tab and Alt+Shift+B are the closest documented mechanisms.
- Default pixel sizes, theme, icons and exact tool-window ids beyond the CFG listing were not examined.
