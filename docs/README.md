# Quarry (working name) — Documentation Index

## Phase 0 deliverables

- **Reverse engineering** (observable behaviour of the reference product; evidence-tagged):
  - [00 — Methodology, REA capability report, evidence inventory](reverse-engineering/00-methodology-and-evidence.md)
  - [01 Layout & shortcuts](reverse-engineering/01-layout-navigation-shortcuts.md) ·
    [02 Connections](reverse-engineering/02-connections.md) ·
    [03 Explorer](reverse-engineering/03-database-explorer.md) ·
    [04 SQL editor](reverse-engineering/04-sql-editor.md) ·
    [05 Result grid](reverse-engineering/05-result-grid.md)
  - [06 Schema tools](reverse-engineering/06-schema-table-tools.md) ·
    [07 Import/export](reverse-engineering/07-import-export.md) ·
    [08 History/consoles/environments](reverse-engineering/08-history-consoles-environments.md) ·
    [09 Errors & confirmations](reverse-engineering/09-errors-dialogs-confirmations.md) ·
    [10 AI](reverse-engineering/10-ai-assistant.md)
  - REA evidence bundle: [evidence/](reverse-engineering/evidence/)
- **Architecture**
  - [Overview: process model, modules, IPC, safety model, testing](architecture/overview.md)
  - [MVP, milestones, acceptance criteria](architecture/mvp-and-milestones.md)
  - Decisions:
    - [0001 Tauri over Electron](architecture/decisions/0001-desktop-shell-tauri.md)
    - [0002 DB adapter + tokio-postgres](architecture/decisions/0002-database-adapter-and-postgres-driver.md)
    - [0003 Secrets](architecture/decisions/0003-secrets-and-credential-storage.md)
    - [0004 Local storage](architecture/decisions/0004-local-app-storage.md)
    - [0005 AI provider & consent](architecture/decisions/0005-ai-provider-and-consent.md)
    - [0006 SQL splitter and classifier in TypeScript](architecture/decisions/0006-sql-splitter-and-classifier-in-typescript.md)
- **Plans**
  - [Feature roadmap: what is still missing](plans/feature-roadmap.md)
