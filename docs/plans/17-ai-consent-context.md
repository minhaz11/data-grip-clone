# Step 17: AI consent and context

| Field        | Value                                     |
| ------------ | ----------------------------------------- |
| Milestone    | M6.2                                      |
| Status       | Done                                      |
| Depends on   | 05, 16                                    |
| Requirements | REQ-AI-06, REQ-AI-07, REQ-AI-10; ADR-0005 |
| Started      | 2026-10-24                                |
| Finished     | 2026-10-24                                |

## Goal

Before anything is sent to the AI provider, the user sees exactly what will be sent and has chosen
how much schema (and, separately, data) may leave the machine for each connection.

## Scope

- Context levels per connection: None, Schema; Schema + sample rows behind a separate consent.
- Context builder in Rust.
- "What will be sent" preview with size estimate before every request.
- Consent storage, revocation, defaults (production = None).
- Local request log: viewable, clearable, key redacted.

## Out of scope

- AI actions themselves (step 18).
- Tool use by the model (REQ-AI-08 permission model applies only if tool use is added later).

## Design notes

- **Context builder** (`ai-core` or `src-tauri`): inputs are the editor SQL, the selected or
  referenced objects (resolved with step 08/12's name resolution), and the connection's consent.
  Schema context uses step 05's DDL generator (names, types, keys), with the ignore list from
  step 16 applied. Output is the exact request body.
- **Preview**: the UI receives the exact payload text and size before sending; Send uses that same
  payload by id, so what was shown is what is sent.
- **Consent**: `ai_consents` table (connection id, scope, granted at, remember flag). Production
  sources default to None. Row samples need a consent every time unless "always allow" is set for
  that connection; row count capped and shown.
- **Request log**: stored locally (app.db) with timestamp, connection, action, payload (redacted
  key; rows only if they were sent), response summary; viewable and clearable.

## Tasks

### Backend

- [x] Store migration: `ai_consents`, `ai_request_log`.
- [x] Context builder for None and Schema levels, applying the ignore list.
- [x] Sample rows builder with cap and column exclusions, behind its own consent.
- [x] Prepared payload registry: preview returns an id; send accepts only that id.
- [x] Request log write, list and clear.

### IPC

- [x] Commands `ai_context_preview`, `ai_consent_get/set/revoke`, `ai_log_list`, `ai_log_clear`;
      capabilities and bindings.

### Frontend

- [x] Consent dialog per connection: level, remember, revoke later from Settings.
- [x] "What will be sent" disclosure with the exact text and size.
- [x] Row data consent prompt with the row cap and columns shown.
- [x] Request log viewer with Clear.

### Tests

- [x] Unit: ignored tables and columns never appear in any payload.
- [x] Unit: production connections default to None.
- [x] Unit: send with a payload id different from the previewed one is rejected.
- [x] Unit: no row data in a payload without the row consent.
- [x] Canary: API key never appears in the request log.

### Docs

- [x] Mark M6.2 done in `mvp-and-milestones.md`.

## Acceptance criteria

- [x] Every request shows its exact payload before sending.
- [x] Revoking consent takes effect on the next request.
- [x] The request log matches what was sent, byte for byte (minus the redacted key).

## Risks and open questions

- Large schemas exceed context limits; decide a size cap and how to choose objects (referenced
  first, then FK neighbours).

## Progress log

| Date       | Note                                                                                                                                                                                                                                                                                                                                                                             |
| ---------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 2026-10-24 | Consent levels: none, schema, schema and rows. A consent is remembered in `ai_consents` (migration 8) or kept in memory until restart; undecided means none, and the dialog preselects none for production sources and schema for the rest. Revoking (or changing) a consent discards waiting previews, and Send re-checks the consent, so a change applies to the next request. |
| 2026-10-24 | Size cap decided: the schema part stops at 60,000 characters and 40 objects, referenced objects first, then their foreign-key neighbours (one hop); anything left out is listed in the preview with the reason (ignored, too large, missing). Sample rows: up to 5 rows from up to 3 referenced tables, 200 characters per cell, ignored columns never selected.                 |
| 2026-10-24 | Schema text comes from the same CREATE TABLE renderer as Modify Table (step 06), fed a table model with ignored columns removed and every key, index, check, default and foreign key that names one dropped; views are described as comments (no definition).                                                                                                                    |
| 2026-10-24 | The provider now renders a request to exact bytes (`prepare`) and sends those bytes (`send`), so the previewed text, the bytes on the wire and the log entry are identical (tested against the stand-in API and the log). Sending is one command, `ai_send(payloadId)`, for every action; step 18's actions become task kinds of the preview.                                    |
| 2026-10-24 | Entry point for now: Ask AI (Ctrl+Alt+A, hidden from the palette while AI is unavailable) with consent, preview, send and a streamed answer that is never run. Step 18 turns it into the side panel with insert and diff.                                                                                                                                                        |
