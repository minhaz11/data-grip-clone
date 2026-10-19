# ADR-0005 — AI assistant: provider abstraction, consent, no auto-execution

- Status: **Accepted** (2026-10-19)

## Context

Users want natural-language → SQL, explanation, error fixing, and optimisation. Sending schema or rows
to a third party is a data-governance decision. DataGrip's shipped AI module (00-methodology, E4)
separates four permission classes (read schema, read data, modify data, modify schema). It asks for
per-statement consent when a class is not pre-granted, and falls back to "unknown → ask" when it
cannot classify a statement.

## Decision

- `crates/ai-core` defines an `AiProvider` trait: `complete(request) -> stream of tokens`, model list,
  and capability flags.
  - The first implementation is `ai-anthropic`, which calls the official Anthropic Messages API from
    Rust (streaming).
  - The API key lives in the OS keyring (ADR-0003). The model ID is a user setting; the default is the
    current Claude Sonnet model and the selector lists the current family.
  - Other providers (e.g. a local model) can be added behind the same trait.
- The **Context builder** decides what leaves the machine. Per connection, the user chooses:
  - **None**: SQL text in the editor only.
  - **Schema**: the names/types/keys of objects the user selects, or that the query references.
  - **Schema + sample rows**: Later, off by default, with a row cap and column exclusions.
    Before any send, the UI shows the exact context payload in a "What will be sent" disclosure.
    Production-tagged connections default to **None**.
- **No auto-execution.** AI output goes to a diff/preview pane. The user must:
  1. Insert it into the editor.
  2. Run it with the normal Execute action, which applies all normal guards (read-only, destructive
     confirmation, production confirmation).
- There is no "AI runs SQL" agent loop in the MVP. If added later, every statement passes the
  `StatementClassifier`:
  - Writes and DDL always need explicit consent.
  - Unclassifiable statements are treated as writes.
- Prompts include the dialect name and server version so that generated SQL targets the right engine.
- All AI requests are logged locally (redacted, no row data). The user can view and clear this log.

## Consequences

- The AI module depends on `db-core` metadata types, never on a live session.
- Offline or no-key state is handled with a clear empty state, not a broken panel.
