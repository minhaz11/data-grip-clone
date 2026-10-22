# Step 04: Table viewer and richer metadata

| Field        | Value                                 |
| ------------ | ------------------------------------- |
| Milestone    | M4.3                                  |
| Status       | Not started                           |
| Depends on   | 01                                    |
| Requirements | REQ-EXPL-01, REQ-EXPL-06, REQ-EXPL-07 |
| Started      | -                                     |
| Finished     | -                                     |

## Goal

The explorer shows every object kind a PostgreSQL developer needs (keys, foreign keys, checks,
triggers, routines, sequences), and a table viewer tab shows a table's full structure at a glance.

## Scope

- New tree levels and node kinds.
- A read-only table viewer tab.
- A quick info popup for tables and columns.
- Explorer context actions for what this step implements.

## Out of scope

- Show DDL / Copy DDL (step 05), Drop/Truncate/Rename (step 06), Open data (step 07).

## Design notes

- **Metadata model** (`crates/db-core/src/metadata.rs`): add `MetaKind` variants `Key`,
  `ForeignKey`, `Check`, `Trigger`, `Routine`, `Sequence`, and matching `MetadataRequest`
  variants. Each node keeps carrying the request for its children, as today.
- **Catalog queries** (`crates/db-postgres/src/metadata.rs`): parameterized queries on
  `pg_constraint` (contype p/u/f/c), `pg_trigger` (not internal), `pg_proc` (functions and
  procedures, with argument signature), `pg_class` relkind `S` and `pg_sequence`. Use
  `pg_get_constraintdef` / `pg_get_triggerdef` for the detail text.
- **Table details**: one command `object_details(source_id, ObjectRef)` returning columns,
  indexes, constraints, outgoing and incoming foreign keys, triggers, and size/row estimate
  (`pg_total_relation_size`, `reltuples`). The tree stays lazy; the viewer loads in one call.
- **ObjectRef**: an engine-neutral `{ schema, name, kind }` added to `db-core`; later steps (DDL,
  schema tools, AI context) reuse it.

## Tasks

### Backend

- [ ] Add `MetaKind` and `MetadataRequest` variants; update JSON round-trip tests.
- [ ] Group nodes under a table: Columns, Keys, Foreign keys, Checks, Indexes, Triggers.
- [ ] Schema-level groups: Routines and Sequences (with counts like Tables/Views).
- [ ] Catalog queries for each new kind.
- [ ] `ObjectRef` type in `db-core`.
- [ ] `object_details` in the `Session` trait and `PgSession`.
- [ ] `quick_info` (or reuse `object_details` subset) for table and column.

### IPC

- [ ] Commands `object_details`, `quick_info`; capabilities and bindings.

### Frontend

- [ ] Tree icons and labels for the new kinds; keyboard navigation unchanged.
- [ ] Table viewer tab type (alongside console tabs), opened by Enter or double-click on a table.
- [ ] Viewer sections: Columns, Indexes, Constraints, Foreign keys (both directions), Triggers,
      Size and row estimate.
- [ ] Quick info popup (Ctrl+Q style chord, decided with step 10) for table and column nodes.
- [ ] Context menu: "Open table viewer" and "Quick info" on tables.

### Tests

- [ ] Integration: seeded schema with every kind; each appears with the right detail text.
- [ ] Integration: incoming and outgoing FKs, composite keys, deferrable FK detail.
- [ ] Integration: overloaded functions appear separately with their signatures.
- [ ] UI: viewer renders each section from a mocked `object_details` result.
- [ ] Performance: a 1,000-table schema still expands within the M2.3 budget.

### Docs

- [ ] Update M2.3 "Not yet" list and mark M4.3 done in `mvp-and-milestones.md`.

## Acceptance criteria

- [ ] Every new node kind loads lazily with parameterized catalog queries.
- [ ] The table viewer matches `psql \d+` for the seeded tables (columns, constraints, indexes,
      triggers).
- [ ] No context action is shown that this step does not implement.

## Risks and open questions

- System schemas (`pg_catalog`, `information_schema`) can be large; keep them collapsed and lazy.
- Partitioned tables and inheritance: show partitions under the parent, or as plain tables? Decide
  and record.

## Progress log

| Date | Note |
| ---- | ---- |
