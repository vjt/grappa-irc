# GREEN-CI-3 — e2e suite hardening (Tier 1 fixes)

**Status**: ready (2026-05-23, post review). NO code written yet. Start
when vjt clears for it.

| Bucket | Status | Deploy | Notes |
|--------|--------|--------|-------|
| B1 — DM-listener race (m4/m5/m6/p0b) | ready | n/a (e2e fixtures) | 4 one-line `waitForDmListenerReady` inserts |
| B2 — `sidebarWindow` substring → exact-text match (cicchettoPage.ts fixture) | ready | n/a (e2e fixtures) | F1 fix — cascade-class blocker for next seed expansion |
| B3 — `globalSetup` cold-start retry-with-backoff (seedData.ts fixture) | ready | n/a (e2e fixtures) | F2 fix — eliminates "entire suite skipped" class |
| Z — close (DESIGN_NOTES + checkpoint + memory) | ready | n/a | Per-cluster cadence |

**Branch / worktree**: none. Direct-to-main like FLAKES + GREEN-CI batch 1 + 2
(test-infra commits, no production code touched).

**Position**: post-GREEN-CI batch 2 (`e9a3aad`). Tier 1 of the post-batch-2
e2e suite review.

**Origin**: vjt 2026-05-23 evening — *"review all e2e specs and ensure
that they are solid now and do not have an occasion to regress. and
further they do test actual features and not stupid internals."* 4
parallel review agents surfaced ~50 findings across 104 specs + 5
fixtures. This plan = Tier 1 only (highest-leverage, fix-once-cure-all).

## Goal

Close the **3 systemic foot-guns** + **4 known DM-listener race specs**
identified in the review. Each is either (a) a fix-once-at-fixture-layer
that cures many specs OR (b) a known recurrence class with a one-line
fix.

**Tier 2 + Tier 3 from the review report are DEFERRED** to a future
cluster (or never, if flake-rate doesn't justify). This plan is only
Tier 1.

**What we are NOT doing.**
- NO parity-matrix backfill (visitor/nickserv coverage for c2/c5/b4/p0e
  — each is a per-cluster decision, not a bulk find-replace).
- NO autojoin-persistence cleanup in b0/p0e (Tier 2 — defer).
- NO afterEach poll-for-settled audit in the 6 specs flagged (Tier 2).
- NO static peer/channel UUIDization in cp22/marker-target/etc (Tier 2).
- NO hardcoded sleep replacements (Tier 3).
- NO refactor of internal-seam-driving specs (Tier 3).
- NO new specs.

## Buckets

### B1 — DM-listener race fixes (4 specs)

**The bug class**: per `feedback_no_duplicate_waiters` +
FLAKE-D memory: specs that fire `peer.privmsg(NETWORK_NICK, …)`
immediately after `selectChannel` race the own-nick DM-listener
`phx.join()` ack. The listener is what promotes the inbound DM into
the focused query window. Without `waitForDmListenerReady(slug)`,
the inbound DM can land before the listener is wired → no
auto-open → no unread bump → 30s timeout on `sidebarWindow(...).
toHaveCount(1)`.

The helper exists at `cicchettoPage.ts:321`
(`waitForDmListenerReady`), with a clear moduledoc explaining the
race. `cp14-b3` correctly uses it (FLAKE-D fix). The 4 specs below
DON'T:

| Spec | Line | Insert |
|------|------|--------|
| `m4-irssi-to-priv-no-window.spec.ts` | ~54-56 (after `selectChannel`, before `IrcPeer.connect`) | `await waitForDmListenerReady(page, NETWORK_SLUG);` |
| `m5-irssi-to-priv-window-open.spec.ts` | ~41-46 (after `selectChannel`, before `composeSend('/query …')`) | same |
| `m6-cicchetto-to-priv.spec.ts` | ~52-56 (after `selectChannel`) | same |
| `p0b-peer-away.spec.ts` | ~33-45 (after `selectChannel`) | same |

**Verification per spec**: run in iso 3× to confirm green (no FLAKE-D
class symptom). Run full chromium project after all 4 land to confirm
no regression.

### B2 — `sidebarWindow` exact-text match

**The bug class**: `cicchettoPage.ts:204` uses substring `hasText` on
the channel `<li>`. Any window name that's a prefix/substring of
another silently double-matches:
- `#bofh` ⊂ `#bofh-test`
- `peer` ⊂ `peer2`
- `#b0-invite-test` ⊂ `#b0-invite-test-something`
- archived channel name + active channel name that share a substring

Currently every spec uses `.first()` (Playwright's default for an
ambiguous locator), so the substring collision returns a
non-deterministic row. **This is the GREEN-CI batch 1 SPEC-4
cascade class at the fixture layer.** Pre-emptive fix before the
next seed expansion bites.

**The fix**: replace `hasText: windowName` with an exact-match regex
that tolerates the optional `[away]` / `[parked]` badge suffix:

```typescript
// BEFORE (cicchettoPage.ts:204)
return section.locator("li", { hasText: windowName });

// AFTER
const exact = new RegExp(`^\\s*${escapeRegExp(windowName)}\\s*(?:\\[.*\\])?\\s*$`);
return section.locator("li").filter({ hasText: exact });
```

Mobile branch at `cicchettoPage.ts:175-177` has the same shape:

```typescript
// BEFORE
return section.locator(".bottom-bar-tab:not(.bottom-bar-network-header)", {
  hasText: windowName,
});

// AFTER (same regex helper)
return section.locator(".bottom-bar-tab:not(.bottom-bar-network-header)")
  .filter({ hasText: exact });
```

Plus a small `escapeRegExp` helper at the top of `cicchettoPage.ts`
(or imported from a fixture-shared util if one exists).

**Verification**: full chromium + webkit-iphone-15 integration run.
If any spec breaks, it's a spec depending on substring match — and
that spec was already wrong. Fix the spec (likely by switching to
the exact channel name).

**Risk**: a spec that intentionally relied on substring (e.g. matches
`#bofh` to also match `#bofh-test`) — none expected. If found, treat
as a spec bug.

### B3 — `globalSetup` cold-start retry

**The bug class**: per `feedback_visitor_mint_e2e_cold_start`,
the first `login()` call against a freshly-spawned IRC session
hits `login_probe_timeout_ms = 3s` before the upstream IRC connection
completes. globalSetup at `seedData.ts:67-100` runs FOUR logins
(vjt, admin, m9b, m9b-victim) — each is the first contact post
container boot.

When `globalSetup` throws, **the entire Playwright run fails before
any spec executes.** No spec output, no partial green, just
"globalSetup failed: 504 Gateway Timeout."

**The fix**: wrap each `login()` in a retry-with-backoff helper:

```typescript
// at top of seedData.ts
async function loginWithRetry(
  identifier: string,
  password: string,
  attempts = 3,
): Promise<LoginResult> {
  let lastErr: unknown;
  for (let i = 0; i < attempts; i++) {
    try {
      return await login(identifier, password);
    } catch (err) {
      lastErr = err;
      if (i < attempts - 1) {
        const backoffMs = 2000 * 2 ** i; // 2s, 4s, 8s
        await new Promise((r) => setTimeout(r, backoffMs));
      }
    }
  }
  throw new Error(`loginWithRetry ${identifier} failed after ${attempts}: ${lastErr}`);
}

// then in globalSetup, replace each `login(...)` with `loginWithRetry(...)`.
```

**Verification**: hard to repro locally without a container restart.
Reasoning + matches the established pattern in
`assertMessagePersisted` / `awaitPushDelivery`. CI integration run
proves no regression.

### B-Z — Close

Per per-cluster cadence (matches FLAKES-Z + GREEN-CI-Z shape):
- Update `docs/checkpoints/2026-05-23-cp45.md` with GREEN-CI-3 buckets +
  CI confirmation.
- Append DESIGN_NOTES entry: "GREEN-CI-3 — Tier 1 e2e hardening."
- Update memory `project_green_ci_cluster_closed.md` if the cluster
  closes cleanly. Otherwise leave the batch-2 close as the cluster's
  final state and document GREEN-CI-3 as a follow-up.
- No new memory unless a sharp lesson surfaces beyond what's already
  in `feedback_seed_expansion_audit` + `feedback_cascade_not_load`.

## Exit criteria

- CI integration: 184 → 184 passed (zero regression).
- CI ci (test+lint+audit+dialyzer): exit-0.
- 3+ clean integration runs on `main` post-merge to call cluster CLOSED
  (one is enough for ship; 3 for cluster-close confidence).
- All 4 DM-listener race specs pass in iso 3× each.
- `sidebarWindow` exact-text match doesn't break any current spec.
- `globalSetup` cold-start retry verified by CI run.

## What's NOT in this plan (Tier 2 + Tier 3 deferred)

Captured here so the next cluster can pick them up:

**Tier 2** (recurrence-class, do next-ish):
- Static peer/channel names → per-run UUID (cp22-bnames, cp22-bwho,
  marker-target, members-prefix-regression — all use static
  `PEER_NICK` / `CHANNEL` that collide on re-runs / bahamut split-mode
  ghost retention).
- afterEach `joinChannel` without poll-for-settled (~6 specs:
  `m9-part-x-click`, `ios-3`, `ios-z`, `ux-1-archive-delete`,
  `ux-2-mobile-archive`, `ux-5-bj`). Bounded poll on
  `/networks/:slug/channels` before returning.
- Autojoin-persistence leak in `b0` / `p0e` — `/join CHANNEL` writes
  to `Networks.Credential.autojoin`, never PARTed. After N runs vjt
  isn't "first joiner" anymore → +o race shifts. Pre-emptive bug we
  just fixed in GREEN-CI batch 2.
- `u-z-cap-honesty:309` hardcoded `cap=2` assumes vjt+m9b-test only —
  next seed expansion breaks STEP 4 silently.
- `m9b-admin-sessions-actions` sub-test poisoning — mutex MUST run
  first, no enforcement.
- `u5-admin-networks-live-counts:96` bare `waitForTimeout(500)`.
- `ux-4-z-cluster-journey:362` no `#ux4z-key-test` PART cleanup.
- `m-z:166-168` `.first()` on capacity_reject proves "row exists ever".
- `m12:47-48` hardcoded leaf hostname.
- 5 admin specs have duplicated `adminFriendlyLogin` — single-source.

**Tier 3** (polish, do when bandwidth):
- Hardcoded sleeps → deterministic signals (`ux-5-br:174`, `ux-6-l:181`,
  `nick-case-sensitivity:81`, `ux-3-oct:104`).
- Structural-only CSS assertions → CSS-source walker (`ios-z:99`,
  `ux-6-d (d)`).
- Cleanup-hole try/finally guards (`ux-5-bc2` theme, `ux-3-oct` body
  style, `ios-4` font-size reset).
- Internal-seam drivers → real-gesture (`ux-6-a-mobile-members-scroll:122`,
  `ux-5-bu-unread-focus:49`, `ux-5-bc2:94` re-implemented hash).
- `i2-image-upload:115` + `i2b:163` `waitForTimeout(500)` → poll pattern.
- `i2b:46-63` WS string sniffing → test-seam accessor.
- `ux-6-j-push-deep-link:40` SW-shape claim (either fix moduledoc or
  exercise real SW).
- `bundle-refresh-banner:78-222` UX-6-I sub-test internal counters →
  user-visible outcome only.
- Fixtures-level: `login()` kind guard (F3), `privmsg` awaited variant
  (F4), `selectChannel` invariant throw (F5).

## Cluster lineage

- Prior: [[project-green-ci-cluster-closed]] (batches 1 + 2)
- Triggered by: vjt 2026-05-23 evening review request
- Next: UX-8 scroll cluster (per locked roadmap, unchanged by this work)

## Workflow

Per established cluster cadence (FLAKES, GREEN-CI batches 1 + 2):

1. `/start` — verify state (HEAD = `e9a3aad`, CP45 active, container up).
2. **B1 first** — 4 specs, one-line each, can ship in a single commit
   (`green-ci-3(b1): waitForDmListenerReady in m4/m5/m6/p0b`). Run
   each in iso 3× then full chromium project.
3. **B2 second** — single fixture edit. Run full chromium + webkit
   integration locally before push (this changes locator semantics for
   every spec). If anything breaks, fix the spec, don't revert the
   fixture.
4. **B3 third** — single fixture edit. Pure reasoning + CI smoke (hard
   to repro cold-start locally without container restart).
5. **B-Z** — docs close + memory update on green CI confirmation.

Per-commit cadence: each bucket = one commit. CI gates between
buckets (per `feedback_per_bucket_deploy` — but no deploy here, just
CI verification).

---

## Appendix — Full review findings (4 parallel agents, 2026-05-23 evening)

The Tier 1 plan above selects from this registry. Tier 2 / Tier 3
items captured here verbatim so a future cluster can act without
re-reviewing. Severity follows agent classification:
HIGH = will-flake-on-next-load, MED = will-bite-on-next-seed-expansion
or refactor, LOW = polish.

### Fixtures-level (affect every spec)

```
cicchettoPage.ts:204 — HIGH (F1, IN TIER 1 / B2) — sidebarWindow substring hasText
  `hasText: windowName` matches inside another name. #bofh ⊂ #bofh-test,
  peer ⊂ peer2. With .first(), the collision is non-deterministic.
  Fix: exact-text regex tolerating optional [away]/[parked] suffix.

cicchettoPage.ts:175-177 — HIGH (same as 204, mobile branch) — bottom-bar-tab
  Same substring shape, mobile branch.

cicchettoPage.ts:268-298 — MED (F5, Tier 3) — selectChannel awaitWsReady silently skips when ownNick undefined
  Default `awaitWsReady: true` requires ownNick; if caller forgets ownNick
  AND keeps default true, the wait silently skips. Caller gets false-ready.
  Fix: throw when awaitWsReady is true but ownNick is missing.

cicchettoPage.ts:297 — MED (Tier 3) — selectChannel awaitWsReady 10s ceiling
  Under load + 3 autojoined users + per-spec channels, JOIN echoes can stack.
  Monitor for cascade re-emergence; tighten or accept as ceiling.

cicchettoPage.ts:321 — LOW (Tier 3) — waitForDmListenerReady 5s timeout
  Tight for cold-load DM-listener subscribe race; 10s safer.

seedData.ts:67-100 — HIGH (F2, IN TIER 1 / B3) — globalSetup no retry
  Four logins, each first-contact post container boot, hits 3s
  login_probe_timeout_ms. globalSetup throw = entire suite skipped.
  Fix: loginWithRetry(3 attempts, 2s/4s/8s backoff).

seedData.ts:147-151 — MED (Tier 3) — hardcoded NETWORK_ID = 1
  Comment acknowledges it. If seeder provisions a second network silently
  mis-targets. Fix: read from REST /networks after login.

seedData.ts:54-57 — LOW (Tier 3) — M9B_VICTIM convention undocumented in CLAUDE.md
  Rule lives only in the comment ("any new admin-destructive spec must
  use m9b-victim"). Lift to CLAUDE.md or fixtures README.

grappaApi.ts:36-48 — HIGH (F3, Tier 3) — login() doesn't guard subject.kind
  Returns typed `subject: {kind: "user", ...}` but doesn't check kind.
  Visitor-as-user silent corruption downstream. Fix: mirror mintVisitor's
  `if (kind !== "user") throw` check.

grappaApi.ts:198-211 — MED (Tier 3) — partChannel swallows non-404 non-2xx
  Throws generic "unexpected status N" with no body. UX-6-D (f)-shape
  silent-401 trap. Fix: include `${await res.text()}` in error.

grappaApi.ts:159-186 — LOW (Tier 3) — assertMessagePersisted 5s ceiling
  Some specs may need 10s on cold-start; optional timeoutMs.

grappaApi.ts:281-296 — LOW (Tier 3) — getReadCursor body-shape assumes read_cursors field
  Optional-chain handles missing; runtime guard or pin via codegenned types.

ircClient.ts:99-108 — HIGH (F4, Tier 3) — privmsg/action fire-and-forget no built-in delivery proof
  Every spec author must remember to assert grappa-side row appearance.
  Foot-gun: every spec is one absent assertion away from silent green.
  Fix: rename to privmsgFireAndForget OR add awaited variant.

ircClient.ts:215-226 — MED (Tier 3) — mode() raw_modes === rawModes exact-match
  Comment acknowledges bahamut packs +ot when asked for +o alone; current
  === would miss packed echo. Fix: includes predicate as comment suggests.

ircClient.ts:46-80 — LOW (Tier 3) — connect() leaks client on registration timeout
  If `await registered` rejects, client stays connected; IrcPeer never
  returned. Fix: try/catch around `await registered`, disconnect on reject.

push.ts:381-383 — MED (Tier 3) — devices-list count == 1 assumes single-device suite ordering
  If prior spec leaked subscription past resetPushSubscriptions, fails.
  Fix: toHaveCount({min: 1}) or resetPushSubscriptions at start too.
```

### Spec-level — HIGH (likely-flake-on-next-load)

```
m4-irssi-to-priv-no-window.spec.ts:54-56 — HIGH (IN TIER 1 / B1) — DM-listener race
m5-irssi-to-priv-window-open.spec.ts:41-46 — HIGH (IN TIER 1 / B1) — DM-listener race
m6-cicchetto-to-priv.spec.ts:52-56 — HIGH (IN TIER 1 / B1) — DM-listener race
p0b-peer-away.spec.ts:33-45 — HIGH (IN TIER 1 / B1) — DM-listener race

m9b-admin-sessions-actions.spec.ts:81-97 — HIGH (Tier 2) — sub-test poisoning, mutex MUST run first
  Self-documented. If Playwright reorders (--repeat-each, --grep, future
  config change), mutex test runs against empty Sessions table → 30s
  timeout. Fix: collapse to single sequential test OR add reconnect to
  mutex test.

u5-admin-networks-live-counts.spec.ts:96 — HIGH (Tier 2) — page.waitForTimeout(500)
  Bare wait after destructive Terminate. expect.poll below already
  handles settle; this is dead weight AND flake-prone. Fix: delete.

ux-4-z-cluster-journey.spec.ts:362 — HIGH (Tier 2) — joins #ux4z-key-test without afterEach PART
  Failed-pseudo row stays in vjt's windowState across afterEach. Each
  rerun adds stale archive entry. Fix: partChannel(#ux4z-key-test) in
  afterEach.

ux-6-j-push-deep-link.spec.ts:40 — HIGH (Tier 3) — page-side dispatchEvent claims to test SW
  Test 1 dispatches MessageEvent on navigator.serviceWorker from page,
  bypassing SW-side existing.navigate() removal. Moduledoc claims SW
  behavior tested but isn't. Fix: drop SW claim OR exercise real SW.

i2-image-upload.spec.ts:115 — HIGH (Tier 3) — page.waitForTimeout(500) "assert no upload"
  Arbitrary; if orchestrator's POST is delayed >500ms slips past.
  Fix: poll endpoint-hit counter for configurable window (push.ts pattern).

i2b-image-upload-litterbox.spec.ts:163 — HIGH (Tier 3) — same waitForTimeout(500)

i2b-image-upload-litterbox.spec.ts:46-63 — HIGH (Tier 3) — waitForServerSettingsFrame WS sniffing
  Raw Phoenix WS payload string substring match. Brittle against any
  wire-shape rename. Pure implementation-detail probe. Fix: test-seam
  accessor (mirror __cic_dmListenerReady pattern).
```

### Spec-level — MED (will-bite-on-next-seed-expansion/refactor)

```
cp22-bnames-names-rows.spec.ts:32 — MED (Tier 2) — static PEER_NICK + NON_JOINED_CHANNEL
  Bahamut split-mode ghost retention on re-runs → 433 rotation, peer.join
  matcher waits forever. Fix: `cp22n-${crypto.randomUUID().slice(0,6)}`.

cp22-bwho-who-rows.spec.ts:23 — MED (Tier 2) — same static-PEER_NICK class

marker-target-window-regression.spec.ts:31,49,80 — MED (Tier 2) — static PEER_NICK
  Used in 2 sub-tests within seconds of disconnect; ghost retention can
  deny re-registration. RUN_ID done for bodies but NOT for nick. Fix:
  per-run UUID for PEER_NICK.

nick-case-sensitivity.spec.ts:81 — MED (Tier 2) — page.waitForTimeout(500)
  toHaveCount(1) below already polls 5s; sleep is dead weight + flake-prone.
  Fix: delete.

bundle-refresh-banner.spec.ts:78-222 — MED (Tier 3) — UX-6-I sub-test internal counters
  Stubs SW + asserts updateCalls === 1, waitingSkipCalls === 1, cache key
  literal names. Refactor breaks it despite identical user-visible behavior.
  bundle-refresh-real-swap covers convergence. Fix: assert only reloaded ===
  true; drop internals.

ios-3-bottom-bar-close.spec.ts:23 — MED (Tier 2) — bare AUTOJOIN_CHANNELS[0] for destructive PART
  Move close-× test onto `#ios3-close-${uuid}` dedicated channel JOINed
  in beforeEach; remove shared-state restoration burden entirely.

ios-z-cluster-journey.spec.ts:99 — MED (Tier 3) — paddingTop only `not.toBeNull`
  Passes for "0px", "1em", anything. Catches "element missing" but not
  "iOS-2 inset rule actually present". Fix: CSS-source walker (mirror
  ux-3-empty-toolbar-island).

ux-3-oct-keyboard-stack.spec.ts:80 — MED (Tier 3) — body.style mutation + 5000px pad no try/finally
  Cleanup unconditional at end; assertion throw leaves pad in DOM +
  overflow:auto for next spec sharing context. Fix: try/finally.

ux-4-z-cluster-journey.spec.ts:489 — MED (Tier 3) — admin newPage shares context localStorage
  loginAs(adminPage, admin) writes admin token to context's localStorage,
  overwrites vjt's. Spec notes the concern but relies on luck (in-memory
  closure). Fix: separate context via browser.newContext().

ux-z-cluster-journey.spec.ts:88 — MED (Tier 2) — for-loop over CLASSES inside one spec
  Loop body lacks per-iteration teardown. Visitor/nickserv skipped today;
  when unblocked, archive holds stale entries, /me cursors collide. Fix:
  per-iteration sub-afterEach with PART + scrollback delete + re-join.

ux-5-bc2-nick-render.spec.ts:202 — MED (Tier 3) — theme switch no restore
  Test 4 flips theme to opposite, never restores. Next spec in same context
  loads with flipped theme; downstream color contrast assertions silently
  shift. Fix: afterEach localStorage.removeItem + reset dataset.theme.

ux-5-bc2-nick-render.spec.ts:94 — MED (Tier 3) — re-implements production djb2 hash
  Test 2 hand-codes hash + palette modulo to inject DOM. Tests spec's hash
  + cascade, not production NickText render-time hash. Fix: render real
  PRIVMSG rows via peer + own with distinct nicks; read computed colors.

ux-5-br-home-reconnect.spec.ts:174 — MED (Tier 3) — page.waitForTimeout(2_000)
  2s "for WS handshake" before chip click. Spec acknowledges. Fix:
  waitForResponse OR __userTopicJoined test seam.

ux-5-bu-unread-focus.spec.ts:49 — MED (Tier 3) — Object.defineProperty visibilityState override
  Drives state via mocked accessor + synthetic event rather than real
  page-visibility. Production change reading from different source
  silently passes. Fix: drive via browser-level page swap; or document
  Playwright limit in moduledoc.

ux-6-a-mobile-members-scroll.spec.ts:122 — MED (Tier 3) — manual overlay-open class add
  Tests CSS rule, NOT production overlay-open management. Refactor breaks
  addition site silently. Fix: drive via real drawer open OR add positive
  assertion that real overlay puts touch-action: none.

ux-6-b-admin-settings.spec.ts:36 — MED (Tier 3) — adminFriendlyLogin bypasses loginAs
  Drives auth via addInitScript localStorage. Other admin specs use loginAs.
  Fix: switch to loginAs(page, admin) for symmetry.

ux-6-d-keyboard-pattern.spec.ts:120 — MED (Tier 3) — padding-bottom === "0px" can't tell rule from absence
  Passes if shell-mobile has no padding-bottom at all OR rule fires
  correctly. Fix: CSS-source walker for `.shell-mobile:has(:focus)` rule
  presence.

ux-6-j-push-deep-link.spec.ts:64 — MED (Tier 3) — li.selected.first() lottery
  Multiple selected rows can exist (Sidebar + BottomBar on desktop+mobile
  shells). Archive row with same hasText would false-positive. Fix:
  scope to .sidebar-network-section li.selected per network.

ux-6-l-foreground-push-beep.spec.ts:181 — MED (Tier 3) — page.waitForTimeout(1_000) negative assertion
  Bare 1s sleep before negative beep assertion. Fix: poll for post-arrival
  signal (sidebar/scrollback) THEN assert beep null.

m-z-admin-cluster-journey.spec.ts:166-168 — MED (Tier 2) — .first() on capacity_reject
  Proves "row exists ever" not "this PATCH's row landed". Fix: capture
  prior count, assert `>= prior + 1`.

m11-peer-nick.spec.ts:45-47 — MED (Tier 2) — pre-condition race on shared #bofh
  Members-pane visibility wait races 3 autojoin candidates. Fix: assert
  scrollback JOIN row first.

m8-cicchetto-join.spec.ts:75-77 — MED (Tier 2) — toHaveClass(/selected/) racy under load
  selectedChannel can fast-switch through transient states. Fix: assert
  compose-textarea visible + sidebar entry present (user-visible auto-focus).

m12-motd-server.spec.ts:47-48 — MED (Tier 2) — hardcoded leaf4.azzurra.chat
  Testnet leaf rename → 30s silent timeout. Fix: import from seedData OR
  relax to non-empty sender + kind: notice.

m9-cicchetto-part-x-click.spec.ts:48-51 — MED (Tier 2) — afterEach joinChannel no poll
  Doesn't wait for JOIN round-trip; next spec selectChannel assumes joined.
  Fix: poll /networks/:slug/channels until joined: true.

u-z-cap-honesty-cluster-journey.spec.ts:309-311 — MED (Tier 2) — hardcoded cap=2
  Assumes vjt + m9b-test only. Adding 4th user silently breaks STEP 4.
  Per feedback_seed_expansion_audit exactly this class. Fix: query GET
  /admin/networks/:slug for live count, set cap = count + 5.

b0-invite-from-server-window.spec.ts:51 — MED (Tier 2) — autojoin-persistence leak
  /join persists into Networks.Credential.autojoin; never PARTed. After N
  runs vjt no longer "first joiner". Recurrence of the bug GREEN-CI batch 2
  just fixed. Fix: afterEach partChannel(CHANNEL).

p0e-invite-ack.spec.ts:54 — MED (Tier 2) — same autojoin-persistence leak as b0

b0-invite-from-server-window.spec.ts:71 — MED (Tier 2) — .first() on shared $server invite-ack-row
  $server scrollback persists + shared across specs. Stale invite-ack from
  earlier spec matches first. Fix: filter by hasText: CHANNEL before .first().

b2-inbound-invite-cta.spec.ts:58 — MED (Tier 2) — same .first() shape

p0e-invite-ack.spec.ts:81 — MED (Tier 2) — same .first() shape

c2-whois.spec.ts:46 — MED (Tier 2) — peer.join not required for WHOIS
  Couples spec to channel state unnecessarily. Fix: drop peer.join.

c5-member-leftclick.spec.ts:38 — MED (Tier 2) — members-pane race with peer JOIN
  5s tight; channel topic delivers JOIN event after upstream echo. Fix:
  10s OR wait for scrollback join-line first.
```

### Spec-level — LOW (polish)

```
ios-3-bottom-bar-close.spec.ts:32 — LOW (Tier 2) — afterEach joinChannel no poll
ios-z-cluster-journey.spec.ts:54 — LOW (Tier 2) — same
ux-1-archive-delete.spec.ts:37 — LOW (Tier 2) — same
ux-2-mobile-archive.spec.ts:38 — LOW (Tier 2) — same
ux-5-bj-no-join-splash.spec.ts:37 — LOW (Tier 2) — same

ios-4-font-size.spec.ts:67 — LOW (Tier 3) — reset-to-M outside try/finally
  Assertion throw leaves XL in localStorage for next spec. Mirror ios-z's
  finally pattern.

ux-3-oct-keyboard-stack.spec.ts:104 — LOW (Tier 3) — 50ms setTimeout for scroll listener fire
  Acceptable for sub-50ms scheduler yield; flag if flake observed.

ux-5-bk-join-fail-dupe.spec.ts:44 — LOW (Tier 3) — module-scoped let peer
  Single test today; second test would silently break. Document or restructure.

ux-5-bo-mobile-settings-scroll.spec.ts:110 — LOW — el.scrollTop = 200 exercises API not gesture
  Moduledoc acknowledges; spec pins preconditions. Acceptable.

ux-5-bu-unread-focus.spec.ts:147 — LOW — page.route stays active rest of test
  Acceptable per test scope.

ux-6-c-mobile-admin-launcher.spec.ts:88 — LOW — afterEach demotes vjt even on test that never promoted
  Idempotent so OK; cleaner per-test rather than blanket.

ux-6-d-keyboard-pattern.spec.ts:140 — LOW — smart-pin probe with programmatic scroll
  feedback_ux_6_d_anti_patterns #1 says smart-pin is touch-gated. Verify
  current behavior or use synthetic touch sequence.

ux-6-f-send-button-glyph.spec.ts:65 — LOW — asserts on data-testid compose-send-glyph
  Testid is the stable contract. Mostly fine.

m9b-admin-sessions-actions.spec.ts:130,156 — LOW (Tier 2) — error-absence as success signal
  toHaveCount(0) on error-banner proves "no error" not "action succeeded".
  Fix: assert row drops post-action.

m8-admin-visitors-delete.spec.ts — LOW (Tier 3) — test.skip with no tracking issue
  Skipped per visitor-mint cold-start gap; documented; no GH issue / todo ★
  pin. Persistent skip without reactivation gate = forever-dead.

u-4-device-identity-change.spec.ts — LOW (Tier 3) — same dead-skip class

m7-admin-gate/m9b/m10/m11/m-z — LOW (Tier 3) — addInitScript localStorage seed
  Acceptable shortcut (login UX isn't under test) but adminFriendlyLogin
  duplicated literally across 5+ files. Fix: extract to shared fixture.

u-3-cap-honesty-mapping.spec.ts:231 — LOW (Tier 3) — hardcoded password literal
  Future password rotation breaks silently. Fix: import M9B_PASSWORD.

p0c-whowas.spec.ts:67 — LOW (Tier 3) — Date.now().toString(36) collision-prone
  Rapid retries within same second collide. Fix: crypto.randomUUID().slice(0,8).

cic-members-panel-scope.spec.ts:88-90 — LOW (Tier 2) — DM query window left open across specs
  Persists in queryWindowsByNetwork for vjt. Fix: afterEach close × OR
  randomize DM_PEER per run.

members-prefix-regression.spec.ts:39,40 — LOW (Tier 2) — static PEER_NICK + static CHANNEL no afterEach
  Channel persists in autojoin (post-GREEN-CI-2 fix). Repeated runs:
  vjt-as-first-opper invariant violated. Fix: per-run channel suffix +
  unique peer nick.

push-permission-denied.spec.ts:62-70 — LOW (Tier 3) — explicitly skips assertion of acknowledged bug
  Spec body avoids asserting toggle-OFF "because pre-existing UX bug."
  Per CLAUDE.md "fix root causes." Fix: file regression as todo bullet so
  comment doesn't become permanent.

socket-health-banner.spec.ts:37-43,65-71 — LOW (Tier 3) — drives internal __cic_socketHealth signal
  Justified per spec comment (no real WS-failure path), but probes synthetic
  state. Consider sibling spec via deliberately-non-matching origin.

cp15-b6-archive-query-revival.spec.ts:46-49 — LOW (Tier 2) — query window revived state persists
  PEER_NICK per-run UUID so no collision but row persists. Fix: closeQueryWindow afterEach.
```

### Solid (no findings — explicitly verified)

`m1`, `m2`, `m3`, `m7-admin-gate`, `m7-peer-join-no-bouncer-follow`,
`u-2-admission-split`, `p0a-whois-flags`, `cp13-server-window`,
`cp14-b1-scroll-marker-vs-bottom`, `cp14-b2-scroll-up-loadmore`,
`cp14-b3-dm-history-bidirectional` (waitForDmListenerReady in place),
`cp15-b4-archive-section`, `cp15-b5-window-state-pending-to-joined`,
`cp15-b6-kicked`, `cp15-b6-parked`, `cp15-b6-part-archive-rejoin`,
`cp15-b6-pending-to-failed-invite-only`, `scroll-on-window-switch`,
`message-replay-on-reconnect`, `refresh-on-join`,
`r6-own-action-no-events-badge`, `rev-g-h22-sw-denylist` (real SW),
`bundle-refresh-real-swap` (real swap), `push-install`,
`push-install-splash`, `push-prefs-whitelist`,
`push-server-fires-regardless-of-focus`, `push-trigger-channel-mention`,
`push-trigger-dm` (all push specs verify catcher receipt), `_smoke`,
`bug7-m6-ios-dm-own-msg-visible`, `bug7-ios-own-msg-visible`,
`ux-3-empty-toolbar-island`, `ux-5-bd-bottom-safe-area-floor`,
`ux-5-bm-mobile-hamburger`, `ux-5-bs-resizable-sidebars`,
`ux-5-bt-narrow-chrome-compression`, `ux-5-bv-mobile-keyboard-react`,
`ux-5-a-hamburger-dedupe`, `ux-6-b-embedded-upload` (real round-trip),
`ux-6-e-narrow-server-dedup`, `ux-6-g-admin-mobile-h-scroll`,
`ux-6-k-pm-unread-cursor` (correct waitForDmListenerReady), `b4-linkify`.

### Per-class totals

| Class | HIGH | MED | LOW |
|-------|------|-----|-----|
| DM-listener race | 4 | 0 | 0 |
| Sub-test poisoning | 1 | 0 | 0 |
| Bare waitForTimeout | 3 | 2 | 1 |
| Substring/match locator | 2 (F1) | 1 | 0 |
| Static peer/channel (re-run collision) | 0 | 4 | 1 |
| afterEach joinChannel no poll | 0 | 1 | 5 |
| Autojoin-persistence leak | 0 | 2 | 1 |
| .first() on shared/persistent state | 0 | 4 | 0 |
| Hardcoded literal (cap/sender/password) | 0 | 3 | 1 |
| Internal-seam drivers (not real gesture) | 1 | 4 | 0 |
| Structural-only assertion | 0 | 2 | 0 |
| globalSetup cold-start no retry | 1 (F2) | 0 | 0 |
| login() kind guard / API guards | 1 (F3) | 2 | 1 |
| privmsg fire-and-forget no proof | 1 (F4) | 0 | 0 |
| selectChannel invariant skip | 1 (F5) | 1 | 1 |
| SW-shape claim mismatch | 1 | 0 | 0 |
| Cleanup-hole shared state | 0 | 2 | 1 |
| Duplicated helpers | 0 | 0 | 1 (5 files) |
| Dead test.skip no reactivation pin | 0 | 0 | 2 |
| Test buggy behavior (deferred bug) | 0 | 0 | 1 |
| Misc polish | 0 | 0 | 4 |

**TIER 1 (this plan)** covers: 4 DM-listener race + F1 substring +
F2 globalSetup retry = 6 of the 17 HIGH findings, prioritised by
fix-once-cure-all leverage.

**TIER 2** = 11 MED findings most likely to bite next seed expansion
or cluster cadence.

**TIER 3** = remaining polish + structural-only + internal-seam
items.

### Cross-cutting observations (4-agent consensus)

- **No `.first()` lottery class on admin destructive actions** — all
  fixed by GREEN-CI batch 1.
- **No internal-state probes worth deleting** — every flagged spec
  tests user-visible behavior. The "stupid internals" check came back
  clean for the suite as a whole.
- **2 specs documented as driving fake state** (`socket-health-banner`,
  `ux-5-bu-unread-focus`) — both justified with explicit moduledoc
  acknowledging the Playwright limit; acceptable.
- **All `@webkit` tags correctly applied** — no `tap()` on non-touch
  contexts.
- **All push specs verify catcher receipt** (push-catcher HTTP POST
  landed), not just cic API call — correct end-to-end shape.
- **All SW specs use real round-trip** (`rev-g-h22-sw-denylist`,
  `bundle-refresh-real-swap`) except the `bundle-refresh-banner`
  UX-6-I sub-test which stubs internals (flagged MED Tier 3).
- **Parity-matrix per `feedback_e2e_user_class_parity_matrix`**: NOT
  exercised by c2/c5/b0/b2/b4/i2/p0d/p0e — all assume registered vjt.
  Flag for cluster-level backfill (not Tier 1/2/3 — separate
  decision).
- **`feedback_e2e_visitor_members_list` invariant**: c5 closest spec
  to backfill; ~5 lines extra.

