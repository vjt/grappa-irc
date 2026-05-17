# UX cluster — 3 small bugs vjt observed live

**Status**: brainstorm v1 (orchestrator-drafted 2026-05-17 post-iOS-Z,
vjt-blessed via session redirect). Implementation NOT started. UX-1
cleared to begin.

| Bucket | Status | Deploy | Notes |
|--------|--------|--------|-------|
| UX-1 — archive close × + permanent delete | brainstorm | cic-bundle + COLD (new context fn, no migration) | query-kind only; InlineConfirmButton; new `Scrollback.delete_for_dm/3` |
| UX-2 — archive surface in BottomBar | brainstorm | cic-bundle | mirror Sidebar `<details>` collapsed shape |
| UX-3 — top-bar Dynamic Island clearance | brainstorm | cic-bundle | `.shell-empty-toolbar` missing iOS-2 inset; possibly `align-items` adjust on `.topic-bar` |
| UX-Z — cluster CLOSE | brainstorm | n/a | extend iOS-Z journey or new spec + docs sweep + memory close file |

**Branch**: main (bucket-sized work on main per recent post-arc cadence,
per-bucket commit + push).
**Position**: post-iOS-Z (commit 289e077) + post-T+M+U+iOS arc CLOSED.
**Next workstream after UX-Z**: vjt-driven full codebase review per
`project_post_tmu_full_review_scheduled`. **HALT TASSATIVO at 25% ctx
per vjt redirect.**

**Origin evidence**: vjt 2026-05-17 session redirect after iOS cluster
CLOSED. 3 concrete bugs observed in actual cic use.

## Goal

**Three small bugs, one mini-cluster.** Discovered live by vjt;
mechanical fixes, no architecture changes, no server protocol shapes
beyond a single new scrollback-delete verb (UX-1).

**What we are NOT building.**
- NO bulk-delete UI (per-DM-only).
- NO archive-channel delete — only query-kind. Deleting a channel's
  history would orphan a rejoinable channel (channels live on the
  server; clearing local scrollback doesn't unjoin).
- NO new bottom-bar visual paradigm — UX-2 mirrors Sidebar's existing
  `<details>` shape.
- NO inset rework on iOS-2 already-shipped surfaces (TopicBar,
  BottomBar, drawers); UX-3 just patches `.shell-empty-toolbar`.

**Subject parity.** All three buckets are subject-agnostic. Visitors +
registered + nickserv-identified get the same close-×, mobile archive
surface, and Dynamic Island clearance.

## Architecture decisions

### A1. Per-bucket commit + push + HOT cic-bundle deploy (UX-1 COLD)

- UX-1: COLD — new server context function +
  controller + route addition + cic + e2e. No migration (rows already
  exist; we're adding a `DELETE` verb against the messages table). HOT
  cic-bundle is for cic-only diffs.
- UX-2: HOT cic-bundle (cic-only, no server change).
- UX-3: HOT cic-bundle (CSS-only, no server change).

### A2. Browser smoke at every bucket close — iPhone shape

Per `feedback_cicchetto_browser_smoke`. chrome-devtools skill, iPhone
15 Pro emulation, screenshot evidence for UX-2 + UX-3. UX-1 server
behaviour smoke via curl + rows-gone proof.

### A3. Playwright e2e where UX is testable

Per `feedback_ux_e2e_mandatory`. UX-1: click × → confirm modal →
confirm → DM scrollback rows gone from REST. UX-2: mobile viewport
→ archive section visible in BottomBar. UX-3: mobile cold-load →
`.shell-empty-toolbar` paddingTop reads `env()` / `max()` marker. All
under existing `@webkit` iPhone 15 project.

### A4. Reviewer-loop per bucket

Per `feedback_subagent_driven_development`. general-purpose agent,
explicit brief shape, verdict line, in-amend HIGH fixes.

### A5. KISS — smallest possible diff per bucket

- UX-1: new `Scrollback.delete_for_dm/3` + 1 new route + 1 controller
  action + Sidebar/BottomBar archive entries get InlineConfirmButton.
- UX-2: archive `<details>` lifted into BottomBar — read existing
  `archivedBySlug()` store, scope to query-kind for now (matching
  Sidebar shape). Render only when archive is non-empty for the
  network.
- UX-3: 1 CSS rule — add iOS-2 inset to `.shell-empty-toolbar` mirror
  of `.topic-bar`'s `max(0.5rem, env(safe-area-inset-top))`.

## Buckets

### UX-1 — Archive close × + permanent delete

**Problem.** Archive entries (closed DMs that still have scrollback)
have no close affordance. Operator can't permanently delete the
conversation history — re-opening the query reveals the old scrollback
rows. Two related issues: no × button on archive rows; no server verb
to drop scrollback for a single peer.

**Scope: query-kind only.** Channel-kind archive entries do NOT get
the delete affordance — a channel's history is rejoinable IRC state,
not a private conversation. Sidebar already filters; we just gate the
× render on `entry.kind === "query"`.

**Server side.**
- NEW `Grappa.Scrollback.delete_for_dm/3` — deletes all messages where
  `(subject, network_id)` matches AND `dm_with` matches the peer
  (case-insensitive). Returns `{:ok, count}`. The query is symmetric
  (own outbound + inbound from peer) because `dm_peer/4` populates
  `dm_with` to the peer on both sides per CP14 B3.
- NEW route `DELETE /networks/:network_slug/archive/:target` (under
  `:authn` pipeline; controller resolves subject + network + invokes
  `Scrollback.delete_for_dm/3` + 204).
- Controller: `GrappaWeb.ArchiveController.delete/2` (extend existing
  controller).
- Broadcast: emit a typed `:archive_changed` PubSub event on
  `Topic.user(subject_label)/network:slug` so connected cic clients
  refresh their `archivedBySlug` for this network. Mirror shape of
  `query_windows_list` broadcast — cic clears the entry locally on
  receipt + the next `loadArchive(slug)` will see it gone.

**Cic side.**
- `cicchetto/src/lib/archiveDelete.ts` (NEW) — single helper
  `deleteArchiveEntry(networkSlug, target)`. Posts DELETE.
- `Sidebar.tsx` — wrap archive `<li>` in shared `InlineConfirmButton`
  (text: "delete", confirm-text: "really delete?"). Gate on
  `entry.kind === "query"`.
- `BottomBar.tsx` — UX-2 may surface archive too; if it does, same
  InlineConfirmButton wrap. If UX-2 ships archive in BottomBar AFTER
  UX-1, the BottomBar treatment lands in UX-2.
- Subscribe handler in `lib/subscribe.ts` (or `userTopic.ts`,
  whichever has the per-network user-topic dispatch) for
  `:archive_changed` event → trigger `loadArchive(slug)` refresh.

**Tests.**
- ExUnit: `Grappa.ScrollbackTest` — new describe block, 3 cases:
  (a) deletes messages where `dm_with == peer`, (b) leaves channel +
  other-DM messages untouched, (c) idempotent on empty (returns
  `{:ok, 0}`).
- Phoenix: `GrappaWeb.ArchiveControllerTest` — DELETE returns 204,
  broadcasts typed event, NotFound on unknown network slug.
- Vitest: `archiveDelete.test.ts` — posts DELETE with right path +
  bearer; verifies refresh-side-effect not needed (covered by e2e).
- Playwright e2e: `cicchetto/e2e/tests/ux-1-archive-delete.spec.ts` —
  visitor opens DM peer; types a message; closes window (existing
  iOS-3 close × on the query); archive section now contains the
  peer; expand archive; click × → confirm modal → confirm → archive
  entry disappears. Re-opening the query via `/q peer` shows EMPTY
  scrollback (the smoking gun for "actually deleted").

**Exit criteria.**
- × visible on query-kind archive entries; channel-kind unchanged.
- Confirm flow blocks accidental clicks (InlineConfirmButton's
  two-step pattern is already tested).
- Server returns 204 + broadcasts; cic refreshes archive.
- Re-opening query post-delete shows empty scrollback.
- ExUnit + Phoenix + vitest + Playwright green.
- Reviewer pass.

**Deploy notes.** COLD (new server route + context fn; safe-but-cold
per CLAUDE.md "in doubt, COLD"). cic bundle ships in the cold deploy.

### UX-2 — Archive surface in BottomBar

**Problem.** Mobile BottomBar shows networks + channels + queries but
no archive section. Operator on iPhone can't reach closed conversations
without opening the right-hamburger members drawer (which doesn't
contain archive) or rejoining via slash command.

**Files touched.**
- `cicchetto/src/BottomBar.tsx` — add archive section per network,
  mirror of Sidebar's `<details>` collapsed shape. Position: AFTER the
  query windows, INSIDE the `.bottom-bar-network` div.
- `cicchetto/src/themes/default.css` — new rules for `.bottom-bar-archive`
  (horizontal-strip-friendly collapsed shape — maybe `<details>` is
  awkward in a horizontal scroll? Investigate: alternative is a single
  "archive (N)" chip that opens the archive drawer/modal). vjt's note
  says "hamburger? new bottom-bar tab? scroll section?" — vjt-decide
  during impl. **Initial proposal**: single "📁 Archive (N)" tab per
  network in the horizontal strip; clicking opens a modal listing
  archive entries (same modal can be reused for desktop if we later
  consolidate).
  - Alternative B: inline `<details>` block that expands vertically
    above the bottom-bar — risks layout shift.
  - Alternative C: hamburger-driven full-archive drawer (per-network
    sub-sections).

**Decision deferred to impl-time vjt query if ambiguity persists.**
KISS guess: alternative A (single archive tab per network, click opens
modal listing peer-archives for that network with × delete from UX-1).

**Tests.**
- Vitest: extend `BottomBar.test.tsx` — render with archive entries,
  assert chip visible, click chip dispatches modal-open.
- Playwright e2e: `ux-2-mobile-archive.spec.ts` (@webkit iPhone 15) —
  close a DM, assert archive chip visible in BottomBar, click → modal
  shows entry, click ×+confirm (re-using UX-1 confirm flow) → entry
  gone.
- Browser smoke: iPhone 15 Pro emulation, screenshot before/after.

**Exit criteria.**
- Archive visible in mobile UI.
- Confirm flow re-used from UX-1 (one-feature-one-code-path).
- Vitest + Playwright green.
- Reviewer pass.

**Deploy notes.** HOT cic-bundle.

### UX-3 — Top-bar Dynamic Island clearance

**Problem.** vjt observes top-bar paints under Dynamic Island on
iPhone. iOS-2 added `padding: max(0.5rem, env(safe-area-inset-top))`
to `.topic-bar` (default.css:457) which should clear the island.
Candidate causes:
1. `.shell-empty-toolbar` (cold-load before channel selected) has NO
   inset (default.css:466). Operator hits the shell pre-autojoin and
   sees content under the island.
2. `align-items: center` on `.topic-bar` may visually center content
   inside the padded box rather than respecting top-anchored padding —
   investigate via Playwright + visual check.

**Files touched.**
- `cicchetto/src/themes/default.css` — add iOS-2 inset to
  `.shell-empty-toolbar` mirror of `.topic-bar` line. If TopicBar
  itself shows the bug too, investigate `align-items` — possibly drop
  `align-items: center` and rely on `padding` + intrinsic content
  height.

**Implementation.**
1. Apply `.shell-empty-toolbar` inset fix unconditionally (safe; same
   rule that already works on `.topic-bar`).
2. Verify the actual bug location with Playwright iPhone 15 webkit:
   load `/`, screenshot before any channel select, measure
   `.shell-empty-toolbar`'s `getBoundingClientRect().top` AND a child's
   bounding rect. If empty-toolbar's child is at y ≈ 0 (not pushed
   down by env() / max()), the bug is reproducible in webkit; fix
   verifies.

**Tests.**
- Playwright e2e: extend `ios-z-cluster-journey.spec.ts` (or new
  `ux-3-top-bar-island.spec.ts`) — cold-load `/`, assert
  `getComputedStyle(.shell-empty-toolbar).paddingTop` contains `env(` /
  `max(` marker.
- Browser smoke: iPhone shape screenshot.

**Exit criteria.**
- Cold-load and channel-selected views both clear Dynamic Island.
- Reviewer pass.

**Deploy notes.** HOT cic-bundle.

### UX-Z — Cluster CLOSE

- **Composed Playwright e2e journey**:
  `cicchetto/e2e/tests/ux-z-cluster-journey.spec.ts` — `@webkit`
  iPhone 15. Replays all 3 buckets back-to-back. Mirror shape of
  iOS-Z + M-Z + U-Z.
- **Docs sweep:**
  - `docs/DESIGN_NOTES.md` — episode entry covering all 3 buckets.
  - `docs/project-story.md` — episode entry (3 small bugs caught
    live by vjt; the value of post-cluster operator dogfooding).
  - `README.md` — closed-clusters bullet above iOS.
- **Memory close file:** `project_ux_cluster_closed.md`.
- **Update `project_post_p4_1_arc`** — add UX cluster item 3.7
  (between iOS at 3.5/3.6 and review at 3.7→3.8).

## Cluster-wide rules (carry from session-start prompt)

- Per-bucket commit + push + deploy per `feedback_per_bucket_deploy`.
- Browser smoke at each bucket close per
  `feedback_cicchetto_browser_smoke`.
- UX behavior changes need Playwright e2e per
  `feedback_ux_e2e_mandatory`.
- Reviewer-loop per bucket per `feedback_subagent_driven_development`.
- Italian blasphemy + profanity per user pref.
- meta_codesearch:code_search agent (never Explore).
- gh CLI: `GH_CONFIG_DIR=./.gh`.
- Push autonomy granted.

## HALT criteria — TASSATIVO at 25% ctx per vjt redirect

- ctx ≥ 25% → HALT, ping vjt + write resume prompt for clear-cycle.
- vjt explicit deviation request → HALT.
- Design question that warrants vjt input (e.g. UX-2 archive surface
  shape uncertainty) → HALT, ask vjt.
- Reviewer flags BLOCK / CRIT → HALT.

## Next workstream after UX-Z

Per `project_post_tmu_full_review_scheduled`: full codebase review
(orchestrate parallel-review cycle + fix ALL CRIT/HIGH + most-
important MED) — **vjt-driven start. Do NOT auto-start review after
UX-Z without vjt confirm.**

After review: bastille deploy issue #8 per
`project_bastille_deploy_workstream`.
