# Implementation Plans and Progress Tracker

This folder turns the [feature roadmap](feature-roadmap.md) into one plan per step. Each step is
small enough to finish, review and verify on its own. Work through them in the order below unless
a dependency says otherwise.

## How to track progress

1. When you start a step, set its **Status** to `In progress` in both the step file's header table
   and the tracker below, and fill in **Started**.
2. Tick checkboxes (`- [x]`) in the step file as tasks land. Tasks and acceptance criteria are
   both checkboxes, so the count reflects real verification, not just code written.
3. Add a dated line to the step's **Progress log** for anything worth remembering: decisions,
   surprises, blockers, links to commits or PRs.
4. A step is `Done` only when every acceptance criterion is ticked and the checks in the root
   README pass. Then set **Finished**, update the tracker, and mark the milestone done in
   [`../architecture/mvp-and-milestones.md`](../architecture/mvp-and-milestones.md) with a short
   "Done:" summary, as earlier milestones do.
5. If scope changes, edit the step file (move items to **Out of scope** or a later step) rather
   than leaving boxes unticked forever.

Status values: `Not started`, `In progress`, `Blocked` (say why in the progress log), `Done`.

Print the current counts from the step files:

```bash
scripts/plan-progress.sh
```

The script reads each file's Status row and counts ticked and unticked checkboxes. The table below
is the human summary; refresh its Progress column from the script output when you update a step.

## Tracker

| #   | Step                                                              | Milestone        | Depends on | Status      | Progress |
| --- | ----------------------------------------------------------------- | ---------------- | ---------- | ----------- | -------- |
| 01  | [Generated IPC bindings and docs alignment](01-ipc-bindings.md)   | M0.1             | -          | Done        | 100%     |
| 02  | [Quality and safety infrastructure](02-quality-infrastructure.md) | M0.2             | -          | In progress | 86%      |
| 03  | [Transactions and sessions](03-transactions-sessions.md)          | M4.6             | 01         | In progress | 97%      |
| 04  | [Table viewer and richer metadata](04-table-viewer-metadata.md)   | M4.3             | 01         | Done        | 100%     |
| 05  | [DDL generation](05-ddl-generation.md)                            | M4.4             | 04         | Done        | 100%     |
| 06  | [Schema change tools](06-schema-change-tools.md)                  | M4.5             | 03, 05     | Done        | 100%     |
| 07  | [Result grid gaps and table browsing](07-result-grid.md)          | M4.8             | 03, 04     | Done        | 100%     |
| 08  | [Editor gaps](08-editor.md)                                       | M4.7             | 03         | Done        | 100%     |
| 09  | [Query history](09-query-history.md)                              | M5.1             | 03         | Done        | 100%     |
| 10  | [Keymap and action registry](10-keymap-actions.md)                | M5.3             | 01         | Done        | 100%     |
| 11  | [Connection gaps](11-connections.md)                              | M4.9             | 02         | Not started | 0%       |
| 12  | [Layout, navigation and explorer](12-layout-navigation.md)        | M4.10            | 05, 10     | Not started | 0%       |
| 13  | [CSV/JSON import](13-import.md)                                   | M5.4             | 06         | Not started | 0%       |
| 14  | [Local file history](14-file-history.md)                          | M5.2             | -          | Not started | 0%       |
| 15  | [Snippets](15-snippets.md)                                        | M5.5             | 10         | Not started | 0%       |
| 16  | [AI provider and settings](16-ai-provider.md)                     | M6.1             | 02         | Not started | 0%       |
| 17  | [AI consent and context](17-ai-consent-context.md)                | M6.2             | 05, 16     | Not started | 0%       |
| 18  | [AI actions](18-ai-actions.md)                                    | M6.3             | 17         | Not started | 0%       |
| 19  | [Hardening and release](19-hardening-release.md)                  | Phase 7          | all        | Not started | 0%       |
| 20  | [Release automation](20-release-automation.md)                    | Release pipeline | -          | In progress | 57%      |

Steps 01 and 02 are foundations: they are not user features, but later steps rely on them
(generated bindings before many new commands; the redacting logger and secret scanning before SSH
and AI keys). Steps 14 and 20 have no dependency and can be picked up in parallel with anything.
Step 20 is listed last but is already usable: it ships whatever is on `main` today, and step 19
adds signing on top of it.

## Step file layout

Every step file uses the same sections, so they can be scanned the same way:

- **Header table**: milestone, status, dependencies, requirements, dates.
- **Goal**: the user-visible outcome in a few lines.
- **Scope** and **Out of scope**.
- **Design notes**: backend, IPC, storage and frontend decisions, with the files expected to change.
- **Tasks**: checkboxes grouped by Backend, IPC, Frontend, Tests, Docs.
- **Acceptance criteria**: checkboxes; each must be verified, not assumed.
- **Risks and open questions**: things to decide or verify before or during the step.
- **Progress log**: dated notes.

The global acceptance rules in `mvp-and-milestones.md` apply to every step: no control is rendered
before it works, no hardcoded results outside tests, and every destructive or production-write
path has an automated test proving the confirmation is required.
