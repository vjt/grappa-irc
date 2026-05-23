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
