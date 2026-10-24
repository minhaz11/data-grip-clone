# Quarry user guide

Quarry is a desktop database IDE for PostgreSQL: connect, browse the schema, write and run SQL,
view and edit results, change tables, import and export data, and (if you turn it on) ask an AI
assistant about your SQL. "Quarry" is a working name.

## Install

Installers are attached to each [GitHub release](../README.md#releases).

| OS                                                      | File                              | Notes                                                                                                                                                                                                                                                 |
| ------------------------------------------------------- | --------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| macOS (one universal build for Apple silicon and Intel) | `.dmg`                            | Until builds are signed, macOS warns that the app is from an unidentified developer: Control-click the app, choose Open, then Open again.                                                                                                             |
| Windows 10 or 11                                        | `.msi` or `-setup.exe`            | Until builds are signed, SmartScreen may warn: choose More info, then Run anyway. The WebView2 runtime is installed if missing.                                                                                                                       |
| Linux (x86_64)                                          | `.AppImage`, `.deb` (also `.rpm`) | Needs WebKitGTK 4.1 (`libwebkit2gtk-4.1-0`), as on Ubuntu 22.04 and later or Debian 12 and later. Make the AppImage executable (`chmod +x`). On NVIDIA proprietary drivers, if the window is blank, start it with `WEBKIT_DISABLE_DMABUF_RENDERER=1`. |

Your data stays on your computer: settings, history and snippets in `app.db`, consoles as `.sql`
files, in the app's data directory. Passwords and the AI key go to the system credential store
(Keychain, Windows Credential Manager, or Secret Service on Linux), or are kept in memory until
you quit, whichever you choose.

## Supported databases

| Database                  | Status                                                                                       |
| ------------------------- | -------------------------------------------------------------------------------------------- |
| PostgreSQL 16             | Supported: the full integration suite runs against it.                                       |
| Other PostgreSQL versions | Expected to work for everyday use, not yet verified by the suite.                            |
| Other engines             | Not yet. A database is listed as supported only after its adapter passes the contract suite. |

Connections can use TLS (with your own CA, client certificate and key) and SSH tunnels (password,
key or agent).

## Getting started

1. **Add a data source**: the + button in Database Explorer. Test the connection, choose how the
   password is kept, and mark production databases as Production (Quarry then asks before any
   change to them).
2. **Open a console** (Ctrl+Shift+Q; Cmd on macOS) and write SQL. Ctrl+Enter runs the statement
   at the caret or the selection.
3. **Results** open below: sort, filter, edit (changes are previewed and applied together), and
   export to CSV, JSON, SQL and more.
4. **Shortcuts**: every action and its keys are listed in [keymap.md](keymap.md), and all can be
   changed in Settings > Keymap. Ctrl+Shift+A searches objects, consoles and actions.

## Safety

- **Read-only data sources** refuse writes, and the database server enforces it too.
- **Destructive statements** (DROP, TRUNCATE, DELETE or UPDATE without WHERE) and any change to a
  production data source ask first, with Cancel focused.
- **Manual transactions** stay open until you commit or roll back, and Quarry asks about open
  transactions before it quits.
- **Local history** keeps earlier versions of every console (Alt+Shift+H).

## AI assistant (optional)

Off until you turn it on in Settings > AI with your own Anthropic API key.

- Requests go directly from your computer to Anthropic with your key, and nowhere else. Nothing
  is sent while AI is off.
- For each data source you choose what may be sent: SQL text only, SQL and schema, or also a few
  sample rows (asked every time unless you always allow it). Production data sources start at SQL
  text only. Tables and columns on the ignore list are never sent.
- You see the exact request before it is sent, and every request is kept in a local log you can
  view and clear (Settings > AI).
- The assistant never runs SQL. Proposed SQL is shown as a change you can insert into the editor;
  it runs only when you press Run, with every check above.

## Limitations

- PostgreSQL only; other engines are planned.
- No auto-update: install new releases by hand.
- Import reads CSV, TSV and JSON (not Excel or Parquet); there is no `pg_dump` integration.
- AI context is limited to the objects your SQL uses and their direct foreign-key neighbours.

## Where things are

| What                               | Where                                                                                                                                                                        |
| ---------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Log (redacted; no SQL or row data) | macOS `~/Library/Logs/dev.quarry.desktop/quarry.log`; Linux `~/.local/share/dev.quarry.desktop/logs/quarry.log`; Windows `%LOCALAPPDATA%\dev.quarry.desktop\logs\quarry.log` |
| Settings, history, snippets        | `app.db` in the app data directory                                                                                                                                           |
| Consoles                           | the `consoles` folder in the app data directory                                                                                                                              |
