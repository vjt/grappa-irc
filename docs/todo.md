# Todo

The pending-work backlog. Completed items are deleted (not annotated) —
done work lives in the active checkpoint, not here.

Priority tiers: **Immediate** (this session), **High** (this week),
**Medium** (this month), **Low / Observation** (parked).

---

## Immediate

**UX-6-D LANDED 2026-05-21.** 11 attempts (D1-D12) + 4 parallel
research agents converged on Telegram Web K pattern. See
docs/DESIGN_NOTES.md UX-6-D entry for the full catastrophe-and-
redemption arc.

LANDED surfaces:
- `lib/viewportHeight.ts` — `installViewportHeightTracker` writes
  `--vh` (Telegram pattern, vv.height*0.01 px) + `--viewport-height`
  (legacy). `installSmartScrollPin` snaps window scroll to (0,0)
  gated on touch-state (50ms post-touchend grace).
- `lib/platform.ts` — `isIos()` UA detection + `applyIosClass()`
  applies `html.is-ios` class at boot pre-render.
- `themes/default.css` — `html.is-ios { position: fixed; inset: 0 }`
  + `html.is-ios body { height: calc(var(--vh, 1vh) * 100) }`
  ATOMIC. `.shell-mobile:has(textarea:focus, input:focus)
  { padding-bottom: 0 }` (D1). `.scrollback { min-height: 0 }` (D2).
- `Shell.tsx` — keybinding compose focus uses
  `focus({preventScroll: true})`.
- `ScrollbackPane.tsx` — `vv.resize` → `scrollToActivation()`
  (canonical marker-or-tail routine).
- `DiagFloat.tsx` — flag-gated floating overlay via Portal.
- `AdminDebugTab.tsx` — Admin → Debug tab hosts diag readouts +
  DiagFloat toggle (moved from SettingsDrawer where it competed
  with the focus-state under investigation).
- `e2e/tests/ux-6-d-keyboard-pattern.spec.ts` — @webkit-iphone-15
  spec covering JS+CSS contracts (a) html.is-ios on iPhone UA,
  (b) --vh CSS var, (c) --viewport-height legacy var, (d) D1 :has
  rule effectiveness, (e) smart-pin scroll snap, (f) Admin Debug
  tab + DiagFloat toggle.

**Accepted residuals:**
- Visible topbar slide during iOS keyboard open (~250ms animation).
  Per-frame rAF diag during D11 proved vvOT=0 + wy=0 throughout —
  the motion is at the WKWebView compositor BELOW JS visibility
  (WebKit `_zoomToFocusRect` in `WKContentView`). Not fixable in
  pure PWA. Escape via Capacitor (Tier B from research) if priority
  rises; documented research in DESIGN_NOTES.
- Channel scroll position interference — DEFERRED to next session
  (vjt 2026-05-21: "still happening but we tackle that in the next
  session"). See "## Immediate" section below for the pending item.

Gates: 1532 vitest passed + biome exit-0 (16 baseline warnings) +
scripts/check.sh exit 0 (2312 elixir tests, 0 failures —
pre-existing AdminEventsTest assert_receive flake on first run per
documented variance, clean on retest).

**UX-6-G LANDED 2026-05-21.** Admin pane horizontal scroll on
mobile (vjt iPhone-dogfood: "horiz content there is a scrollbar but
the content doesn't move"). Root cause: `.admin-pane` carried
`touch-action: pan-y` (UX-5 BO defensive carve-out vs UX-3 PENT
`.shell-mobile { touch-action: none }`). CSS spec: touch-action is
the cross-ancestor INTERSECTION — even when a descendant declares
`pan-x pan-y`, an ancestor `pan-y` clamps it back. Admin tables
exceed iPhone 15 content width (sessions 656px, networks 631px,
visitors 517px at 361px content area) — browser rendered the
scrollbar but iOS rejected the pan-x gesture.

Fix (CSS-only, 2 surfaces):
- `.admin-pane` touch-action: `pan-y` → `pan-x pan-y` (relaxes the
  ancestor ceiling so descendant pan-x can take effect).
- `.admin-tab-panel` adds `overflow-x: auto` + touch-action
  `pan-y` → `pan-x pan-y` (table scrolls inside the panel, not the
  page; the panel owns gesture authority for pan-x).

Cross-surface audit (per reviewer-loop NON-FINDING): settings-drawer,
archive-modal, image-upload-modal, members-pane all retain pan-y-only
because none carry wide tables — "Total consistency" means same
problem → same solution, not blanket pan-x pan-y everywhere.

Per `feedback_e2e_user_class_parity_matrix`: admin-gated EXEMPT.
Spec runs the admin arm only; vjt is_admin promoted via PATCH /admin/
users/:id (admin-vjt bearer) in beforeAll, reverted in afterEach —
same shape as UX-6-C.

Gates: 1529 vitest (88 files, no diff vs baseline — CSS-only) +
scripts/check.sh exit-0 (8 doctests + 32 properties + 2312 tests +
0 failures + 0 Dialyzer errors + Sobelow done + bats 23/23) + biome
exit-0 (16 baseline warnings, my diff adds zero) + 3/3 ux-6-g
Playwright (touch-action pan-x assertion on pane + each wide-table
panel + positive-twin scrollW > clientW on networks + programmatic
scrollLeft round-trip + negative-twin pan-y preserved).

Reviewer-loop (general-purpose agent): SHIP-READY, 0 CRIT/HIGH/MED,
2 LOW (uneven loop value-density + test 3's negative-twin is
string-shape rather than behavioral — "polish, not blockers").

Deploy: **HOT** (cic-only — no mix.lock / application.ex / migrations
/ nginx / Dockerfile / long-lived GenServer state touched). Bundle
deploy via `scripts/deploy-cic.sh`.

**UX-6-F LANDED 2026-05-21.** Send button reshape: text "send" →
inline SVG paper-plane glyph + `aria-label="send message"` (vjt
iPhone-dogfood Bug 7). Mirrors modern messenger UX + frees ~30px
horizontal on the crowded compose row.

SVG (not Unicode codepoint) chosen post-reviewer MED-1: `.compose-box
button` inherits `--font-mono` (ui-monospace, SF Mono, Menlo,
Consolas, Liberation Mono, monospace) whose Linux/Windows members
lack Dingbats-block coverage. U+27A4 (➤) would tofu on those OSes
silently — `textContent` assertions only see the source codepoint,
not the rendered glyph. SVG with `stroke="currentColor"` matches the
sibling camera-icon precedent at ComposeBox.tsx:209-222 — same 24x24
viewBox + 16x16 box + Feather-style attrs. Theme-agnostic.

a11y: pre-bucket the button had no aria-label — `byRole({name: /send/i})`
resolved via "send" textContent. Post-bucket aria-label preserves
screen-reader name + Playwright `getByRole({name})` matching. Two
existing e2e specs (bug7-ios-own-msg-visible, bug7-m6-ios-dm-own-msg-visible)
switched from `hasText: /^send$/i` to `getByRole({name: /send message/i})`.

Gates: 2312 ExUnit + 0 Dialyzer/Credo/Sobelow + doctor green + 1529
vitest (1528 baseline + 1 new UX-6-F glyph case) + biome exit-0
(16 baseline warnings) + 3/3 e2e (1 ux-6-f @webkit + 2 bug7 regression
re-runs) + bats 23/23.

Reviewer-loop (general-purpose agent): re-review APPROVE 0/0/0/0
after SVG swap. First pass flagged MED-1 (font-tofu) + MED-2 (vitest
permissive) + LOW-1/2/3 (over-comment + redundant desktop e2e + dead
title=) — all 5 resolved inline before commit. Hard lesson: the
reviewer caught a font-fallback class that `textContent` e2e
assertions couldn't see — `feedback_cicchetto_browser_smoke` covers
layout but NOT rendered-glyph fidelity. Pre-reviewer single-codepoint
e2e was green AND broken.

Deploy: **HOT** (cic-only — no mix.lock / application.ex / migrations
/ nginx / Dockerfile / long-lived GenServer state touched). Bundle
deploy via scripts/deploy-cic.sh.

**UX-6-C LANDED 2026-05-21.** Admin button in mobile drawer footer
(vjt iPhone-dogfood Bug 3). Pre-bucket the mobile launcher footer
(UX-5 BM) hosted only settings + archive; admins had to open the
LEFT sidebar drawer and scroll to the 🔧 sidebar admin row to reach
AdminPane — one extra step over desktop. Bucket adds a 4th launcher
button gated on `isAdmin()` (single source of truth shared with
Sidebar admin row + SettingsDrawer admin entry); tap dispatches the
same `setSelectedChannel({kind: "admin", ...ADMIN_*})` that the
Sidebar handler uses (selection-driven model, no parallel
`adminOpen` signal).

`lib/mobilePanel.ts` gains `openAdminPanel({setters}, navigate)` —
SAME mutex shape as `openSettingsPanel`/`openArchivePanel` (close
members + settings + archive then engage self) scaled by one
sibling. Thunk indirection keeps the mutex co-located with siblings
while the selection target stays in the selection store.

Gates: 2312 ExUnit + 0 Dialyzer + 0 Credo + 0 Sobelow + doctor green
+ 1528 vitest (1523 baseline + 4 new Shell UX-6-C cases + 1 new
mobilePanel openAdminPanel test) + biome exit-0 (16 baseline
warnings — BottomBar.test rot + 2 default.css `!important`, NOT
this bucket) + 3/3 ux-6-c Playwright (1 chromium desktop + 2
@webkit-iphone-15 admin & non-admin) + bats 23/23.

Reviewer-loop (general-purpose agent): APPROVE, 0 CRIT/HIGH/MED,
2 LOW (LOW-1 glyph-escape style pre-existing inconsistency in
ShellChrome — wrench escape vs literal `⚙`; LOW-2 redundant PATCH
in non-admin afterEach — defensive shape kept intentionally).
NON-FINDINGs covered Q1/Q2 design decisions + reactivity + mutex
ordering + diff scope.

Deploy: **HOT** (cic-only — no mix.lock / application.ex / migrations
/ nginx / Dockerfile / long-lived GenServer state touched). Bundle
deploy via `scripts/deploy-cic.sh` for hash broadcast.

Also includes carry-debt biome-format fixes from UX-6-L commit
eb07e4b (3 files: pushDedup.test.ts + beep.ts + subscribe.ts) that
`scripts/bun.sh run check:fix` auto-resolved this turn — per
`feedback_check_sh_working_tree_trap`, must ship in this commit or
CI diverges from local.

**UX-6-L LANDED 2026-05-21.** Foreground push → in-app beep
(SW-suppress Option B per vjt 2026-05-20). Two surfaces:

- **SW broadened gate** (`lib/pushDedup.ts` extracted as testable
  predicate + `service-worker.ts:handlePush`). Suppresses OS
  notification when any window is `visibilityState === 'visible'`,
  dropping the pre-L focused-AND-URL-match dedup. Dropped the dead-
  letter `push.suppressed` postMessage (no cic-side listener; YAGNI
  per CLAUDE.md). Kept `urlMatches` for `focusOrOpen`.
- **WS-driven in-app beep** (`lib/beep.ts` — Web Audio sine 440Hz,
  80ms, 0.1 gain; lazy ctx + graceful no-op on unsupported envs).
  Wired in `lib/subscribe.ts` at 3 sites:
  - channel-mention path in `routeMessage` (after `bumpMention`,
    additionally gated on `sender !== ownNick`);
  - DM-listener PRIVMSG/ACTION arm (before `routeMessage`, gated
    on `sender !== ownNick && !effectivelyFocused(slug, peer)`);
  - DM-listener peer NOTICE arm (sender !== ownNick already
    gated by surrounding branch).
  Single-source focus predicate `effectivelyFocused(slug, name)`
  extracted from `routeMessage` so badge gate + beep dispatch share
  one rule.

**E2E test seam** `window.__cic_dmListenerReady` (Set\<string\>)
stamped in DM-listener `onJoinOk` after successful `phx.join()` ack.
Eliminates ~20% flake where peer.privmsg landed server-side before
cic's DM-listener subscription completed (silent broadcast drop).
Production never reads it (same shape as
`socket.ts:__cic_dropSocketForTests`).

**APNs/FCM quota caveat** (DESIGN_NOTES 2026-05-21 entry): server
still sends every push; SW just suppresses display when foreground.
~50% wasted when foreground; acceptable at current scale. Hybrid
follow-up (server WSPresence + visibility-heartbeat fast-path skip,
SW defensive re-check) NOT parked as TODO — re-evaluate if push
volume justifies engineering.

Reviewer-loop: SHIP-READY. Findings addressed inline: MED-1
(extracted `effectivelyFocused` single-source helper), MED-2
(DESIGN_NOTES caveat entry), LOW-2 (renamed misleading test
description). LOW-1 (3-site beep call multiplication) ruled
non-actionable — each gate is genuinely different.

Gates: 1523 vitest (1511 baseline + 12 new: 5 pushDedup + 7
subscribe beep) + scripts/check.sh exit-0 + biome (16 pre-existing
warnings + 2 pre-existing errors in BottomBar.test.tsx; my diff
adds zero) + 3/3 ux-6-l Playwright × 5/5 consecutive runs (was
4/5 BEFORE the `__cic_dmListenerReady` seam; 5/5 AFTER).

Deploy: cic-only bundle (`scripts/deploy.sh` auto-classifies HOT +
`scripts/deploy-cic.sh` for bundle hash broadcast). Server stays
untouched.

**UX-6-K LANDED 2026-05-21.** Server-side cursor-write validator
predicate divergence from read-path. `Grappa.ReadCursor.message_belongs?/4`
filtered `m.channel == ^channel` literal while `Grappa.Scrollback.fetch/6`
used the OR-shape `m.channel == ^chan OR m.dm_with == ^chan`. Inbound
DMs (persisted at `channel = own_nick, dm_with = peer` per CP14-B3)
failed validation → 422 → cic's `setReadCursor` `console.warn`'d
silently → in-pane unread-marker never advanced. Outbound DMs
(`channel = peer`) passed the literal match → "sending a message to
peer cleared the marker" was the precise repro signature.

Fix: promoted `Grappa.Scrollback.channel_or_dm_where/3` from `defp`
to `def` (single-sourced predicate per CLAUDE.md "Implement once,
reuse everywhere"). `ReadCursor.message_belongs?/4` now delegates with
`own_nick: nil` (cursor write doesn't carry own_nick; existence check
is symmetric for either direction; over-match analysis verified safe).

Scope flip: K was initially scoped cic-only in docs/todo.md; diagnosis
revealed server-side root cause. vjt sign-off granted via AskUserQuestion.

Gates: 2312 ExUnit (8 doctests + 32 properties + 4 new K cases) + 0
Dialyzer + 0 Credo + format-check exit-0 + 1511 vitest (1506 baseline
+ 5 new K symmetry cases) + biome exit-0 + 1/1 ux-6-k Playwright + 12/
12 full Playwright suite (background run exit-0). Pre-existing
`Grappa.AdminEventsTest:197` + `GrappaWeb.GrappaChannelTest:1408`
`assert_receive` flakes observed in 2/5 check.sh runs — neither
touches read_cursor or scrollback paths.

Reviewer-loop (general-purpose agent): SHIP-READY, 1 LOW (e2e
under-specific assertion `not.toBeNull` → tightened to
`toBeGreaterThan(0)`). NON-FINDINGs covered correctness +
discipline + test fidelity + risk + side-effects + anti-pattern
closure.

Deploy: **COLD** (server context change — `Grappa.Scrollback`
public surface gained `channel_or_dm_where/3` + `Grappa.ReadCursor`
behavior changed; sessions don't carry shape-state so HOT *would*
work, but new public surface on Scrollback is the kind of thing
preflight could miss).

**UX-6-B LANDED 2026-05-21.** Full B-cluster (B1 server stack +
B2 cic adapter + admin Settings tab + B3 e2e + reviewer-loop)
ready. B1 commit `61269eb` (server stack) + `4b3d1ac` (CI workflow
CVE-ignore) + `3c17808` (todo.md snapshot). B2 lands cic
`embeddedHost: ImageHost`, reactive `serverSettings()` signal
(identity-scoped), `activeHost()` reactive flip, NEW
`AdminSettingsTab.tsx` (5th admin tab) + REST helpers, server
`Grappa.ServerSettings.Wire` module + `Admin.SettingsController`
per-user-topic fan-out (parity with `AdminController.cic_bundle_changed/2`
precedent — no new channel), `GrappaChannel.push_server_settings/1`
after-join snapshot (parity with `push_bundle_hash/1`). B3 ships
Playwright `ux-6-b-embedded-upload.spec.ts` (full vertical:
picker → modal → POST → IRC echo → linkify → GET serves bytes)
+ `ux-6-b-admin-settings.spec.ts` (render, 422 inline error,
PUT round-trip with after-each reset). Reviewer-loop addressed
HIGH-1 (stale docstring drop), HIGH-2 (shared `upload_view/1`
wire helper between REST + WS), HIGH-3 (`applyServerSettings`
callsite destructure to drop `kind`), MED-1 (Logger.warning on
unknown admin PUT key + `setting_key` allowlist add). Doctor
fix: added `@doc` to all 6 `ServerSettings` accessors (pre-
existing tech debt from B1; doctor was already failing on main
HEAD pre-B2). Gates: 2308 ExUnit + 0 Dialyzer + 0 Credo + 0
Sobelow + doctor green + 1506 vitest + 4/4 ux-6-b Playwright +
bats 23/23. Deploy: COLD (channel snapshot + new wire boundary).

**UX-6 cluster — remaining buckets after B closes:**

- **UX-6-C — LANDED 2026-05-21.** See LANDED block above.
- **UX-6-D — LANDED 2026-05-21.** 11 attempts + 4 research agents.
  Telegram Web K pattern atomically (`html.is-ios position:fixed`
  + body `calc(--vh*100)` + `--vh` JS) + smart-pin (touch-gated
  window.scrollTo(0,0)) + D1 padding-collapse + AdminDebugTab.
  See DESIGN_NOTES.md UX-6-D entry. Two accepted residuals:
  (1) visible iOS keyboard slide-in animation (compositor-layer,
  unfixable in pure PWA); (2) channel scroll position interference
  on switch — pending UX-6-M below.
- **UX-6-E — LANDED 2026-05-22.** Narrow-mode (mobile) BottomBar
  per-network shape now matches wide-mode sidebar: the network header
  IS the server-window entry. Pre-fix narrow rendered TWO entries —
  a passive `.bottom-bar-network-chip` span + a standalone
  `.bottom-bar-tab` labelled "Server". Post-fix one clickable
  `.bottom-bar-network-header` button per network (emoji ⚙️ + slug +
  badges), with a sibling disconnect × mirroring the wide-mode UX-4-D
  affordance (visitor = quit-all / registered = park-one).
  - `cicchetto/src/BottomBar.tsx` — JSX rewrite; old chip+Server-tab
    pair → single clickable header.
  - `cicchetto/src/themes/default.css` — `.bottom-bar-network-chip`
    rules dropped; `.bottom-bar-network-header` / `-emoji` / `-name`
    new block. Selection feedback (background-only flip on header)
    is intentional design parity with desktop's
    `.sidebar-network-header.selected` — comment in CSS warns "don't
    fix".
  - `cicchetto/src/__tests__/BottomBar.test.tsx` — 21 tests, all pass.
    Belt-and-braces "no legacy chip span AND no standalone Server tab".
  - `cicchetto/e2e/fixtures/cicchettoPage.ts` — selector update;
    `sidebarWindow(slug, "Server")` legacy ergonomics special-case
    returns the header (callers in ux-2, ux-4-z, ux-z journey specs
    unchanged at call site).
  - `cicchetto/e2e/tests/ios-3-bottom-bar-close.spec.ts` — Server-tab
    NO-close test rewritten to assert "no `aria-label='Close Server'`"
    invariant against the new header shape.
  - `cicchetto/e2e/tests/ux-4-z-cluster-journey.spec.ts` — selector
    update (line 282).
  - `cicchetto/e2e/tests/ux-6-e-narrow-server-dedup.spec.ts` — NEW
    spec, 3 @webkit-iphone-15 tests (header-as-entry, click→select,
    disconnect × sibling). All pass.

  Gates: 1534 vitest passed + biome exit-0 (16 baseline warnings) +
  scripts/check.sh exit 0 + 3/3 ux-6-e webkit-iphone-15 e2e + 2/2
  ios-3 webkit + 1/1 ux-2 archive webkit. Reviewer pass: SHIP, MED-1
  documented inline (selection no-op color), LOW-1+L2 tightened
  (closeServerBtn aria-label clarity + belt-and-braces vitest).
  Deploy: HOT cic-only (no Elixir touched). Bundle: pending.

  **Pre-existing e2e baseline failures discovered during smoke** (NOT
  caused by UX-6-E — reproduce on `e53000c` main HEAD without these
  edits in 2 consecutive runs):
  - `ux-4-z-cluster-journey.spec.ts:141` (UX-4-Z parity matrix)
    `members-pane` from `aside.shell-members.open` subtree intercepts
    pointer events when test taps `.shell-drawer-backdrop.open`. Drawer
    doesn't actually close on backdrop tap on webkit-iphone-15.
  - `ux-z-cluster-journey.spec.ts:86` (UX-Z journey) archive modal
    `#bofh` row never renders (`toHaveCount(1)` got 0 after 5s).
  Park as separate investigation — both flag mobile drawer + archive
  paths that may need a fix unrelated to BottomBar.
- **UX-6-F — LANDED 2026-05-21.** See LANDED block above.
- **UX-6-G — LANDED 2026-05-21.** See LANDED block above.
- **UX-6-H** — MERGED INTO UX-6-D (D2 = "scrollback doesn't follow viewport-shrink on keyboard open"; same bug).
- **UX-6-I** — cic refresh banner needs 3 presses after deploy.
- **UX-6-J** — push notif tap doesn't open source window.
- **UX-6-K (NEW 2026-05-20) — LANDED 2026-05-21.** See LANDED block above.
- **UX-6-L (NEW 2026-05-20) — LANDED 2026-05-21.** See LANDED block above.
- **UX-6-M (NEW 2026-05-21, post-D close)** — channel scroll
  position interference. Switching between channels shows the
  WRONG scroll position (scroll state of channel A leaks into
  channel B, or A position lost on round-trip — vjt repro pattern
  TBD in next session). Likely related to ScrollbackPane being
  reused via Solid `<Show>` non-keyed across selectedChannel
  changes — `listRef.scrollTop` survives the switch (intentional
  per UX-4-K's `scrollToActivation`), but the per-channel scroll
  position isn't being persisted/restored on switch. Investigate
  next session.
- **UX-6-Z** — docs sweep.

**deploy.sh preflight GAP (discovered 2026-05-20 during B1 deploy).**
Auto-detect classified B1 as HOT despite new migration. Per
CLAUDE.md "Cluster with new migration MUST cold-deploy" the preflight
SHOULD have flagged `priv/repo/migrations/*` as COLD. Verify the
regex matches the new migration filename shape + add `Grappa.Uploads`
+ `Grappa.ServerSettings` to whatever marker-line tracking the
script uses for "new context introduced." Park as follow-up — not
blocking B2/B3.

**Workflow change 2026-05-20 (vjt orchestrator-mandated).**
- `/tmp/orchestrate-next.txt` is fragile across multi-session /clear
  cycles. The AUTHORITATIVE pending-work backlog is THIS file
  (`docs/todo.md`).
- BEFORE starting any work: commit current `docs/todo.md` state
  (snapshot intent).
- DURING work: edit `docs/todo.md` as you learn — mark in-progress,
  add discovered subtasks, etc.
- BEFORE clearing: commit `docs/todo.md` again (final snapshot so
  the post-/clear pickup reads the right backlog).
- `/tmp/orchestrate-next.txt` still carries the precise first-action
  paragraph for the post-clear pickup, but todo.md is the SOURCE
  OF TRUTH.

---

**CP17 server-side-pending CLOSED 2026-05-08.** Theme 2 of the
2026-05-08 architecture review shipped: `:pending` window-state
origination moved from cic (`compose.ts:210 setPending(...)` workaround)
to the server. `Grappa.Session.Wire.window_pending/2` broadcasts on
`Topic.user/1`; `record_in_flight_join/2` writes
`window_states[ch] = :pending` + broadcasts. Idempotency rule: re-JOIN
of an already-`:joined` channel is a no-op state transition (in-flight
entry still recorded for failure-numeric correlation). cic's
`userTopic.ts` dispatcher mirrors via `setPending(channelKey(...))`.
Closes the CLAUDE.md hard-invariant violation "cic NEVER originates
state — no parallel client-side state machine."

**Phase 2 + Phase 3 walking skeleton LIVE; CP10 review-fix campaign
correctness clusters CLOSED.** Bouncer + cicchetto PWA live at
`http://grappa.bad.ass` (192.168.53.11 → nginx → grappa:4000). iPhone
install + login + scrollback + send round-trip operator-verified
2026-04-27 (CP09 S3). CP10 codebase review (2026-04-27) → eight
clusters closed: C1 (vite-plugin-pwa SW), C2 (init/1 →
handle_continue), C3 (MessageKind widen + exhaustive switch), C4
(post-Phase-2 hygiene close-out), C5 (security correctness — S14
probing-oracle plug + S18 socket token-rotation reconnect), C6
(IRC-state correctness — S5 + S6 + S7 + S13), C7 (channel-lifecycle
correctness — collapsed to A1 cicchetto identity-scoped state
cleanup; S17 verified resolved upstream), C8 (omnibus housekeeping —
S29 dead key + LOW catalogue sweep + this todo sweep).

**D1/A2 CLOSED 2026-04-27 (CP10 S12).** Networks god-context split
into Networks (slug CRUD) + Networks.Servers + Networks.Credentials +
Networks.SessionPlan; verb-keyed sub-modules under one Boundary
umbrella; production verified.

**D2/A3 CLOSED 2026-04-27 (CP10 S13).** IRC.Client god-module split
into Client (transport + line dispatch + send_* helpers, 334 lines)
+ AuthFSM (pure CAP/SASL/PASS state machine, 343 lines). Pure-FSM
extraction shape — `step(state, msg) :: {:cont|:stop, state,
[iodata]}`, host GenServer does I/O — second application of the
verb-keyed sub-context principle (DESIGN_NOTES corollary entry).
Production verified at `http://grappa.bad.ass`.

**D3/A4 CLOSED 2026-04-27 (CP10 S14).** cicchetto/lib/networks.ts
god-module split into 5 verb-keyed modules: channelKey (shared brand)
+ networks (slim resources) + scrollback (state + verbs) + selection
(selectedChannel + unread + bumpUnread) + subscribe (WS join effect).
First cross-language application of the verb-keyed sub-context
principle (DESIGN_NOTES corollary entry); same lifecycle pattern via
module-singleton + createRoot + on(token) cleanup. Production verified
at `http://grappa.bad.ass`; bundle hash `index-yiUejGMf.js` →
`index-BQpneWxT.js`.

**D-cluster trajectory complete.** D1 + D2 + D3 closed across two
languages and three verb shapes. Phase 4 brainstorm (irssi-shape UI)
is now unblocked — runs against post-A4 modules.

**Phase 4 brainstorm CLOSED 2026-04-27 (CP10 S15).** Spec at
`docs/plans/2026-04-27-phase-4-product-shape.md`. Web-IRC product shape
walked as one design surface (three auth modes + irssi-shape UI + voice
I/O). Cluster trajectory: E1 → P4-1 → P4-V (Phase 4 closes here) → M2
→ M3 → M3-A (post-Phase-4, additive). Decisions D1-D6 pinned. 10 open
design questions deferred to respective clusters.

**Phase 4 cluster trajectory (writing-plans up next):**
- **E1** — A6 architectural close (server-side only, ~3/4 session).
  `Grappa.Session.EventRouter` extraction (4th application of verb-keyed
  sub-context principle, mirrors AuthFSM from D2). `Scrollback.persist_event/1`
  refactor (drops `kind: :privmsg` hardcode). Producers for all 10
  message kinds (`:privmsg | :notice | :action | :join | :part | :quit
  | :nick_change | :mode | :topic | :kick`). `Session.list_members/2`
  + REST `GET /networks/:net/channels/:chan/members`.
- **P4-1** — Phase 4 first ship UI on clean A6 surface (~full session,
  possibly two). cicchetto rewrite to three-pane responsive +
  mIRC-light/irssi-dark theme presets + tappable channel sidebar +
  nick list right pane + topic bar + compose with tab-complete +
  slash commands + irssi keyboard shortcuts + mobile drawers.
  Server-side: A5 fix (ChannelsController returns session-tracked).
- **P4-V** — Voice I/O cluster, Phase 4 closes (~half session).
  Per-channel TTS + STT toggle. Browser-native APIs (`SpeechSynthesis`
  + `SpeechRecognition`). Vosk/piper offline drop-in deferred to
  Phase 4.6 / Phase 5.

**Post-Phase-4 (additive — no P4 retrofit needed):**
- **M2** — NickServ-as-IDP (~full session). Lazy User row creation,
  `Grappa.IRC.AuthFSM` first reuse, single-network gating, login UI
  second tab.
- **M3** — Anon ephemeral (~full session). `users.expires_at` migration,
  `POST /auth/anon-login`, cookie path on `Plugs.Authn`, Reaper
  GenServer, login UI third tab. Anon shape pinned in spec D2: real
  `users` row + random bearer-as-cookie + 48h TTL, reuses every
  Scrollback verb unchanged.
- **M3-A** — Anon abuse posture (~half session). Per-IP rate-limit
  on session creation, operator allowlist per network, captcha hook
  for Phase 5+ if abuse materialises.

**D-cluster triage backlog (test-suite flakes surfaced during the
correctness campaign — defer to a dedicated investigation pass, not
fixed in C8):**
- `Grappa.BootstrapTest:80` — `on_exit` hits
  `GenServer.call(Grappa.SessionSupervisor, …, :infinity)` with
  `{:EXIT, no process: …}` because `SessionSupervisor` exhausted
  `max_restarts: 3` in <100ms during parallel async tests crashing
  sessions. Same shape as the C2 cluster's "test-side discipline"
  warning (C7 S17 verification reproduced ~1-in-15 under
  suite parallelism). Investigation route: widen
  `SessionSupervisor.max_restarts` for the test environment, OR
  add a per-test session-spawn isolation flag.
- `Grappa.Networks.WireTest` — `network_to_json/1` and
  `credential_to_json/1` Jason-encodable tests fail intermittently
  on sqlite "Database busy" during setup under `max_cases: 2`
  write-heavy parallelism. Documented since CP08 carryover; the
  C7 verification re-confirmed it's still live.
- `Grappa.AccountsTest:20` — `create_user/1 rejects a duplicate
  name` — likely also sqlite contention. Same investigation
  shape as WireTest (sqlite WAL-mode in test, sandbox shared-mode
  review).
- All three are pre-existing test-infra issues. Fix campaign for them
  is its own cluster (D-cluster naming) sized larger than housekeeping.

## High

- (S17 channel-test flake RESOLVED-UPSTREAM in C7 verification —
  15 consecutive runs zero failures; the C2 cluster's stop_session
  race fix almost certainly closed it.)

- (CP15 CLOSED 2026-05-07 the "channel-window must show 'not
  connected' state when upstream is failing" item — the
  `windowStateByChannel` mirror + synthetic-row + greyed-class
  treatment cover `:failed` / `:kicked` end-to-end. Parked / T32
  follow-up below.)

- (CP15 B6 follow-up — `cp15-b6-pending-to-failed-invite-only.spec.ts`
  flake CLOSED 2026-05-08 cluster `codebase-review-fixes`. Tightened
  `wait_for` sentinel from `row.toHaveCount(1)` first-then-greyed to
  `row.locator(".sidebar-window-greyed").toBeVisible()` as a single
  combined wait — the greyed class is the strict "typed
  `join_failed` event landed" signal.)

- (Parked (T32) e2e flow CLOSED 2026-05-10 CP19 cluster
  `cluster/t32-parked-design`. Design pinned: cic derives parked
  cascade from `network.connection_state` rather than per-window
  `:parked` event — answers (a) no per-window event needed, (b) yes
  per-network overlay drives sidebar greying via
  `.sidebar-network-greyed`, (c) Bootstrap restart on `connect/1`.
  Spec `cp15-b6-parked.spec.ts` shipped covering JOIN → /disconnect
  → assert greyed → /connect → assert ungrey post-autojoin.)

- Phase 5 hardening: Session.Server should `terminate/2` cleanly —
  send QUIT to upstream + close socket. Currently :normal exit kills
  IRC.Client via link, which silently dies; OK for prod but emits
  ugly `tcp_closed terminating` test-stdout noise.
- Phase 5 hardening: TLS `verify: :verify_none` posture (`lib/grappa/irc/client.ex`)
  → CA chain verification with proper bundle. Document operator's
  TLS-trust-store config strategy. Independent of Phase 2 auth work.
- Phase 5 hardening (NEW from S20 Phase 2 plan): post-registration
  `+r` umode check on Session connect. If after `001 RPL_WELCOME`
  the client did NOT receive `+r` (or equivalent network-specific
  registered-user umode), fall back to explicit `PRIVMSG NickServ
  :IDENTIFY <pwd>` retry. Catches PASS-not-bound-to-services edge
  cases and lost-PASS races where `auth_method='auto'` chose the
  PASS path but the network silently didn't forward it.
- Phase 5 hardening (NEW from S20 Phase 2 plan): NickServ NOTICE
  reply parsing (success/failure detection per network
  Anope/Atheme/etc), nick-collision recovery (GHOST/RECOVER dance
  when our nick is already in use). Shared correlation machinery
  with NickServ REGISTER proxy below.
- Phase 5 hardening (NEW from S20 Phase 2 plan): NickServ REGISTER
  proxy as REST endpoint. Async request → wait for NickServ NOTICE
  reply → translate to HTTP response. Same correlation machinery as
  reply parsing above. Phase 2 manual workaround: operator runs
  `/msg NickServ REGISTER pass email` from any IRC client once,
  captures resulting password, drops into grappa via `mix
  grappa.bind_network`.
- Phase 5 hardening (NEW from S20 Phase 2 plan): multi-server
  failover logic. Phase 2 schema includes `network_servers` (irssi
  shape: priority + enabled), but Phase 2 logic only uses first.
  Phase 5 adds: try server 0 → on connect fail try server 1 → ...
  → exponential backoff → reset on success.
- Phase 5 hardening (NEW from S20 Phase 2 plan): HSM-keyed
  Cloak.Vault. Operator escape from "env on disk" key storage.
  Cloak.Vault supports custom key sources (yubico-hsm, TPM, AWS
  KMS, etc.) — configurable swap, no code change in Grappa.
  Document operator's hardening path in README.
- Phase 5 hardening (NEW from S22 Phase 3 review CONSIDER C1):
  service worker requires a "secure context" (HTTPS or localhost).
  `http://grappa.bad.ass` is neither — iOS Safari silently fails SW
  registration; the catch in `cicchetto/src/main.tsx:44` logs to
  console. Add-to-Home-Screen still works (manifest-driven), but the
  offline shell cache won't function until Phase 5 TLS rollout. Be
  honest about this in the operator runbook.
- Phase 5 hardening (NEW from S22 Phase 3 review BONUS, B2 followup):
  move bearer token off the WS query string. Currently rides
  `?token=…` on the upgrade URL because Phoenix.Socket transports
  `params` as a query string. Phase 3 fix redacts via Phoenix
  `:filter_parameters` + nginx `access_log off` on `/socket`, but the
  bearer is still visible to anyone who can see the URL pre-redaction
  (browser devtools, on-path observers, BURP-like proxies during
  pen-test). Move to either `Sec-WebSocket-Protocol` or a post-connect
  `phx_join` payload — needs a phoenix.js + UserSocket protocol
  change, bigger than walking-skeleton scope.
- Phase 5 hardening (NEW from S22 Phase 3 review CONSIDER C6): no
  accessibility pass yet. Buttons are buttons + ARIA `role="alert"`
  on errors is reasonable baseline, but the channel sidebar uses
  raw `<ul><li><button>` with no tree semantics — on iOS VoiceOver
  the network → channel hierarchy doesn't read as a tree. Phase 5
  accessibility audit covers this + tap-target sizing + focus-state
  contrast (web.dev a11y guidelines).
- Phase 5 hardening (NEW from S22 Phase 3 review CONSIDER C4 — also
  closed by 8a but worth a tracking item): when adding new WS
  subprotocols or alternate Channel transports, inherit the
  `check_origin` allowlist; if a future feature needs a different
  host, it lands as a separate Phoenix.Endpoint, not as a relaxation
  in `runtime.exs`.
- Phase 5 hardening (L-web-4, t31-cleanup B6.8): rotate
  `GrappaWeb.Endpoint.@session_options.signing_salt` away from the
  `"rotate-me"` Phase 1 placeholder. Lift to `runtime.exs` config
  alongside `secret_key_base` so it's rotatable without recompile —
  the moduledoc on `lib/grappa_web/endpoint.ex` already flags this
  as a Phase 5 lift. No code path signs cookies today (no auth flow
  uses the cookie session; bearer-token flow rides headers), but
  rotating before any cookie surface lands is mandatory.

## Medium

- Set up GitHub repo `vjt/grappa-irc` with CI secrets (codecov token if
  desired, no other secrets required for Phase 1).
- Decide PWA framework (Svelte vs SolidJS vs lit-html) — Phase 3 prep.
  Bundle-size budget ≤200 KB gzip before optional Vosk/piper.
- Open a tracking issue or doc for Phase 6 IRCv3 listener — collect
  IRCv3 specs we'll need (`CAP LS 302`, `CHATHISTORY`, `server-time`,
  `batch`, `labeled-response`, SASL mechanisms). Reuse parser from
  Phase 1.
- Supply-chain hardening (NEW from S22 Phase 3 review CONSIDER C2):
  `oven/bun:1` and `nginx:alpine` (used by `scripts/bun.sh` and
  `compose.prod.yaml`) are moving major tags. Pin to digests
  (`oven/bun:1@sha256:…`) for reproducible builds. CLAUDE.md
  doesn't currently mandate this — log here for the next time supply-
  chain hygiene comes up across the repo.

## Low / Observation

- Investigate `mix release` size on Debian-slim runtime image. If it's
  obnoxiously big, evaluate Alpine + musl rebuild of `ecto_sqlite3`
  NIFs.
- `Grappa.version/0` (`lib/grappa.ex:28`) has zero callers. Either
  wire it into `/healthz` JSON response (one-line change in
  `HealthController`) or drop the function. Surfaced by S19 Task 10
  code review as L4. Empty `Grappa` boundary annotation is
  independently justified.
- Sqlite "Database busy" intermittent test flake — hit once during S19
  ci.check on a re-run. 3 tests (`Repo` / `Scrollback` / `Wire`)
  simultaneously failed inserts with `Exqlite.Error: Database busy`.
  Likely contention between `async: true` Repo writes and the live Pi
  container also writing to `runtime/grappa_dev.db`. Distinct from the
  channel test flake at `grappa_channel_test.exs:76`.
- Telemetry → Prometheus exporter (PromEx). Phase 5 hardening.
- Reconnect/backoff policy when upstream IRC drops. Phase 5.
- Scrollback eviction policy — by row count, by age, or both. Phase 5.
- Perf nit (NEW from S22 Phase 3 review CONSIDER C3): nginx upstream
  `keepalive 32` in `infra/nginx.conf` is dead weight without
  `proxy_set_header Connection "";` on the API allowlist `location`
  block. Without clearing the Connection header on the upstream side,
  nginx forwards the client's `Connection: close` and the keepalive
  pool never warms. Pure perf — measurable only under sustained load,
  which Phase 3 doesn't have.

---

## Notes

- Phase 0 (spec) is complete. README + DESIGN_NOTES + walking-skeleton
  plan all in main.
- Phase 1 tasks all have TDD steps with failing-test-first discipline
  in `docs/plans/2026-04-25-walking-skeleton.md`.
- The Italian Hackers' Embassy / Azzurra context is the longer story.
  See `docs/project-story.md` for the narrative thread that survives
  individual sessions.

## Wishlist (vjt 2026-05-03 #sniffo banter w/ nextime)

- **Addressed-messages highlight on return-from-away.** When a user
  reconnects/returns, surface messages that mentioned them (or DMs)
  prominently — not just "unread count." Needs a last-seen marker
  per channel + a server-computed "things addressed to you while
  away" list that cicchetto can render as a top section before the
  scrollback proper. Phase 4/5 cicchetto UX.
- **Auto-away management.** Client emits idle/active hints (focus,
  tab visibility, lock screen if available); server flips presence
  and AWAY status without user intervention. No `/away` typing.
  Combine with the addressed-on-return bucket above so the round trip
  is automatic. Phase 4 cicchetto + small server hook.
