# Step 17: AI consent and context

| Field        | Value                                     |
| ------------ | ----------------------------------------- |
| Milestone    | M6.2                                      |
| Status       | Not started                               |
| Depends on   | 05, 16                                    |
| Requirements | REQ-AI-06, REQ-AI-07, REQ-AI-10; ADR-0005 |
| Started      | -                                         |
| Finished     | -                                         |

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

- [ ] Store migration: `ai_consents`, `ai_request_log`.
- [ ] Context builder for None and Schema levels, applying the ignore list.
- [ ] Sample rows builder with cap and column exclusions, behind its own consent.
- [ ] Prepared payload registry: preview returns an id; send accepts only that id.
- [ ] Request log write, list and clear.

### IPC

- [ ] Commands `ai_context_preview`, `ai_consent_get/set/revoke`, `ai_log_list`, `ai_log_clear`;
      capabilities and bindings.

### Frontend

- [ ] Consent dialog per connection: level, remember, revoke later from Settings.
- [ ] "What will be sent" disclosure with the exact text and size.
- [ ] Row data consent prompt with the row cap and columns shown.
- [ ] Request log viewer with Clear.

### Tests

- [ ] Unit: ignored tables and columns never appear in any payload.
- [ ] Unit: production connections default to None.
- [ ] Unit: send with a payload id different from the previewed one is rejected.
- [ ] Unit: no row data in a payload without the row consent.
- [ ] Canary: API key never appears in the request log.

### Docs

- [ ] Mark M6.2 done in `mvp-and-milestones.md`.

## Acceptance criteria

- [ ] Every request shows its exact payload before sending.
- [ ] Revoking consent takes effect on the next request.
- [ ] The request log matches what was sent, byte for byte (minus the redacted key).

## Risks and open questions

- Large schemas exceed context limits; decide a size cap and how to choose objects (referenced
  first, then FK neighbours).

## Progress log

| Date | Note |
| ---- | ---- |
