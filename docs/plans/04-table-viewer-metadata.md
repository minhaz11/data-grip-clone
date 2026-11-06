# Step 04: Table viewer and richer metadata

| Field        | Value                                 |
| ------------ | ------------------------------------- |
| Milestone    | M4.3                                  |
| Status       | Done                                  |
| Depends on   | 01                                    |
| Requirements | REQ-EXPL-01, REQ-EXPL-06, REQ-EXPL-07 |
| Started      | 2026-10-23                            |
| Finished     | 2026-10-23                            |

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

## Design notes (as built)

- **Metadata model** (`db-core/src/metadata.rs`): `MetaKind` gained `Key`, `ForeignKey`, `Check`,
  `Trigger`, `Routine`, `Sequence`; `MetadataRequest` gained `Keys`, `ForeignKeys`, `Checks`,
  `Triggers` (per table) and `Routines`, `Sequences` (per schema).
- **Groups**: a table shows Columns plus whichever of Keys, Foreign keys, Checks, Indexes and
  Triggers are non-empty; a view shows Columns (and Triggers if any); a materialized view Columns
  and Indexes. A schema adds Routines and Sequences when it has any.
- **Routines** are user routines only (members of extensions are left out, so `public` with
  `pgcrypto` is not flooded). Overloads have distinct keys `r:name(identity args)`; the detail is
  `(args) → result`, procedures are flagged.
- **Sequences** include serial and identity sequences (they are real sequences), with type,
  increment when not 1, and the owning column.
- **Object details**: `ObjectRef { schema, name, objectType }` and `ObjectDetails` in
  `db-core/src/details.rs`; one `object_details(id, object)` command reads the object by OID:
  columns (type, nullability, default, identity, generation, comment, primary key), indexes,
  constraints, foreign keys in both directions with actions, triggers, row estimate (`reltuples`,
  absent until analyzed) and total size.
- **Quick info** uses the same command (a column's info comes from its table's details), so there
  is no separate `quick_info` command. Ctrl+Q only (not Cmd+Q, which quits on macOS).
- **Editor tabs** are now a union: consoles and object tabs (`kind: 'object'`). Object tabs are
  de-duplicated per data source and object, persisted and restored; text and session operations
  only touch consoles. The tablist is labelled "Open editors".

## Tasks

### Backend

- [x] Add `MetaKind` and `MetadataRequest` variants; update JSON round-trip tests.
- [x] Group nodes under a table: Columns, Keys, Foreign keys, Checks, Indexes, Triggers.
- [x] Schema-level groups: Routines and Sequences (with counts like Tables/Views).
- [x] Catalog queries for each new kind.
- [x] `ObjectRef` type in `db-core`.
- [x] `object_details` in the `Session` trait and `PgSession`.
- [x] `quick_info` (or reuse `object_details` subset) for table and column.

### IPC

- [x] Commands `object_details`, `quick_info`; capabilities and bindings. (As built:
      `object_details` only; quick info reuses it.)

### Frontend

- [x] Tree icons and labels for the new kinds; keyboard navigation unchanged.
- [x] Table viewer tab type (alongside console tabs), opened by Enter or double-click on a table.
- [x] Viewer sections: Columns, Indexes, Constraints, Foreign keys (both directions), Triggers,
      Size and row estimate.
- [x] Quick info popup (Ctrl+Q style chord, decided with step 10) for table and column nodes.
- [x] Context menu: "Open table viewer" and "Quick info" on tables.

### Tests

- [x] Integration: seeded schema with every kind; each appears with the right detail text.
- [x] Integration: incoming and outgoing FKs, composite keys, deferrable FK detail.
- [x] Integration: overloaded functions appear separately with their signatures.
- [x] UI: viewer renders each section from a mocked `object_details` result.
- [x] Performance: a 1,000-table schema still expands within the M2.3 budget.

### Docs

- [x] Update M2.3 "Not yet" list and mark M4.3 done in `mvp-and-milestones.md`.

## Acceptance criteria

- [x] Every new node kind loads lazily with parameterized catalog queries.
- [x] The table viewer matches `psql \d+` for the seeded tables (columns, constraints, indexes,
      triggers). Compared field by field on `shop.orders`: columns, types, nullability, defaults,
      both indexes with definitions, the outgoing foreign key and the incoming reference.
- [x] No context action is shown that this step does not implement.

## Risks and open questions

- System schemas stay hidden (as before); extension-owned routines are hidden too. If users need
  them, add a "show system objects" option.
- Partitions are still not shown as children of their partitioned table; decide with step 06.

## Progress log

| Date       | Note                                                                                                                                      |
| ---------- | ----------------------------------------------------------------------------------------------------------------------------------------- |
| 2026-10-23 | The generated TS types caught the new `MetaKind` values missing from the tree's icon and label maps at compile time (step 01 paying off). |
| 2026-10-23 | Identity columns own a sequence too; the tree lists it, since it can be `setval`'d like any sequence.                                     |
| 2026-10-23 | Checks: 79 Rust unit, 44 PostgreSQL integration (per-file count), 130 frontend unit, 18 E2E.                                              |
