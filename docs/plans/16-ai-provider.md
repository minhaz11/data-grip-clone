# Step 16: AI provider and settings

| Field        | Value                                     |
| ------------ | ----------------------------------------- |
| Milestone    | M6.1                                      |
| Status       | Not started                               |
| Depends on   | 02                                        |
| Requirements | REQ-AI-01, REQ-AI-11, REQ-AI-13; ADR-0005 |
| Started      | -                                         |
| Finished     | -                                         |

## Goal

The backend can talk to Anthropic's Messages API with streaming, using an API key that lives only
in the OS keyring, and the user controls whether AI is on at all.

## Scope

- `crates/ai-core` (`AiProvider` trait) and `crates/ai-anthropic`.
- AI settings: API key (write-only), model selector, connection test.
- Global kill switch, per-workspace disable, table/column ignore list (stored; used in step 17).
- A plain statement of where data goes.

## Out of scope

- Context building and consent (step 17); user-facing AI actions (step 18).
- Other providers (the trait allows them later).

## Design notes

- **Trait**: `complete(request) -> stream of events` (text deltas, stop reason, usage), `models()`,
  capability flags. Requests carry system prompt, messages and options; no tools in the MVP.
- **Anthropic client**: HTTPS from Rust with `reqwest` (rustls) and server-sent events parsing.
  The WebView never calls the network (no http plugin; CSP stays `'self'`).
- **Model**: a user setting. Default to the current Claude Sonnet model at implementation time
  (today `claude-sonnet-5-5`); the selector lists the current family from the models endpoint, with
  a static fallback list.
- **Key**: keyring entry `ai:anthropic:api-key`, written by a write-only command; the UI shows
  "stored" and "Change". The redacting logger (step 02) scrubs the key pattern.
- **Streaming to UI**: a Tauri `Channel` per request, as query jobs do; cancel by dropping the
  request.
- **Kill switch**: a setting checked in Rust before any request; when off, AI commands return a
  clear error and the UI hides AI entry points.

## Tasks

### Backend

- [ ] `ai-core` crate with the trait and request/response types.
- [ ] `ai-anthropic` crate: Messages API with streaming, error mapping (auth, rate limit, overload,
      network), timeouts.
- [ ] Keyring storage for the API key; write-only set; test command.
- [ ] Settings: enabled, model, ignore list; kill switch enforced in Rust.

### IPC

- [ ] Commands `ai_key_set`, `ai_key_clear`, `ai_test`, `ai_models`, `ai_settings_get/set`;
      capabilities and bindings.

### Frontend

- [ ] Settings > AI: enable toggle, API key field (write-only), model selector, Test button.
- [ ] "Where your data goes" text: this app sends requests directly to Anthropic with your key; no
      prompts are sent anywhere else.
- [ ] Per-workspace disable and ignore list editor (tables, columns, patterns).

### Tests

- [ ] Unit: SSE parsing including split chunks and error events.
- [ ] Unit: kill switch blocks requests in Rust.
- [ ] Canary: the API key never appears in `app.db`, logs or IPC responses.
- [ ] Integration (optional, manual or gated by an env var): a real streaming call with a test key.

### Docs

- [ ] Update ADR-0005 with the crate names and default model as built.
- [ ] Mark M6.1 done in `mvp-and-milestones.md`.

## Acceptance criteria

- [ ] With AI disabled, no network request leaves the app (verified by test on the provider).
- [ ] The API key is stored only in the keyring and never returned over IPC.
- [ ] A streamed response reaches the UI incrementally and can be cancelled.

## Risks and open questions

- Model ids change over time; the static fallback list needs updating with releases.

## Progress log

| Date | Note |
| ---- | ---- |
