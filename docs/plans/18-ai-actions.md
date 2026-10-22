# Step 18: AI actions

| Field        | Value                                                     |
| ------------ | --------------------------------------------------------- |
| Milestone    | M6.3                                                      |
| Status       | Not started                                               |
| Depends on   | 17                                                        |
| Requirements | REQ-AI-02, 03, 04, 05 (Later), 09; REQ-ERR-10, REQ-ERR-11 |
| Started      | -                                                         |
| Finished     | -                                                         |

## Goal

Users can ask for SQL in plain language, get a query or an error explained, and get a proposed fix,
always as a preview they choose to insert, and always run through the normal guards.

## Scope

- AI side panel with streaming answers.
- Natural language to SQL, shown in a preview/diff pane; Insert only on click.
- Explain query and Explain error (statement and error text, no rows).
- Fix with AI from an Output error or editor marker, shown as a diff.

## Out of scope

- Optimize query with EXPLAIN (Later, REQ-AI-05).
- Any agent loop where the model runs SQL.

## Design notes

- **Prompts**: include dialect name and server version (ADR-0005). Keep prompt templates in Rust
  so the log in step 17 shows them.
- **Output**: SQL is extracted from the response and shown in Monaco's diff editor against the
  current statement or selection. Insert replaces the selection or inserts at the caret; nothing
  runs.
- **Guards**: inserted SQL is ordinary editor text. Running it goes through the same Execute path
  (classifier, read-only, destructive and production confirmations). Add an automated test proving
  AI-inserted destructive SQL still asks for confirmation.
- **Entry points**: registered actions in step 10's registry (palette, context menus, Output error
  line, marker hover).

## Tasks

### Backend

- [ ] Prompt templates for generate, explain query, explain error, fix.
- [ ] SQL extraction from responses (fenced blocks, fallbacks).
- [ ] Streaming over a `Channel`, with cancel.

### IPC

- [ ] Commands `ai_generate`, `ai_explain`, `ai_fix` (each takes a previewed payload id from step
      17); bindings.

### Frontend

- [ ] AI side panel with prompt box, streaming answer, stop button.
- [ ] Preview/diff pane with Insert and Discard.
- [ ] Explain query (selection or current statement), Explain error (Output error).
- [ ] Fix with AI on errors and markers.
- [ ] Panel shows which connection and context level is used.

### Tests

- [ ] UI: generated SQL is never executed without the user pressing Run.
- [ ] UI: inserted `DELETE FROM t` (no WHERE) still triggers the destructive confirmation.
- [ ] UI: on a read-only source, inserted write SQL is still blocked.
- [ ] Unit: SQL extraction from varied response shapes.

### Docs

- [ ] Mark M6.3 and Phase 6 done in `mvp-and-milestones.md`.

## Acceptance criteria

- [ ] No code path executes AI output directly.
- [ ] Every AI action shows the payload preview from step 17 before sending.
- [ ] Destructive and read-only guards apply to AI-inserted SQL (automated tests).

## Risks and open questions

- Users may expect "run it" buttons; keep them out by design (ADR-0005) and say so in the panel.

## Progress log

| Date | Note |
| ---- | ---- |
