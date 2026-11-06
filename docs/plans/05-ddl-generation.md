# Step 05: DDL generation

| Field        | Value                                               |
| ------------ | --------------------------------------------------- |
| Milestone    | M4.4                                                |
| Status       | Done                                                |
| Depends on   | 04                                                  |
| Requirements | REQ-EXPL-08, REQ-SCHEMA-09, REQ-NAV-02 (DDL target) |
| Started      | 2026-10-23                                          |
| Finished     | 2026-10-23                                          |

## Goal

Any object in the explorer can show its DDL, generated from the catalog in Rust, and the DDL for
one or many objects can go to the clipboard, a new console, or a file.

## Scope

- DDL for tables (columns, defaults, identity, constraints, comments), views, materialized views,
  indexes, sequences, functions/procedures, triggers.
- Options: schema-qualified names, skip owner, skip grants.
- Multi-object scripts in dependency order.
- Targets: read-only DDL tab, clipboard, new console, file.

## Out of scope

- Editing DDL and applying it (step 06).
- Schema compare (Later backlog).

## Design notes (as built)

- **Where**: `crates/db-postgres/src/ddl.rs`, called through `Session::ddl(objects, options)`
  on a short-lived side connection (like row edits), so generation can set `search_path`
  without touching the console's session or transaction.
- **Names**: with qualified names, `search_path` is empty, so `regclass`, `regprocedure` and the
  `pg_get_*def` functions qualify and quote every name; without, it is the objects' own schema
  (names there come out bare, others stay qualified). Literals use `quote_literal`.
- **Objects** (`DdlObject`): relation, sequence, routine (by identity arguments), index, trigger,
  and schema (everything in it). Options (`DdlOptions`): qualify (default on), owner, grants.
- **Order**: `SET check_function_bodies = false` (when routines and other objects mix, as
  pg_dump does), schemas, sequences (serial sequences come with their table), routines (those
  whose signature uses a table row type wait for the tables), tables without foreign keys
  (partitions after parents), views and materialized views in dependency order (from
  `pg_rewrite`/`pg_depend`), `ALTER SEQUENCE … OWNED BY`, indexes, foreign keys, triggers (and
  `DISABLE TRIGGER`), with comments, owner and grants after each object.
- **Partitioned indexes** are written with plain `ON` instead of the server's `ON ONLY`, so the
  partitions' indexes are created and attached (partition indexes are not listed separately).
- **Save** generates first (errors before any dialog), then asks with the native dialog in Rust
  and writes `.partial` then renames.
- **UI**: a third editor tab kind (`ddl`), re-generated when shown; the editor gained a
  `readOnly` prop (Monaco `readOnly`/`domReadOnly`, Format disabled).

## Tasks

### Backend

- [x] `ddl.rs` with one generator per object kind.
- [x] Options struct: qualify names, include owner, include grants.
- [x] Dependency ordering for multi-object scripts; FKs emitted last.
- [x] Unit tests for quoting of odd identifiers (mixed case, spaces, quotes, keywords). Covered
      by the round trip over `it_ddl."Odd ""Orders"""` and `"Customer Id"` (quoting is the
      server's), plus unit tests for script assembly.

### IPC

- [x] Commands `ddl_generate(source_id, objects, options) -> String` and
      `ddl_save(source_id, objects, options)` (Rust-side dialog); capabilities and bindings.

### Frontend

- [x] Read-only DDL tab (Monaco, read-only model) opened by "Show DDL".
- [x] Context actions: Show DDL, Copy DDL, "Open DDL in new console", "Save DDL to file" (the
      last two live in the DDL tab's toolbar).
- [x] Multi-select in the explorer for "Generate DDL" on several objects. As built: Show DDL on
      a schema generates every object in it, in order; free multi-select moves to step 12.
- [x] Options popover: qualify names, skip owner, skip grants (checkboxes in the DDL toolbar).

### Tests

- [x] Round trip: generate DDL for the seeded `shop` schema, apply to an empty database, and compare
      the two catalogs (columns, constraints, indexes, views, functions, triggers).
- [x] Odd identifiers survive the round trip.
- [x] Circular FK pair generates a script that applies cleanly.

### Docs

- [x] Mark M4.4 done in `mvp-and-milestones.md`.

## Acceptance criteria

- [x] Round-trip test passes in CI against the disposable server.
- [x] Every object kind in the tree from step 04 has Show DDL (relations, schemas, routines,
      sequences, indexes, triggers; keys, checks and foreign keys are part of their table's DDL).
- [x] Saving to a file never receives a path from the WebView.

## Risks and open questions

- Exact parity with `pg_dump` is not a goal. Known differences: aggregates are emitted as a
  comment; `INHERITS` children come out as standalone tables; storage parameters, tablespaces,
  policies (RLS), publications and extensions are not generated.
- Sequence current values are not carried (DDL only).

## Progress log

| Date       | Note                                                                                                                                                                                                                                                                                                 |
| ---------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 2026-10-23 | Round trips compare both the regenerated text and a catalog fingerprint of the two databases. The fingerprint caught `CREATE INDEX … ON ONLY` for a partitioned table, which would have left the partition without its index while the text still matched. Verified the check fails without the fix. |
| 2026-10-23 | The DDL tab's axe scan found SQL syntax colors below 4.5:1 in Monaco's built-in themes (light strings and operators; dark comments, strings, predefined variables). Overridden in our themes; a new E2E scan covers every token kind in both themes.                                                 |
| 2026-10-23 | Checks: 81 Rust unit, 47 PostgreSQL integration, 132 frontend unit, 22 E2E.                                                                                                                                                                                                                          |
