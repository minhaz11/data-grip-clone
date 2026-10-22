# Step 05: DDL generation

| Field        | Value                                               |
| ------------ | --------------------------------------------------- |
| Milestone    | M4.4                                                |
| Status       | Not started                                         |
| Depends on   | 04                                                  |
| Requirements | REQ-EXPL-08, REQ-SCHEMA-09, REQ-NAV-02 (DDL target) |
| Started      | -                                                   |
| Finished     | -                                                   |

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

## Design notes

- **Where**: `crates/db-postgres/src/ddl.rs`. Server functions do most of the work where they
  exist: `pg_get_viewdef`, `pg_get_indexdef`, `pg_get_constraintdef`, `pg_get_functiondef`,
  `pg_get_triggerdef`, `format_type`. Table DDL is assembled from `pg_attribute`, `pg_attrdef`,
  identity columns and `pg_constraint`; comments from `pg_description`.
- **Quoting**: every identifier goes through the existing quoting helper in `sqlutil.rs`.
- **Ordering**: for multi-object scripts, order with `pg_depend` (tables before views that read
  them, sequences before tables that own them, FKs as separate `ALTER TABLE` statements at the end
  to break cycles).
- **File target**: native save dialog opened from Rust, as export does, so the path never comes
  from the WebView.

## Tasks

### Backend

- [ ] `ddl.rs` with one generator per object kind.
- [ ] Options struct: qualify names, include owner, include grants.
- [ ] Dependency ordering for multi-object scripts; FKs emitted last.
- [ ] Unit tests for quoting of odd identifiers (mixed case, spaces, quotes, keywords).

### IPC

- [ ] Commands `ddl_generate(source_id, objects, options) -> String` and
      `ddl_save(source_id, objects, options)` (Rust-side dialog); capabilities and bindings.

### Frontend

- [ ] Read-only DDL tab (Monaco, read-only model) opened by "Show DDL".
- [ ] Context actions: Show DDL, Copy DDL, "Open DDL in new console", "Save DDL to file".
- [ ] Multi-select in the explorer for "Generate DDL" on several objects.
- [ ] Options popover: qualify names, skip owner, skip grants.

### Tests

- [ ] Round trip: generate DDL for the seeded `shop` schema, apply to an empty database, and compare
      the two catalogs (columns, constraints, indexes, views, functions, triggers).
- [ ] Odd identifiers survive the round trip.
- [ ] Circular FK pair generates a script that applies cleanly.

### Docs

- [ ] Mark M4.4 done in `mvp-and-milestones.md`.

## Acceptance criteria

- [ ] Round-trip test passes in CI against the disposable server.
- [ ] Every object kind in the tree from step 04 has Show DDL.
- [ ] Saving to a file never receives a path from the WebView.

## Risks and open questions

- Exact parity with `pg_dump` is not a goal; record known differences (e.g. storage parameters,
  tablespaces, partition bounds) in this file as they come up.
- Generated columns, partitioned tables and exclusion constraints need specific tests.

## Progress log

| Date | Note |
| ---- | ---- |
