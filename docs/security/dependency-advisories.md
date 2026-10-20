# Dependency advisories: assessments

Advisories that `npm audit` / `cargo audit` report but that we accept, with the reasoning. Revisit
on every dependency upgrade.

## dompurify ≤ 3.4.15 (GHSA-p98j-92pf-mc4p, GHSA-6688-9rhm-gjv2): low

- **Path:** `monaco-editor@0.57.0` → `dompurify@3.4.15`.
- **Fact:** Monaco's ESM build does not import the npm package. It ships a vendored copy
  (`monaco-editor/esm/vs/base/browser/dompurify/dompurify.js`, version 3.4.15). An npm `overrides`
  entry would silence the audit without changing the shipped code, so we deliberately do not
  use one.
- **Reachability:** both advisories require DOMPurify's `IN_PLACE` sanitize mode. A search of
  `monaco-editor/esm` (2026-10-19) finds no `IN_PLACE` use outside the library itself. Monaco
  sanitizes rendered markdown (hovers, completion docs) with the default, copy-based mode.
- **Our usage:** completion details and documentation built from database metadata (names,
  types, comments) are passed as plain strings, never as markdown or HTML.
- **Decision:** accept for now. Upgrade Monaco when a release vendors DOMPurify ≥ 3.4.16.

## Tauri `freezePrototype` is off (Monaco incompatibility)

- **Fact:** with `app.security.freezePrototype: true`, Monaco fails at module load in the desktop
  app (`KeyCodeUtils.toString = toString` in `vs/base/common/keyCodes.js` throws). Freezing
  `Object.prototype` makes inherited properties such as `toString` read-only, and strict-mode code
  that assigns them on ordinary objects throws (the "override mistake"). Observed 2026-10-20 in
  WebKitGTK 2.52; the browser preview has no freeze and worked.
- **Decision:** `freezePrototype: false`. The setting only defends against prototype-pollution
  gadgets in our own frontend code.
- **Remaining protections:**
  - A strict CSP (`script-src 'self'`, no remote origins).
  - A capability allow-list of our own commands only.
  - No secrets in the WebView.
  - All SQL and file access is mediated by validated Rust commands.
- **Revisit** if Monaco stops assigning prototype-shadowing properties, or if we can freeze after
  Monaco has loaded without breaking later lazily loaded Monaco modules.
