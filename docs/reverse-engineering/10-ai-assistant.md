# 10 — AI Assistant

## Sources

All fetched 2026-10-19 (WebFetch returns a model-generated summary, not raw HTML).

- https://www.jetbrains.com/help/datagrip/ai-assistant.html
- https://www.jetbrains.com/help/datagrip/use-ai-in-editor.html
- https://www.jetbrains.com/help/datagrip/use-prompts-to-explain-and-refactor-your-code.html
- https://www.jetbrains.com/help/ai-assistant/use-ai-with-databases.html
- https://www.jetbrains.com/help/ai-assistant/find-and-fix-problems-with-ai.html
- https://www.jetbrains.com/help/ai-assistant/ai-chat.html
- https://www.jetbrains.com/help/ai-assistant/how-we-handle-your-code-and-data.html
- https://www.jetbrains.com/help/ai-assistant/use-custom-models.html
- https://www.jetbrains.com/help/ai-assistant/disable-ai-assistant.html
- https://www.jetbrains.com/help/ai-assistant/getting-started-with-ai-assistant.html
- https://www.jetbrains.com/help/datagrip/services-tool-window.html (Query Plan tab, "Analyze SQL Plan with AI")
- Fetch failures (404): https://www.jetbrains.com/help/datagrip/ai-chat.html, https://www.jetbrains.com/help/ai-assistant/generate-code.html, https://www.jetbrains.com/help/ai-assistant/explain-code.html
- Search-snippet only, not fetched (weak, marked "snippet"): generate-code shortcut and accept/discard flow; 2024.1 schema attachment limits (table and column names, max 50 tables, consent required); @dbObject mention syntax; Explain/Fix on error introduced in 2024.3.

## Evidence legend

- [DOC] stated in fetched official JetBrains docs.
- [REA] static inventory of DataGrip's intellij.database.ai.jar (ev_4cd56ab7...27ae7, 91 entries) plus its UI string bundle; runtime behavior not observed.
- [CFG] none relevant.
- [ASSUMPTION] our inference, not verified.

## Observed workflows

1. **Overview.** AI Assistant is a plugin adding AI features to DataGrip (and most JetBrains IDEs): coding agents (Junie, Claude Agent, Codex, GitHub Copilot), external agents via ACP, MCP tools, AI Chat, in-editor completion [DOC]. Setup options: JetBrains AI subscription, bring-your-own-key, provider-account authorization of agents, local models [DOC]. An older page indicates the plugin is not bundled/enabled by default; newer docs state the database skills are on by default once available (conflicting dates) [DOC / snippet].
2. **Generate SQL from natural language.** In AI Chat, the bundled `database-text-to-sql` skill converts a plain-language request to SQL; the agent first explores the real schema instead of guessing names, and may run the query to verify when safe and allowed [DOC, 2026.2]. In-editor "Generate Code" (toolbar / AI Actions menu, prompt box, accept / regenerate / refine) is reported by search snippet only; the fetched in-editor page says only that AI can complete lines and blocks [DOC + snippet]. If code is selected, only that selection is changed [snippet].
3. **Database skills.** Three bundled skills: `database-tools`, `database-connection-management`, `database-text-to-sql`; enabled by default with MCP tools on; toggle under Settings > Tools > AI Assistant > Skills; available only in AI chat, not CLI [DOC]. Agents can browse schemas, inspect metadata, preview data and run queries on the live connection only when settings and permissions allow; only a small sample of results enters the agent context to save tokens [DOC]. Agents can also create/edit data sources and test connections (tools `create_database_connection`, `edit_database_connection`) [DOC].
4. **Explain query / plan.** Run Explain Plan or Explain Analyse in a console; in the Query Plan tab click "Analyze SQL Plan with AI" (2026.1+) to get an explanation in chat [DOC]. "Find Problems" on a selection opens chat with analysis [DOC].
5. **Fix SQL errors (editor).** Caret on highlighted code -> Alt+Enter -> AI Actions -> "Fix SQL problem under caret"; for syntax errors, Alt+Enter -> "Fix with AI Assistant"; fix appears in the editor; fixes only offered for severity above weak warning; 2024.3+ [DOC].
6. **Explain / Fix on execution errors.** After a query fails, "Explain with AI" opens chat with an auto-sent prompt and explanation (follow-ups allowed); "Fix with AI" produces a fix in the editor, then a "Do you like the generated result?" Yes/No popup [DOC]. May need the database schema attached for better output [DOC].
7. **Optimise.** Right-click -> AI Actions -> "Optimize Query with AI" (2026.1+): detects redundant joins, missing indexes, poor plans; suggests or rewrites; can use Explain Plan output; may require attaching the schema [DOC].
8. **Schema / context attachment.** In AI Chat you add database objects, files, folders, symbols, commits as context via an Add attachment button; "Add attachment" supports files, folders, images, symbols [DOC]. Attaching a database schema is called out as improving explanations/fixes; no step list is given in fetched pages [DOC]. Mentioning a database object with `@`/`#` and a 50-table, names-only cap from 2024.1 are snippet-only [snippet]. Chat mode does not auto-apply changes; the user applies code; agents can edit, with keep/rollback [DOC].
9. **Models and providers.** Providers & API keys (Settings > Tools > AI Assistant): Anthropic, Google, OpenAI, OpenAI-compatible endpoints; Test Connection button; models assigned to features from predefined lists; some features unavailable with third-party models; completion uses JetBrains models unless a separate completion provider is set; local models (Ollama/LM Studio) cannot be used by agents or MCP tools [DOC].
10. **Data sharing and consent.** Prompts and pieces of code (plus context such as file type, frameworks, open file or selection) go to the LLM provider [DOC]. With a JetBrains subscription the JetBrains service forwards the request; with BYOK it goes directly to your provider [DOC via search summary of data-handling page; fetched page confirms only "prompts and pieces of code go to the provider"]. Opt-in detailed data collection (full LLM communication) is off by default, at Settings > Appearance & Behavior > System Settings > Data Sharing > "Send detailed code-related data" [DOC]. The fetched data-handling page states that in DataGrip the assistant does not share or access database data [DOC]; the database-skills page, however, describes agents running queries and reading result samples when permitted [DOC]. These two statements are in tension and were not reconciled [DOC conflict].
11. **Consent, controls, audit.** A request log `ai-assistant-requests.md` records prompts sent (current session only; open via Search Everywhere "Open AI Assistant Requests Log in Editor"; needs Markdown plugin) [DOC]. Disable per project via the widget, permanently via plugin, or an empty `.noai` file in project root; `.aiignore` (gitignore syntax) excludes files, with a warning that ignored files may occasionally still be processed; network-level blocking of JetBrains AI hosts is possible [DOC]. No first-use consent dialog is described in the fetched pages [DOC, absence].
12. **Per-statement permission model (static).** [REA] "AI Tools" settings page (Tools > Database) with a "Permissions" group: allow without confirmation (1) reading schemas (noted: better quality, higher quota), (2) reading data (e.g. SELECT), (3) modifying data (INSERT/UPDATE/DELETE, routine calls), (4) modifying schemas (CREATE/ALTER/DROP). If not pre-allowed, a consent dialog names the data source and schema with Allow/Deny and an "always allow" checkbox; data-read warns that data is sent to the model; an "unknown" fallback consent applies when dialect safety analysis is unavailable. Class names suggest QuerySafetyAnalyzer, DbOperationType, QueryResultTextMapper (result set -> text for model). Static only.

## Keyboard shortcuts

| Action                                           | Windows/Linux                            | Source    |
| ------------------------------------------------ | ---------------------------------------- | --------- |
| Show intention actions (Fix with AI, AI Actions) | Alt+Enter                                | [DOC]     |
| Open Search Everywhere (request log command)     | Shift Shift                              | [DOC]     |
| Open settings                                    | Ctrl+Alt+S                               | [DOC]     |
| In-editor Generate Code                          | Ctrl+\ (reported in search snippet only) | [snippet] |

## Edge cases and error states

- Plan explanation and optimization require 2026.1+; error Explain/Fix need 2024.3+ [DOC].
- Features may be unavailable with third-party models; if no assigned model exists, the feature is hidden [DOC].
- Local models: no agents/MCP [DOC].
- `.aiignore` is best-effort; invoking AI on an ignored file shows an "AI Has No Access to This File" warning [DOC].
- Statement-safety analysis may not exist for a dialect, forcing a conservative "unknown" consent [REA].
- Only a small sample of query results is passed to the agent; truncation affects answers [DOC].
- Docs state data-sharing opt-in is centrally managed for company licenses [snippet].
- Conflicting documentation on whether DataGrip AI touches database data (item 10) [DOC].

## Implementation requirements for our app

- REQ-AI-01 (MVP): AI provider abstraction (interface: complete(messages, tools?, options) -> stream) with an Anthropic (Claude) implementation first; API key stored in the OS keychain; connection test; model selectable; no other provider required for MVP.
- REQ-AI-02 (MVP): Natural-language-to-SQL: user prompt plus selected dialect and optional schema context produces SQL shown in a preview/diff pane; the user must explicitly Insert/Apply it into the editor. AI output is never auto-executed, including when the agent suggests a run.
- REQ-AI-03 (MVP): "Explain query" and "Explain error": send the statement and error text (no rows) to the model; show the answer in a side panel.
- REQ-AI-04 (MVP): "Fix with AI" on an execution error or editor diagnostic: show proposed corrected SQL as a diff; apply only on user click.
- REQ-AI-05 (Later): "Optimize query" with optional EXPLAIN output attached by the user.
- REQ-AI-06 (MVP): Schema context is off by default. A consent step lets the user choose what to attach: nothing / selected objects (names and DDL) / whole schema, with a preview of the exact payload and a size estimate; consent is per connection, revocable, and remembered only if the user opts in.
- REQ-AI-07 (MVP): Row data is never sent without a separate explicit consent each time (or per-connection "always allow" the user sets); sample sizes are capped and shown before sending; defaults to schema-only.
- REQ-AI-08 (MVP): Permission model for any future tool use by the model, modelled on four classes: read schema, read data, modify data, modify schema; default deny for all; per-statement confirmation showing connection, schema and SQL; unknown/unparseable statements treated as the highest risk class.
- REQ-AI-09 (MVP): Any SQL the AI proposes passes through the destructive-statement guard (file 09) and read-only/production flags before execution.
- REQ-AI-10 (MVP): Request log: local, per-session, viewable and clearable record of exactly what was sent to the provider (redacting the API key).
- REQ-AI-11 (MVP): Global kill switch plus per-workspace disable, and an ignore list for tables/columns that must never be attached.
- REQ-AI-12 (Later): Chat panel with attachable context chips (tables, saved queries); tool-calling agent mode with sampled results only.
- REQ-AI-13 (MVP): Clear UI statement of where data goes (our app -> Anthropic API with the user's key), no telemetry of prompts by us.

## Limitations / not verified

- No live UI capture was made; docs were read through a summarising fetch tool.
- Not in fetched docs: the in-editor "Generate Code" page itself (404), the datagrip-domain `ai-chat.html` (404), `generate-code.html` and `explain-code.html` (404), exact shortcuts, schema attachment steps, consent prompts on first use, and the attached-schema payload format. Snippet-only items are labelled and should not be treated as verified.
- Docs list conflicting statements about database data access (item 10) that remain unresolved.
- [REA] material is static analysis of a jar and string bundle; consent dialogs and Permissions behavior were not observed at runtime.
- Pricing, quota behavior and model lists are out of scope and not verified.
