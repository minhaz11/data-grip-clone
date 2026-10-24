# Step 16: AI provider and settings

| Field        | Value                                     |
| ------------ | ----------------------------------------- |
| Milestone    | M6.1                                      |
| Status       | Done                                      |
| Depends on   | 02                                        |
| Requirements | REQ-AI-01, REQ-AI-11, REQ-AI-13; ADR-0005 |
| Started      | 2026-10-24                                |
| Finished     | 2026-10-24                                |

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

- [x] `ai-core` crate with the trait and request/response types.
- [x] `ai-anthropic` crate: Messages API with streaming, error mapping (auth, rate limit, overload,
      network), timeouts.
- [x] Keyring storage for the API key; write-only set; test command.
- [x] Settings: enabled, model, ignore list; kill switch enforced in Rust.

### IPC

- [x] Commands `ai_key_set`, `ai_key_clear`, `ai_test`, `ai_models`, `ai_settings_get/set`;
      capabilities and bindings.

### Frontend

- [x] Settings > AI: enable toggle, API key field (write-only), model selector, Test button.
- [x] "Where your data goes" text: this app sends requests directly to Anthropic with your key; no
      prompts are sent anywhere else.
- [x] Per-workspace disable and ignore list editor (tables, columns, patterns).

### Tests

- [x] Unit: SSE parsing including split chunks and error events.
- [x] Unit: kill switch blocks requests in Rust.
- [x] Canary: the API key never appears in `app.db`, logs or IPC responses.
- [x] Integration (optional, manual or gated by an env var): a real streaming call with a test key.

### Docs

- [x] Update ADR-0005 with the crate names and default model as built.
- [x] Mark M6.1 done in `mvp-and-milestones.md`.

## Acceptance criteria

- [x] With AI disabled, no network request leaves the app (verified by test on the provider).
- [x] The API key is stored only in the keyring and never returned over IPC.
- [x] A streamed response reaches the UI incrementally and can be cancelled.

## Risks and open questions

- Model ids change over time; the static fallback list needs updating with releases.

## Progress log

| Date       | Note                                                                                                                                                                                                                                                                                                                                         |
| ---------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 2026-10-24 | Built as `quarry-ai-core` and `quarry-ai-anthropic`. HTTPS through reqwest with a preconfigured rustls config (ring provider, system roots), the same crypto as the PostgreSQL TLS, so no second crypto backend. API version `2026-10-21`, so no sampling parameters are ever sent.                                                          |
| 2026-10-24 | The kill switch is a `KillSwitch` checked by the `Switched` provider wrapper before any call, and by the desktop before the keyring is even read. Off by default; turning AI off (or off for the workspace) aborts running requests. Model lists come from the built-in fallback while AI is off, so the selector works without any network. |
| 2026-10-24 | Requests for models that support it carry `fallbacks: "default"` (beta `server-side-fallback-2026-07-01`), so a request the model declines for policy reasons is retried server-side on the recommended model; Haiku has no server-side fallback and gets none. A `refusal` stop reason is reported to the UI.                               |
| 2026-10-24 | Streaming to the UI goes through a Tauri `Channel`; Settings > AI > Test streams a one-line answer (no database data) and Cancel aborts the task, which drops the stream and closes the connection (tested against a local stand-in API). The real call is `live_api.rs`, ignored unless `QUARRY_ANTHROPIC_TEST_KEY` is set.                 |
| 2026-10-24 | Added `ai_cancel` to the planned commands. There is one workspace today; per-workspace switches are keyed by its id (`main`). The ignore list is stored and matched in `quarry-store` (`ignores_table`, `ignores_column`); step 17 applies it.                                                                                               |
