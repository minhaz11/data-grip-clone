# Step 13: CSV/JSON import

| Field        | Value                            |
| ------------ | -------------------------------- |
| Milestone    | M5.4                             |
| Status       | Not started                      |
| Depends on   | 06                               |
| Requirements | REQ-IMPEX-01 to 06, REQ-IMPEX-12 |
| Started      | -                                |
| Finished     | -                                |

## Goal

Users can load a CSV/TSV (or JSON) file into a new or existing table with a preview, a column
mapping, and a clear error policy. Large files stream with bounded memory, and an aborted import
leaves no rows behind.

## Scope

- Import wizard from a file picker or by dropping a file on a schema or table.
- Format settings and saved presets.
- Target: append to an existing table or create a new one.
- Column mapping, ignore, reorder, type inference with overrides.
- Preview of parsed rows and the generated DDL.
- Error policy: abort, skip and log, insert NULL.
- Streaming with progress and cancel.
- JSON array and JSON lines input.

## Out of scope

- Excel, Parquet, pg_dump front-end, disabling triggers (Later: REQ-IMPEX-09 to 11).

## Design notes

- **Parsing** (`crates/io`): streaming CSV with the `csv` crate; encoding detection on the first
  bytes (candidates: `chardetng` + `encoding_rs`) and transcoding to UTF-8 as a stream. JSON with a
  streaming deserializer for arrays and line-by-line for JSON lines.
- **File access**: the file is picked by the native dialog in Rust or dropped (Tauri drag-drop
  event gives the path to Rust); the WebView receives only sample rows for the preview.
- **Loading**: `COPY ... FROM STDIN` (text format) through `tokio-postgres` `copy_in` for speed.
  COPY aborts on the first bad row, so:
  - "Abort" policy: one COPY inside one transaction.
  - "Skip and log" / "insert NULL": validate and convert each row in Rust against the target column
    types before writing to COPY; rejected rows go to the error list with line numbers.
- **New table**: DDL from the mapping goes through step 06's `create_table` builder and preview,
  and runs in the same transaction as the load.
- **Guards**: read-only sources cannot import; production sources confirm with the target and row
  estimate.

## Tasks

### Backend

- [ ] Streaming CSV reader with format options (delimiter, quote, escape, record separator, header,
      trim, NULL token) and presets.
- [ ] Encoding detection and transcoding.
- [ ] JSON array and JSON lines readers.
- [ ] Sample and type inference (int, numeric, bool, date, timestamp, uuid, json, text).
- [ ] Row validation and conversion per target column type.
- [ ] COPY loader with progress events over a `Channel` and cancel.
- [ ] Error list with source line numbers; optional error log file.
- [ ] Create-and-load in one transaction.

### IPC

- [ ] Commands `import_open(path or dialog)`, `import_preview(options)`, `import_run(plan)`,
      `import_cancel`; capabilities and bindings.

### Frontend

- [ ] Wizard: source and format, target, mapping, preview, run.
- [ ] Drop a file on a schema or table node to start the wizard.
- [ ] Mapping grid: source to target, ignore, reorder, type override.
- [ ] Preview of first N rows and the DDL (editable via step 06's preview pane).
- [ ] Progress with rows/second and Cancel; result summary with rejected rows.

### Tests

- [ ] Unit: quoted fields with delimiters and newlines, BOM, Latin-1 input, NULL token vs empty.
- [ ] Integration: 1M-row import completes with memory under a fixed bound (measure peak RSS).
- [ ] Integration: abort policy leaves zero rows; skip policy loads valid rows and lists the rest.
- [ ] Integration: new table plus load is atomic.
- [ ] UI: read-only source cannot start an import; production asks for confirmation.

### Docs

- [ ] Mark M5.4 done in `mvp-and-milestones.md`.

## Acceptance criteria

- [ ] A 1M-row import stays within a fixed memory bound.
- [ ] An aborted or cancelled import leaves no rows.
- [ ] The file contents never pass through the WebView beyond the preview sample.

## Risks and open questions

- Type inference from a sample can be wrong for later rows; the error policy must cover it, and
  the summary should say how many rows were coerced.

## Progress log

| Date | Note |
| ---- | ---- |
