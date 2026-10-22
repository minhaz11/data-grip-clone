# Step 20: Release automation

| Field        | Value                                         |
| ------------ | --------------------------------------------- |
| Milestone    | Release pipeline                              |
| Status       | In progress                                   |
| Depends on   | -                                             |
| Requirements | Phase 7 "Installers" in mvp-and-milestones.md |
| Started      | 2026-10-22                                    |
| Finished     | -                                             |

## Goal

Releases need no manual version edits or local builds. Every push to `main` keeps one release PR up
to date with the next version and its changelog. Merging that PR builds the Linux, Windows and
macOS installers in GitHub Actions and publishes a GitHub release with them attached.

## Scope

- Automatic version bump from commit messages, with a manual override.
- A single, continuously updated release PR (`release/next`).
- `CHANGELOG.md` maintained by the pipeline.
- On merge: draft release, three-OS build matrix, publish only if every build succeeds.
- Optional macOS signing and notarization when the secrets exist.

## Out of scope

- Obtaining signing certificates (step 19).
- Auto-update (`tauri-plugin-updater`): needs an update signing key and a manifest; decide later.
- Pre-releases and release channels.

## How it works

```
push to main ──► release-pr.yml ──► version.mjs prepare ──► PR "chore: release vX.Y.Z"
                                                             (branch release/next, label release)
merge the PR ──► release.yml
                   ├─ create-release: draft release vX.Y.Z with notes from CHANGELOG.md
                   ├─ build (matrix): ubuntu-22.04, windows-latest, macos-latest (universal)
                   │    tauri-action builds and uploads the installers to the draft
                   └─ publish: undraft and mark latest (only if all builds passed)
```

- **Version rules** (`scripts/release/version.mjs`), from commits since the last `v*` tag:
  - `feat` (including the org form `feat:[KPDV2-123] summary`) bumps minor.
  - Anything else (`fix`, other types, or free-form subjects such as `M4.2: ...`) bumps patch.
  - A breaking change (`feat!:` or a `BREAKING CHANGE:` footer) bumps major, or minor while the
    major version is 0.
  - No commits since the last tag: no PR.
  - No tag at all: the first release ships the version already in the files (0.1.0 today).
  - Run the "Release PR" workflow manually to force `patch`, `minor` or `major`.
- **Version files**: `tauri.conf.json`, `apps/desktop/package.json`, `src-tauri/Cargo.toml`, and
  the matching entries in `Cargo.lock` and `package-lock.json`. The domain crates keep their own
  versions (they are not published).
- **Release commits** (`chore: release vX.Y.Z`) are skipped when computing the next version, and
  the push that merges the release PR does not open a new PR (it would race with the new tag).
- **Draft first**: if any OS build fails, the release stays a draft; fix and re-run the failed job
  from the Actions page, and `publish` runs when all builds pass.

## One-time repository setup

1. Settings > Actions > General > Workflow permissions: "Read and write permissions", and tick
   "Allow GitHub Actions to create and approve pull requests".
2. Create the `release` label (the workflow adds it to the PR).
3. Recommended: a `RELEASE_TOKEN` secret (fine-grained PAT or GitHub App token with Contents and
   Pull requests write). Without it the release PR is opened by `GITHUB_TOKEN`, and GitHub does not
   run CI on PRs opened that way.
4. Optional, for signed macOS builds: `APPLE_CERTIFICATE` (base64 .p12),
   `APPLE_CERTIFICATE_PASSWORD`, `APPLE_SIGNING_IDENTITY`, and for notarization `APPLE_ID`,
   `APPLE_PASSWORD` (app-specific password), `APPLE_TEAM_ID`.
5. Merge the release PR with squash or a merge commit; both are handled.

## Tasks

### Scripts

- [x] `scripts/release/version.mjs`: `current`, `prepare [--bump]`, `notes <version>`.
- [x] Commit parsing for conventional commits and the org `type:[TICKET] summary` form.
- [x] Version written into all five version files, failing loudly if a pattern is not found.
- [x] `CHANGELOG.md` section rendering (Breaking, Features, Fixes, Other) and notes extraction.
- [x] Unit tests (`npm run test:release`), also run in CI.

### Workflows

- [x] `.github/workflows/release-pr.yml`: push to main and manual dispatch with a bump choice.
- [x] `.github/workflows/release.yml`: draft release, three-OS matrix with `tauri-action`, publish.
- [x] Optional macOS signing and notarization from secrets.
- [ ] Windows code signing (after step 19 obtains a certificate).
- [ ] Linux: decide whether to also ship `.rpm` (bundle targets are `all` today, so rpm is built).

### Repository setup

- [ ] Workflow permissions and "allow Actions to create PRs" enabled.
- [ ] `release` label created.
- [ ] `RELEASE_TOKEN` secret added.

### Docs

- [x] This plan, with the setup steps above.
- [x] Root README "Releases" section.

## Acceptance criteria

- [x] Dry run in a scratch clone: first release keeps 0.1.0; after a tag and a `feat:[X]` commit,
      `prepare` bumps all five files to 0.2.0 and writes the changelog; with no new commits it
      reports `release=false`; the edited `Cargo.lock` passes `cargo metadata --locked`; the
      generated `CHANGELOG.md` passes Prettier.
- [x] `actionlint` passes on all workflows.
- [ ] A push to `main` opens or updates the release PR on GitHub.
- [ ] Merging the release PR publishes a release with Linux (AppImage, deb), Windows (MSI, NSIS)
      and macOS (dmg) installers attached.
- [ ] Each installer launches on its OS.
- [ ] A failed build leaves the release as a draft.

## Risks and open questions

- `tauri-action` is pinned to the `v0` tag; pin to a full version or SHA once the first run works.
- Unsigned builds: macOS Gatekeeper and Windows SmartScreen will warn users until step 19 adds
  signing.
- `ubuntu-22.04` runners will be retired eventually; move to the oldest supported Ubuntu then.

## Progress log

| Date       | Note                                                                                                             |
| ---------- | ---------------------------------------------------------------------------------------------------------------- |
| 2026-10-22 | Scripts, tests and workflows written; verified locally (unit tests, dry run, actionlint). Not yet run on GitHub. |
