# iOS UI polish cluster

**Status**: brainstorm v1 (orchestrator-drafted 2026-05-17,
vjt-blessed via `project_ios_ui_polish_cluster_planned` memory).
Implementation NOT started. iOS-1 cleared to begin.

| Bucket | Status | Deploy | Notes |
|--------|--------|--------|-------|
| iOS-1 — viewport lock (no pinch-zoom, no page scroll) | brainstorm | cic-bundle | `index.html` meta + `html,body` CSS |
| iOS-2 — safe-area insets on top + bottom bars | brainstorm | cic-bundle | `env(safe-area-inset-*)` wraps |
| iOS-3 — bottom-bar tab close × | brainstorm | cic-bundle | Add × per tab, wire to existing handlers |
| iOS-4 — font-size selector in SettingsDrawer | brainstorm | cic-bundle | `--font-size` override via localStorage |
| iOS-Z — cluster CLOSE | brainstorm | n/a | Composed e2e journey + docs sweep + memory close file |

**Branch**: main (worktree not required — bucket-sized work directly
on main per recent post-arc cadence, with per-bucket commit + push).
**Position**: post-`u-cap-honesty` (CP37) + post `nick-case-sensitivity`
fix (commit 24b23e9). Next workstream after iOS-Z: full codebase review
per `project_post_tmu_full_review_scheduled`, then bastille deploy per
`project_bastille_deploy_workstream`.

**Origin evidence**: vjt 2026-05-16 night, captured as
`project_ios_ui_polish_cluster_planned`. cic UI on iOS Safari is
painful per vjt's own use. Concrete issues caught in evening session.

## Goal

**Make cic on iPhone feel like a native app.** Four mechanical UX
fixes — no architecture changes, no server changes, no new wire
protocol shapes. cic owns mobile UX entirely (per
`feedback_no_localized_strings_server_side`).

**What we are NOT building.**
- NO server-side font-size persistence. localStorage only.
- NO native iOS app wrapper. Still a PWA / web app via
  `apple-mobile-web-app-capable=yes`.
- NO swipe-gesture navigation rework. Pinch-zoom-disable is the
  scope; gesture rebinding stays out.
- NO server-side anything. This is 100% `cicchetto/` work.

**Subject parity.** UX is subject-agnostic. Visitors + registered +
nickserv-identified all get the same viewport, safe-area, close ×,
and font-size selector. No `subject.kind` gate anywhere.

## Architecture decisions

### A1. Per-bucket commit + push + HOT cic-bundle deploy

Each bucket lands as a single commit on `main`, gets pushed, then
`scripts/deploy-cic.sh` ships the bundle. No worktree gymnastics —
cluster scope is small (4 buckets, all cic-only, no `mix.exs`
churn, no migrations, no supervision-tree edits). HOT cic-bundle
per `feedback_per_bucket_deploy`.

### A2. Browser smoke at every bucket close — iPhone shape

Per `feedback_cicchetto_browser_smoke`. Use chrome-devtools skill:
new_page → resize_page to iPhone 15 Pro dimensions (393×852) →
navigate to grappa LAN URL → take_screenshot before/after for
visual evidence. Jsdom vitest is BLIND to CSS layout regressions.

### A3. Playwright e2e where UX is testable

Per `feedback_ux_e2e_mandatory`. iOS-3 has a click-target behavior
(close × tap → tab disappears) that maps cleanly to Playwright.
iOS-4 has a settings-drawer interaction (open → pick size → font
resizes → reload preserves selection). iOS-1 + iOS-2 are
declarative CSS / meta tags — visual smoke is sufficient evidence;
no Playwright assertion fits.

Webkit project tag where available (`cicchetto/e2e/tests/bug7-ios-own-msg-visible.spec.ts`
uses `@webkit-iphone-15`). Reuse the same project name.

### A4. Reviewer-loop per bucket

Per `feedback_subagent_driven_development`. Spawn general-purpose
sub-agent with explicit shape brief + cluster CLAUDE.md rules +
files to read + verdict line. Apply HIGH findings in-amend
pre-commit. No bucket commits without reviewer pass.

### A5. KISS — smallest possible diff per bucket

Per the orchestrator-loaded brief. Don't over-scope:
- iOS-1: 1 file edit (index.html meta) + ~3 lines CSS.
- iOS-2: ~5 CSS rules (TopicBar + BottomBar + shell-members).
- iOS-3: 1 button block per For-loop in BottomBar (3 loops — server,
  channels, queries) + 1 CSS rule. Reuse Sidebar close-handler
  helpers (`handleCloseChannel`, `handleCloseQuery`).
- iOS-4: 1 fieldset block in SettingsDrawer + 1 helper lib +
  localStorage read at boot.

## Buckets

### iOS-1 — Viewport lock (no pinch-zoom, no page scroll)

**Problem.** Default mobile Safari behavior — pinch-zoom rescales
the whole page (fights cic's scrollback), and overscroll causes
rubber-band page-bounce that looks broken next to the fixed bars.
Both make cic feel like a website, not an app.

**Files touched.**
- `cicchetto/index.html` (1 line — `<meta name="viewport">` edit).
- `cicchetto/src/themes/default.css` (~3 lines on `html, body`).

**Implementation.**
- Replace existing viewport meta:
  ```html
  <meta name="viewport" content="width=device-width, initial-scale=1, maximum-scale=1, user-scalable=no, viewport-fit=cover" />
  ```
  (Was: `content="width=device-width, initial-scale=1.0, viewport-fit=cover"`.)
- CSS additions inside existing `html, body` block:
  ```css
  overflow: hidden;
  height: 100%;
  overscroll-behavior: none;
  ```

**Tests.**
- No vitest unit test — pure declarative shape.
- No Playwright — pinch-zoom is not a Playwright primitive.
- Browser smoke (chrome-devtools mobile-emulation iPhone 15 Pro):
  before/after screenshot, then try `evaluate_script` zooming the
  page and verifying `document.documentElement.scrollHeight ===
  window.innerHeight` (no overflow).

**Exit criteria.**
- Smoke screenshot confirms no white scroll-area below the bottom
  bar on iPhone shape.
- `git diff` ≤ 6 lines.
- Reviewer pass.

**Deploy notes.** HOT cic-bundle. No server impact.

### iOS-2 — Safe-area insets on top + bottom bars

**Problem.** Top bar (TopicBar) and bottom bar (BottomBar) sit
flush against the screen edges. On iPhone 14+ (notch) and 15+
(Dynamic Island) the top bar is partially under the island; on
iPhone X+ the home-indicator overlays the bottom of BottomBar.
Both regions become un-tappable — Apple HIG 44×44pt minimum
violated at the edges.

**Files touched.**
- `cicchetto/src/themes/default.css` — add safe-area insets to:
  - `.topic-bar` (padding-top)
  - `.bottom-bar` (padding-bottom)
  - `.shell-members` (padding-top + padding-bottom — slide-in
    drawer that covers full viewport height)
  - `.settings-drawer` (same — full-height drawer)
- Possibly `.socket-health-banner` + `.bundle-refresh-banner`
  (both `position:fixed; top:0`) — verify under emulation; if
  notch obscures them, add padding-top.

**Implementation.**
- `padding-top: max(0.5rem, env(safe-area-inset-top));` on
  `.topic-bar` (preserve existing padding-top via `max()`).
- `padding-bottom: env(safe-area-inset-bottom);` on `.bottom-bar`
  (BottomBar has no existing bottom padding — just add).
- `padding-top: env(safe-area-inset-top); padding-bottom:
  env(safe-area-inset-bottom);` on `.shell-members` and
  `.settings-drawer`.

**Tests.**
- Vitest: no change (CSS-only).
- Playwright: `bug7-ios-own-msg-visible` already uses
  `@webkit-iphone-15`; no new e2e needed (visual evidence via
  smoke).
- Browser smoke: iPhone 15 Pro emulation → screenshot confirms
  TopicBar starts BELOW Dynamic Island region, BottomBar ends
  ABOVE home-indicator region.

**Exit criteria.**
- Smoke screenshot shows clear inset.
- `min(44px, ...)` tap targets still met (TopicBar buttons +
  BottomBar tabs already declare `min-width: 44px`).
- Desktop layout unaffected — `env(safe-area-inset-*)` resolves
  to `0` outside notched contexts.
- Reviewer pass.

**Deploy notes.** HOT cic-bundle.

### iOS-3 — Bottom-bar tab close ×

**Problem.** Mobile BottomBar tabs have no close affordance —
operator must open the right-hamburger members drawer to find a
window close (which doesn't exist there either), or join+part a
channel server-side to clear the tab. Desktop Sidebar has the ×
already (`.sidebar-close` per Sidebar.tsx:268, 341).

**Files touched.**
- `cicchetto/src/BottomBar.tsx` — add `<button class="bottom-bar-close">×</button>`
  inside each of the 3 For-loops (server tab is EXEMPT — server
  window is always-present per network, can't be closed).
- `cicchetto/src/themes/default.css` — add `.bottom-bar-close` rule
  mirroring `.sidebar-close` shape.

**Implementation.**
- Reuse Sidebar's close helpers — extract `handleCloseChannel` +
  `handleCloseQuery` from Sidebar.tsx into
  `cicchetto/src/lib/windowClose.ts` (one helper, two call sites:
  Sidebar + BottomBar). Per `CLAUDE.md` "one-feature-one-code-path"
  + the nick-case lesson — Sidebar has 2 close sites, BottomBar adds
  2 more, all 4 need the same logic.
- Server window has no close × — only channels + queries get one.
- The × button should be visually small + touch-target adequate
  (min 36×36px is fine for a secondary action per Material; Apple's
  44pt is the recommendation but Sidebar uses smaller for desktop
  already — match Sidebar's existing visual weight, add `min-width:
  32px; min-height: 32px` for mobile thumb reachability).
- Click handler MUST `stopPropagation` so the tap doesn't also
  trigger the tab's parent button (selectChannel).

**Tests.**
- Vitest: extend `BottomBar.test.tsx` (if exists; create otherwise)
  — render BottomBar with one channel, assert × renders, click ×,
  assert handler called.
- Playwright e2e per `feedback_ux_e2e_mandatory`:
  `cicchetto/e2e/tests/ios-3-bottom-bar-close.spec.ts` — webkit
  iPhone 15 project. Login as visitor → join #channel → assert
  BottomBar shows tab with × → tap × → assert tab gone.
- Browser smoke: confirm visual on iPhone shape.

**Exit criteria.**
- × visible on each channel + query tab; absent on server tab.
- Tap × closes window; tap tab body selects window.
- Vitest + Playwright green.
- Reviewer pass.
- BottomBar.tsx file comment "X-close buttons are OMITTED..."
  removed (the omission is reversed).

**Deploy notes.** HOT cic-bundle.

### iOS-4 — Font-size selector in SettingsDrawer

**Problem.** Default `--font-size: 14px` is fine on desktop but
small on iPhone — particularly with Safari's automatic text-zoom
disabled by iOS-1. Operators want to bump globally.

**Files touched.**
- `cicchetto/src/lib/fontSize.ts` (NEW) — `getFontSize() /
  setFontSize(size)`. Reads localStorage at boot, writes
  `document.documentElement.style.setProperty('--font-size', size)`.
- `cicchetto/src/main.tsx` — call `applyFontSizeFromStorage()` at
  app boot (before `<App />` mounts), mirroring how theme.ts
  applies the stored theme.
- `cicchetto/src/SettingsDrawer.tsx` — add fieldset with 5 radios
  (S/M/L/XL/XXL → 12/14/16/18/20 px).
- `cicchetto/src/themes/default.css` — no change; `--font-size`
  already drives downstream rules.

**Implementation.**
- Sizes: `12px` (S), `14px` (M = default), `16px` (L), `18px`
  (XL), `20px` (XXL).
- Storage key: `"cicchetto.fontSize"`.
- Default = `"14px"` (= M). `getFontSize()` returns "M" on
  storage miss.
- `setFontSize("L")` writes "L" to storage, sets `--font-size`
  CSS var to "16px" on `<html>`.
- SettingsDrawer fieldset is the 4th fieldset (after theme,
  notifications; before admin entry + logout). Label: "text size".
- 5 radio inputs, controlled-by-signal, on change call
  `setFontSize`.

**Tests.**
- Vitest: `fontSize.test.ts` — get/set roundtrip,
  localStorage fallback to "M", invalid storage value falls back
  to "M".
- Playwright e2e: `cicchetto/e2e/tests/ios-4-font-size.spec.ts` —
  webkit iPhone 15. Open SettingsDrawer → assert default radio is
  "M" → pick "XL" → assert `<html>` computed `--font-size = 18px`
  → reload page → assert "XL" still selected + `--font-size = 18px`.
- Browser smoke: iPhone shape, S vs XXL screenshot diff.

**Exit criteria.**
- 5 sizes selectable + persistent.
- Default unchanged (vjt's current behavior == M).
- Vitest + Playwright green.
- Reviewer pass.
- No server-side bleed — `grep -rn "font_size\|font-size" lib/` returns no new hits.

**Deploy notes.** HOT cic-bundle.

### iOS-Z — Cluster CLOSE

**Mirror `m-z-admin-cluster-journey.spec.ts` / U-Z shape.**

- Composed Playwright e2e journey
  `cicchetto/e2e/tests/ios-z-cluster-journey.spec.ts` — webkit
  iPhone 15 — runs all 4 buckets back-to-back: viewport lock
  visible (no overflow), safe-area inset visible (TopicBar Y > 0
  on notched device), close × on tab works, font-size persists
  across reload. ONE spec, not 4 separate.
- Docs sweep:
  - `docs/DESIGN_NOTES.md` — episode entry covering 4 buckets.
  - `docs/project-story.md` — episode entry capturing cluster
    arc (4 buckets, KISS scope, browser-smoke evidence trail).
  - `README.md` — mobile section update if mobile UX is mentioned
    (per `feedback_readme_currency`).
- Memory close file: `project_ios_ui_polish_cluster_closed.md`
  with 8/9 commits + 4 buckets summary + lessons.
- Update `project_ios_ui_polish_cluster_planned` to point to the
  closed memory (or delete + replace).
- Update `project_post_p4_1_arc` if it references the iOS cluster
  as pending.

## Cluster-wide rules (carry from session-start prompt)

- **Per-bucket deploy** via `scripts/deploy-cic.sh` per
  `feedback_per_bucket_deploy`.
- **Browser smoke at each bucket close** per
  `feedback_cicchetto_browser_smoke`.
- **UX behavior changes need Playwright e2e** per
  `feedback_ux_e2e_mandatory`.
- **Reviewer-loop per bucket** per
  `feedback_subagent_driven_development`.
- **Gate evidence**: full `scripts/check.sh` exit-0 + literal tail
  paste at every LANDED claim per `feedback_landed_claim_evidence`.
  Cic-only buckets: at minimum `npm test` (vitest) + biome + tsc
  green in `cicchetto/`.
- **One-feature-one-code-path** — iOS-3 close × extracts a shared
  helper (Sidebar + BottomBar both call it).
- **No corporate context in public artifacts** per
  `feedback_no_corporate_context_public`.
- **Italian blasphemy + profanity** per user pref (commits,
  status updates).

## HALT criteria

- ctx ≥25% → HALT, ping vjt + write resume prompt for clear-cycle.
- vjt explicit deviation request → HALT.
- Design question that warrants vjt input (e.g. "where does the
  gear icon live?", "is XXL == 20px too small?") → HALT, ask vjt.
- Reviewer flags BLOCK or "CRIT" finding → HALT, surface findings
  to vjt for triage.

## Next workstream after iOS-Z

Per `project_post_tmu_full_review_scheduled`: full codebase review
(orchestrate parallel-review cycle + fix ALL CRIT/HIGH + most-
important MED) — vjt-driven start. Do NOT auto-start review after
iOS-Z without vjt confirm.

After review: bastille deploy issue #8 per
`project_bastille_deploy_workstream`.
