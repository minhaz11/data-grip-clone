# Step 18: AI actions

| Field        | Value                                                     |
| ------------ | --------------------------------------------------------- |
| Milestone    | M6.3                                                      |
| Status       | Done                                                      |
| Depends on   | 17                                                        |
| Requirements | REQ-AI-02, 03, 04, 05 (Later), 09; REQ-ERR-10, REQ-ERR-11 |
| Started      | 2026-10-24                                                |
| Finished     | 2026-10-24                                                |

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
- A Fix button inside the editor's error-marker hover (Fix is offered on the Output error and as
  the "Fix the last error with AI" action, which act on the same failed statement).

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

- [x] Prompt templates for generate, explain query, explain error, fix.
- [x] SQL extraction from responses (fenced blocks, fallbacks).
- [x] Streaming over a `Channel`, with cancel.

### IPC

- [x] Task kinds `generate`, `explainQuery`, `explainError`, `fix` in `ai_context_preview` (step
      17 sends every previewed payload through `ai_send`); bindings.

### Frontend

- [x] AI side panel with prompt box, streaming answer, stop button.
- [x] Preview/diff pane with Insert and Discard.
- [x] Explain query (selection or current statement), Explain error (Output error).
- [x] Fix with AI on errors (Output error line and the registry action).
- [x] Panel shows which connection and context level is used.

### Tests

- [x] UI: generated SQL is never executed without the user pressing Run.
- [x] UI: inserted `DELETE FROM t` (no WHERE) still triggers the destructive confirmation.
- [x] UI: on a read-only source, inserted write SQL is still blocked.
- [x] Unit: SQL extraction from varied response shapes.

### Docs

- [x] Mark M6.3 and Phase 6 done in `mvp-and-milestones.md`.

## Acceptance criteria

- [x] No code path executes AI output directly.
- [x] Every AI action shows the payload preview from step 17 before sending.
- [x] Destructive and read-only guards apply to AI-inserted SQL (automated tests).

## Risks and open questions

- Users may expect "run it" buttons; keep them out by design (ADR-0005) and say so in the panel.

## Progress log

| Date       | Note                                                                                                                                                                                                                                                                                                                                                                                                                       |
| ---------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 2026-10-24 | Prompt templates are task kinds of the step 17 preview (`generate`, `explainQuery`, `explainError`, `fix`, plus `ask`), written in Rust so the preview and the log show the exact wording. One `ai_send` sends any previewed payload.                                                                                                                                                                                      |
| 2026-10-24 | SQL extraction runs in the UI (`extractSql`), where the proposal is shown: the first sql-tagged fence, else an untagged fence that reads as SQL, else a bare all-SQL answer; a cut-off fence runs to the end. Explanations never offer Insert.                                                                                                                                                                             |
| 2026-10-24 | The proposal is shown with the line diff from local history (step 14) instead of Monaco's diff editor: it works the same in tests and with screen readers. Insert replaces the selection or the failed statement only if that text is unchanged since the request, otherwise it inserts at the caret and says so. Nothing runs: the guards tests insert `DELETE FROM t` and an UPDATE on a read-only source and press Run. |
| 2026-10-24 | The panel is rendered only while open (a collapsed panel of the layout library stays inert, so its controls could not take focus) and sits in its own nested group, so saved layouts of the other panels are unaffected. Late events of a request the panel moved on from are ignored.                                                                                                                                     |
