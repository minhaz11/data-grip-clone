# Dependency advisories: assessments

Advisories that `npm audit` / `cargo audit` report but that we accept, with the reasoning. Revisit
on every dependency upgrade.

## dompurify ≤ 3.4.16 (five advisories, reported critical)

- **Advisories:** GHSA-p98j-92pf-mc4p, GHSA-6688-9rhm-gjv2 and GHSA-mrv2-3pqr-j5jr (`IN_PLACE`
  mode), GHSA-cg2g-xh64-v4q7 (`SAFE_FOR_TEMPLATES` with DOM output into a shadow root),
  GHSA-c6gr-qvv4-5v3f (`PARSER_MEDIA_TYPE: application/xhtml+xml`).
- **Path:** `monaco-editor@0.57.0` (the newest release) → `dompurify`. Monaco's ESM build does
  not import the npm package; it ships a vendored copy
  (`monaco-editor/esm/vs/base/browser/dompurify/dompurify.js`). An npm `overrides` entry would
  silence the audit without changing the shipped code, so we deliberately do not use one, and
  `npm audit fix --force` would only downgrade Monaco.
- **Reachability (checked 2026-10-24):** Monaco calls DOMPurify only from
  `vs/base/browser/domSanitize.js`, with its own config plus `RETURN_DOM_FRAGMENT` or
  `RETURN_TRUSTED_TYPE`. It never sets `IN_PLACE`, `SAFE_FOR_TEMPLATES` or
  `PARSER_MEDIA_TYPE`, which every one of the five advisories needs.
- **Our usage:** completion details and documentation built from database metadata (names,
  types, comments), and AI answers, are shown as plain text, never as markdown or HTML.
- **Decision:** accept. Upgrade Monaco when a release vendors DOMPurify ≥ 3.4.17.

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

## rustls-webpki 0.103.15 (RUSTSEC-2026-0382): fixed

- Certificate verification could accept distrusted intermediates. Updated to 0.103.16
  (2026-10-24), which the advisory names as the fix.

## Unmaintained, unsound or yanked transitive crates: accepted

`cargo audit` also warns about crates that come with the desktop shell's platform layers:

- `glib` 0.18 (RUSTSEC-2024-0429, unsound `VariantStrIter`) and `proc-macro-error`
  (RUSTSEC-2024-0370, unmaintained, build time only): Tauri's GTK stack on Linux (`tauri` →
  `muda` → `gtk`). Quarry never calls glib itself.
- `zbus_names`, `zvariant`, `zvariant_derive` (RUSTSEC-2026-0370 to 0372, unmaintained): the
  Secret Service backend of `keyring` on Linux.
- `clipboard-win` 5.4.1 (yanked): `tauri-plugin-clipboard-manager` → `arboard` on Windows.

None is a known vulnerability. Decision: accept, and take the fixed versions with the next
Tauri, keyring or clipboard plugin upgrade.
