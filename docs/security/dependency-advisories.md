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

## rsa (RUSTSEC-2023-0071, Marvin attack): low

- **Path:** `quarry-ssh` → `russh@0.64.1` (feature `rsa`) → `rsa@0.10.0-rc.18`. No fixed release
  exists; the advisory covers every version.
- **Fact:** the attack recovers an RSA private key by timing many private-key operations, chiefly
  PKCS#1 v1.5 decryption, from a vantage point that can measure them precisely.
- **Our usage:** the SSH client verifies RSA host keys (public-key operations, not affected) and,
  with an RSA user key, signs one authentication challenge per login. Quarry never decrypts with
  an RSA key and never acts as a server for anyone else's requests, so an attacker cannot drive
  the many timed operations the attack needs.
- **Why keep the feature:** without it, `id_rsa` keys and servers that offer only RSA host keys
  could not be used. Ed25519 and ECDSA keys do not touch this code.
- **Decision:** accept. Revisit when `rsa` ships a constant-time release or `russh` offers a
  backend without it.
