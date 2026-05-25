# E2E-ROBUSTNESS bucket D — per-spec subject reset (compile-gated HTTP endpoint)

**Cluster**: E2E-ROBUSTNESS (chromium suite pollution audit).
**Bucket**: D — generalized seed-user reset, replaces bucket D's
original "WS subscribe-vs-broadcast race" framing per spike findings
(cp48 S2 diagnostic theory was inconsistent with code reality;
investigation reframed the disease as cross-spec server-state
pollution, not subscribe-ack race).

## Problem

cicchetto's Playwright suite already gives each test a fresh
BrowserContext (default `@playwright/test` fixture model — no
`storageState`, no worker-scoped fixtures, `workers:1`). Browser
state is NOT the leak source.

What persists across specs is **grappa server-side state on the
single shared seed user `vjt`**:

- DB rows: `read_cursors`, `query_windows`, `network_credentials`
  (`connection_state`), `user_settings`, `push_subscriptions`,
  `messages`, `uploads`
- `Session.Server` GenServer state: `members`, `topics`,
  `channel_modes`, `window_state` (the per-channel
  `:pending | :joined | :failed | :kicked | :parked` map +
  failure metadata), `in_flight_joins`, `away_state`,
  `auto_away_timer`, `caps_active`, `labels_pending`,
  `last_command_window`, `ghost_recovery`, `ghost_timer`
- Other process state: `WSPresence`, `NetworkCircuit`,
  `Session.Backoff` ETS tables

cp48's cursor sub-cluster fixed ONE row class
(`restoreReadCursorToTail` afterAll). The chronic rotating-victim
flake set (m2, scroll-225, ux-5-bs:88, cp15-b6:32, p0e) is the
generalized version of the same class — different specs mutate
different surfaces, and the next spec in lex order inherits the
mutation.

## Goal

A single afterEach call that drains ALL mutable seed-user state
in <100ms, so every spec begins from a clean baseline regardless
of predecessor. Eliminate the rotating-victim cascade. Optional
side benefit: unlocks bucket E (`workers > 1`) by removing the
ordering-sensitivity that forces serial execution.

## Non-goals

- NOT rebooting the testnet (bahamut, NickServ) per spec —
  cluster C handles upstream-state-only flakes separately.
- NOT swapping the single shared seed user for per-spec mints —
  cluster brief option (γ); kept as fallback if reset proves
  insufficient.
- NOT reverting cp48's existing `restoreReadCursorToTail`
  helpers in the same change — those stay until the reset
  endpoint is proven to subsume them.

## Design

### Shape (β) — compile-gated HTTP endpoint

A new route `POST /admin/test/reset-subject`, registered only
when `Mix.env() in [:dev, :test]`. The prod release simply does
not contain the route (Mix env is a compile-time literal).

```elixir
# lib/grappa_web/router.ex
if Mix.env() in [:dev, :test] do
  scope "/admin/test", GrappaWeb.Admin.Test do
    pipe_through [:api, :authn, :admin_authn]
    post "/reset-subject", ResetSubjectController, :reset
  end
end
```

Pipeline reuse: rides on existing `:admin_authn` plug, so the
endpoint inherits the same admin-only gate that protects
`/admin/sessions` etc. Caller (Playwright) presents the seeded
`admin-vjt` bearer token.

### Request shape

```
POST /admin/test/reset-subject
Authorization: Bearer <admin-vjt token>
Content-Type: application/json

{ "user_name": "vjt" }
```

Subject MUST be passed explicitly — never default. Per CLAUDE.md
"no default arguments via \\\\". Returns `204 No Content` on
success, `404` if user not found, `422` on validation, `500`
with `{error: msg}` on partial failure.

### What it does (controller → context calls)

ONE controller action delegates to a new
`Grappa.TestSupport.SubjectReset.reset!/1` context function.
Per CLAUDE.md "controllers thin, contexts thick" + "use
infrastructure, don't bypass it" — every step reuses existing
verbs:

1. **Drain DB rows for `user_id`** via context functions:
   - `ReadCursor.clear_all_for_user/1`        — new helper
   - `QueryWindows.close_all_for_user/1`      — new helper
   - `Push.subscription_clear_all_for_user/1` — new helper
   - `UserSettings.reset_for_user/1`          — new helper
     (deletes the row; next read returns defaults)
   - `Uploads.delete_all_for_user/1`          — new helper
   - Scrollback `messages`: NOT deleted (huge + persistent
     scrollback is the product). Skip — specs assert on
     `assertMessagePersisted` which counts up across specs but
     never reads tail-relative.

2. **Restart `Session.Server`** for each
   `(user, network)` row in `network_credentials`:
   - Call `Grappa.SpawnOrchestrator.respawn/2` (new verb if
     missing; otherwise re-use the existing supervisor restart
     verb). This wipes ALL in-memory state including
     `window_state`, `members`, `topics`, `away_state`,
     `auto_away_timer`, `in_flight_joins`. Cleanest — uses
     OTP's "let it crash" model as a feature.

3. **Reset `NetworkCircuit`, `WSPresence`, `Session.Backoff`
   ETS entries** for affected keys via existing reset verbs
   (Backoff already has `reset/2`; WSPresence + NetworkCircuit
   need a new test-only reset/1 per surface).

4. **Wait for re-bootstrap** — the orchestrator awaits the
   restarted session reaching `:connected` via the same probe
   `loginWithRetry` uses (login_probe_timeout_ms 3s window).
   Reset returns 204 only after every credential's Session.Server
   is back to `:connected` state. Synchronous; afterEach gets a
   guaranteed-clean baseline.

### What it does NOT do

- Does NOT touch other users (admin-vjt, m9b-test, m9b-victim).
  Those persist for their respective specs' lifetimes.
- Does NOT touch `users.is_admin` (vjt stays admin per
  `feedback_vjt_is_permanent_admin`).
- Does NOT touch `accounts_sessions` (bearer tokens) — the seed
  token stays valid.
- Does NOT reset Bahamut testnet state (joined channels,
  /invite cooldown). Cluster C territory.
- Does NOT touch upstream NickServ registration. Cluster C.

### Test-side wiring

```typescript
// cicchetto/e2e/fixtures/grappaApi.ts
export async function resetSubject(adminToken: string, userName: string) {
  const res = await fetch(`${process.env.E2E_BASE_URL}/admin/test/reset-subject`, {
    method: "POST",
    headers: { Authorization: `Bearer ${adminToken}`, "Content-Type": "application/json" },
    body: JSON.stringify({ user_name: userName }),
  });
  if (res.status !== 204) throw new Error(`resetSubject failed: ${res.status} ${await res.text()}`);
}
```

Wire into a single root-level `test.afterEach` in
`cicchetto/e2e/fixtures/cicchettoPage.ts` (or a new
`globalAfterEach.ts`) — fires after every spec that touches vjt.
Specs that already have explicit cleanup (cursor afterAll
helpers from cp48) keep them as defense-in-depth; they become
no-ops after reset but document intent.

### Failure modes + handling

- **Reset endpoint times out (≥ 3s waiting for Session.Server
  to reach `:connected`)**: 504 response. afterEach throws,
  spec is marked as failed cleanup. Loud signal that upstream
  is sick — better than silently leaving state mid-restart.
- **Concurrent specs hit reset** (when `workers > 1`): out of
  scope for this bucket. Bucket E will add per-worker seed
  user isolation if needed.
- **Reset called against non-existent user**: 404. afterEach
  throws. Caller bug — never silently swallow.

## Architecture

```
afterEach (Playwright)
   │
   ▼
POST /admin/test/reset-subject  ── [compile-gated route]
   │
   ▼
GrappaWeb.Admin.Test.ResetSubjectController.reset/2
   │
   ▼
Grappa.TestSupport.SubjectReset.reset!/1
   ├── ReadCursor.clear_all_for_user/1
   ├── QueryWindows.close_all_for_user/1
   ├── Push.subscription_clear_all_for_user/1
   ├── UserSettings.reset_for_user/1
   ├── Uploads.delete_all_for_user/1
   ├── for each credential:
   │     SpawnOrchestrator.respawn/2  (Session.Server stop + restart)
   ├── NetworkCircuit.reset/1
   ├── WSPresence.reset/1
   ├── Session.Backoff.reset/2
   └── await every Session.Server reaches :connected (≤ 3s)
```

## Testing

Per CLAUDE.md "TDD: failing test FIRST":

1. **Unit test** for `Grappa.TestSupport.SubjectReset.reset!/1`
   — assert each DB table drained, assert Session.Server pid
   changed (new process post-restart), assert `WSPresence` ETS
   key absent.

2. **Controller test** for `ResetSubjectController` — assert
   admin-token round-trip returns 204, non-admin returns 403,
   missing-user returns 404, valid request drains state.

3. **E2E pilot** — single-spec change first: pick m2 (known
   victim) + cursor-walks-with-scroll.spec.ts (cp48-fixed
   cursor sentinel) and wire reset into THEIR afterEach. Run
   `scripts/integration.sh --project chromium` 5× and compare
   rotating-victim count vs current main. Decision gate:
   - Cascade eliminated (0-1 rotating victim across 5 runs):
     scale to all specs.
   - Cascade unchanged (2+ rotating victims): roll back, return
     to systematic-debugging Phase 1 with new evidence.

4. **Architecture / Boundary** — `Grappa.TestSupport` lives at
   a NEW boundary; declare it depends on `Grappa.Networks`,
   `Grappa.ReadCursor`, `Grappa.QueryWindows`, `Grappa.Push`,
   `Grappa.UserSettings`, `Grappa.Uploads`. Boundary annotation
   enforces — no random module gets to call into it.

## Exit criteria

- `scripts/check.sh` exit 0 (format, credo, dialyzer, sobelow,
  doctor, mix test 2455+, bun check, bun test, bats).
- Pilot specs: 5/5 ✓ in 5 consecutive full chromium runs.
- Once scaled to all specs: chromium full run shows
  ≤ 1 rotating victim across 5 consecutive runs (matches
  baseline iso pass rate).
- README + `docs/TESTING.md` updated with the
  `/admin/test/reset-subject` contract + the afterEach pattern.

## Future work (out of scope for D)

- **Bucket E (speed)**: now that ordering doesn't matter,
  `workers > 1` becomes safe. Per-worker subject mint
  (extension to globalSetup) needed to avoid cross-worker
  reset races.
- **Bucket A (audit)**: the reset eliminates most cascades,
  but bucket A's poisoner→victim catalog stays valuable for
  documenting WHICH specs mutate WHAT (so future test
  authors know what to NOT depend on).
- **Bucket C (Bahamut /invite cooldown)**: still needed —
  reset doesn't touch testnet state.

## Decision log

- **Why (β) compile-gated HTTP, not (α) Mix-task or (γ)
  bounce-only**: (α) adds ~1s/spec shell-out tax (×190 ≈
  +3min); (γ) doesn't drain DB rows so it's incomplete.
  (β) reuses Phoenix routing/auth infrastructure (CLAUDE.md
  "use infrastructure, don't bypass it") and Mix env's
  compile-time literal-substitution gives a hard guarantee
  the route is absent from prod artifacts.
- **Why one omnibus endpoint, not N targeted endpoints**:
  CLAUDE.md "one feature, one code path" — the spec author
  shouldn't pick which surfaces to reset; the reset is the
  baseline, callers don't need granularity.
- **Why Session.Server restart, not per-field
  reset_in_memory call**: restart is OTP's blessed reset
  primitive; adding `reset_in_memory` to Session.Server
  duplicates supervisor responsibilities and creates a
  second state-clearing code path. "Let it crash" applies
  to test reset too.
- **Why skip scrollback `messages`**: huge table; specs
  don't read tail-relative; persistent scrollback IS the
  product. cp48 made `restoreReadCursorToTail` work
  precisely because cursor + scrollback are independent.
