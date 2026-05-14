# Codebase Review Draft — Lifecycle (no-silent-drops B5)
**Agent:** lifecycle
**Scope:** application + bootstrap + spawn_orchestrator + session/* + admission/* + visitors/{login,reaper} + ws_presence
**Date:** 2026-05-14
**Branch:** cluster/no-silent-drops (commits B0..B4)

## Summary

| sev | count |
|-----|-------|
| CRIT | 1 |
| HIGH | 6 |
| MED  | 8 |
| LOW  | 5 |
| NIT  | 2 |
| **total** | **22** |

Top themes:
1. **B1 catch-all is a partial fix that re-introduces the disease class for two specific verbs** — empty-trailing verbs persist-fail silently (re-creating the silent drop B1 was supposed to close), and inbound `AUTHENTICATE` lands cleartext-shaped continuation payloads on `$server` (secret leakage). The "no-silent-drops" cluster's headline change has two undocumented escape hatches.
2. **Cross-process state leak in tests is acknowledged but unfixed** — `NetworkCircuit` ETS table contaminates `BootstrapTest` + `SpawnOrchestratorTest` per the standing memory; the 2026-05-12 review's S2 (Bootstrap-vs-Orchestrator divergence) AND the underlying ETS-leak bug both still apply.
3. **Two paths still bypass `SpawnOrchestrator`** — `Visitors.Login.spawn_and_await/3` calls `Session.start_session/3` directly (no admission re-check post-`stop_session`, no Backoff reset on Case 1 success), and `Bootstrap.spawn_one/2` does NOT pass through the orchestrator's pre-resolved-plan contract because plan resolution happens at the Bootstrap layer. The boundary-of-truth is still drifty.
4. **Defensive try/catch + dead-letter swallow patterns** — overly broad `:exit, _` catch in `terminate/2`; multiple `rescue ArgumentError -> ...` blocks in Backoff/NetworkCircuit ETS readers that paper over a real boot-ordering invariant by silently returning "no entry"; `Process.send_after` timer-cancel-and-drain that's necessary but uncovered for the ghost-recovery path.

---

## CRITICAL

### [CRIT] B1 EventRouter catch-all persists inbound `AUTHENTICATE` continuation payloads on `$server`
**File(s):** `lib/grappa/session/event_router.ex:1500-1533`
**Description:** Bucket B1 (commit `0b96ba9`) replaced EventRouter's catch-all `{:cont, state, []}` with a `:notice` persist on `$server` carrying `meta.raw = %{verb, sender, params}` and `body = List.last(params) || ""`. The catch-all matches **every** unhandled verb — including `:authenticate`. `IRC.Client` dispatches every parsed `Message` (including `:authenticate`) via `{:irc, msg}` to `Session.Server` (see `lib/grappa/irc/client.ex:663`); after the AuthFSM handshake completes, an upstream `AUTHENTICATE` continuation prompt or a stray re-auth request lands here and gets:
1. **Persisted to scrollback as plaintext** — `meta.raw["params"]` carries the full param list including any base64 SASL payload.
2. **Broadcast over PubSub on `$server`** — every connected cic tab for this user receives it.
3. **Replayable on reconnect** — REST `/messages` returns it indefinitely.

This is the same disease class as the W12 NickServ-password-leak that `service_target?/1` (server.ex:1644) was hardened against. The bucket-1 commit message acknowledges `KILL, WALLOPS, GLOBOPS, ERROR, CHGHOST, AUTHENTICATE, vendor verbs` were all dropped pre-fix — but bundling AUTHENTICATE into the same persist path violates the same privacy contract.

**Recommended fix:** Add an explicit allowlist exclusion for verbs that may carry secrets:
```elixir
@catchall_skip_verbs ~w(authenticate)a
def route(%Message{command: command} = _msg, state)
    when command in @catchall_skip_verbs do
  {:cont, state, []}
end
```
Place BEFORE the bucket-1 catch-all. AUTHENTICATE inbound is also genuinely uninteresting to the operator — AuthFSM handles it during registration; post-registration it's a protocol oddity, not a UI event. Same logic could apply to `:cap` (already handled by Server's CAP ACK arm at server.ex:1450 but slips through to EventRouter via `delegate/2`'s catch-all in handle_info({:irc, ...})).

---

## HIGH

### [HIGH] B1 catch-all silently drops verbs with no trailing param (the very thing it was supposed to fix)
**File(s):** `lib/grappa/session/event_router.ex:1519-1533` + `lib/grappa/session/server.ex:2251-2278`
**Description:** The B1 catch-all sets `body = List.last(params) || ""`. When the inbound message has no params (or empty trailing), body becomes `""`. `Scrollback.Message.changeset/2` enforces `validate_required([:body])` for `kind: :notice` (`@body_required_kinds`); empty string fails this validation. The `apply_effects([{:persist, :notice, attrs} | _], _)` arm at server.ex:2269 hits the `{:error, changeset}` branch — `Logger.error("scrollback insert failed", ...)` + drops the row + does NOT broadcast over PubSub. Net behavior: an inbound verb like a bare `WALLOPS` (no trailing message) or `ERROR` with empty trailing or any vendor verb that signals state-only with no body is **silently dropped from cic** — no scrollback row, no PubSub event, no operator-visible signal beyond a Logger.error line buried in `monitor.sh` output.

The "no-silent-drops" cluster's central thesis — surface every inbound verb to the user — is undermined by the changeset-validation reject path. B1's commit message names this as the solved class; the fix is partial.

**Recommended fix:** Make the body fall back to a non-empty string when trailing is absent — use the verb name as the minimum-viable body so the changeset accepts:
```elixir
body =
  case List.last(params) do
    s when is_binary(s) and s != "" -> s
    _ -> command_to_verb_string(command)
  end
```
Or — better aligned with the principle — add a new schema kind `:server_event` that accepts nil/empty body (cold deploy + migration cost, but semantically honest: a stateful server event isn't a notice). The current shape is half a fix.

### [HIGH] Two ETS tables leak across container runs in tests; AdmissionTest cleans, BootstrapTest + SpawnOrchestratorTest do not
**File(s):** `test/grappa/bootstrap_test.exs` (no NetworkCircuit/Backoff cleanup); `test/grappa/spawn_orchestrator_test.exs` (no NetworkCircuit cleanup); `test/grappa/admission_test.exs:13-15` (does clean)
**Description:** Per the standing memory `project_network_circuit_ets_leak`: `Grappa.Admission.NetworkCircuit` and `Grappa.Session.Backoff` are application-wide singletons backed by named ETS tables (`:admission_network_circuit_state`, `:session_backoff_state`). They survive across the entire `mix test` run — and across `scripts/test.sh` reruns into the same container, since `max_cases: 1` only serializes test execution, not state.

`AdmissionTest` cleans the table in its `setup` block (`for {key, _, _, _, _} <- NetworkCircuit.entries(), do: :ets.delete(...)`). `BootstrapTest` and `SpawnOrchestratorTest` do NOT. A previous test run that left the network in an `:open` circuit state will fail subsequent `Bootstrap.spawn_*` / `SpawnOrchestrator.spawn/4` tests with `{:network_circuit_open, N}` — which surfaces as flaky `:failed` counter increments OR `{:error, {:network_circuit_open, _}}` from the orchestrator. Same drift applies to `Backoff`: a leftover failure count delays the next test's connect path past its `wait_for_ready` timeout.

The standing memory marks this as a B5 review action. It's not closed; the test files still don't carry the cleanup.

**Recommended fix:** Promote the cleanup to a shared test helper and add it to both files' `setup` blocks:
```elixir
# test/support/admission_state_helpers.ex (new)
defmodule Grappa.AdmissionStateHelpers do
  def reset_circuit_and_backoff do
    for {key, _, _, _, _} <- Grappa.Admission.NetworkCircuit.entries(),
        do: :ets.delete(:admission_network_circuit_state, key)
    for {key, _, _} <- Grappa.Session.Backoff.entries(),
        do: :ets.delete(:session_backoff_state, key)
  end
end
```
Then `setup do reset_circuit_and_backoff() end` in BootstrapTest + SpawnOrchestratorTest + AdmissionTest. Don't duplicate the for-loop. Consider `setup_all` if the test files are guaranteed to have isolated network IDs.

### [HIGH] `Visitors.Login.spawn_and_await/3` bypasses `SpawnOrchestrator` AND skips admission re-check post-stop_session
**File(s):** `lib/grappa/visitors/login.ex:285-305` + `lib/grappa/visitors/login.ex:229-240`
**Description:** `preempt_and_respawn/4` calls `Accounts.revoke_sessions_for_visitor/1` → `Visitors.purge_if_anon/1` → `Session.stop_session/2` → `Backoff.reset/2` → `spawn_and_await/3`. The `spawn_and_await/3` call invokes `Session.start_session/3` DIRECTLY — admission was checked once at the top of `dispatch/4` (lines 153, 183, 197) BEFORE the stop. Between the admission check and the start_session call, **the session being preempted is still counted by the network-cap `Registry.count_select/2`** (Admission.count_live_sessions/1 at admission.ex:143). After `stop_session`, the count drops by 1 — the new spawn would now succeed against a different cap state than what the original check observed.

This is mostly benign in practice (capacity is loosened, not tightened, by the stop) but the orchestrator's documented contract is "admission → reset → spawn." Login's flow is "admission → stop → reset → spawn" — the admission decision is observation-stale by the time spawn fires. More importantly, the `SpawnOrchestrator` moduledoc's reasoning for why Login can't reuse the orchestrator (4 reasons enumerated in `spawn_orchestrator.ex:50-83`) ALL apply to the START of `dispatch/4`, not to `preempt_and_respawn`. Case-2 (registered visitor preempt) does:
- `Backoff.reset/2` — same verb
- `Session.start_session/3` (via `spawn_and_await`) — same verb plus `notify_pid` thread
- followed by `NetworkCircuit.record_success/1` on welcome — same as orchestrator's caller-owned-observability pattern

The 80% IS the orchestrator. The 20% (notify_pid + monitor_ref + receive) could be a `SpawnOrchestrator.spawn_and_monitor/4` variant the way the moduledoc S15 (carryover from 2026-05-12 review) noted.

**Recommended fix:** Re-examine after no-silent-drops cluster closes. Either:
- (a) Add `SpawnOrchestrator.spawn_and_monitor(subject, network_id, plan, capacity_input, timeout)` that absorbs the notify+monitor concerns. Login's `preempt_and_respawn` becomes one orchestrator call. OR
- (b) Document explicitly in SpawnOrchestrator that the intentional bypass for Login is the post-stop preempt path (Case 2 only), and accept the observation-staleness with a code comment in `preempt_and_respawn`.

### [HIGH] Backoff/NetworkCircuit `rescue ArgumentError -> 0/:ok` masks a boot-ordering invariant
**File(s):** `lib/grappa/session/backoff.ex:140-152, 192-202, 261-268`; `lib/grappa/admission/network_circuit.ex:124-160, 107-114`
**Description:** Both modules implement defensive ETS-table-missing rescues:
```elixir
rescue
  ArgumentError -> 0  # or :ok / []
```
Justification cited: "Named table is destroyed when the owning GenServer crashes; the supervisor respawns and init/1 re-creates it within milliseconds. During that window, callers MUST NOT crash."

Per CLAUDE.md "Let it crash" + "Defensive programming hides bugs" — this is the wrong shape. Three concerns:

1. **The boot ordering is the contract.** `Application.start/2` lists Backoff + NetworkCircuit BEFORE `SessionSupervisor` (application.ex:69, 78). Sessions reading the table during the supervisor-respawn window of Backoff/NetworkCircuit means the singleton itself is crashing — that's a bug to surface, not absorb. Returning `0` for `wait_ms/2` lets a backoff cycle skip its delay silently; returning `:ok` for `NetworkCircuit.check/1` lets a freshly-respawned-and-empty circuit immediately accept a probe that should have been rejected.

2. **The "respawned within milliseconds" assumption is unverified.** Both GenServers are `:permanent` under the application supervisor (default `max_restarts: 3, max_seconds: 5`). If the singleton itself enters a restart loop (e.g. a corrupt-state crash inside `handle_cast`), the table is missing for SECONDS not millis, and every concurrent admission decision degrades silently to "allow" instead of failing loud.

3. **Rescue-driven-default IS the bug class B1 was trying to fix.** Symmetry: B1 said "don't drop verbs silently." This says "drop the gating decision silently when ETS is missing."

**Recommended fix:** Either:
- (a) Remove the rescue. Let the caller's GenServer crash — the supervisor respawns it, Backoff respawns it, no-harm-no-foul. Each session's own restart already increments Backoff (which by then will be back up).
- (b) Convert to a tagged return — `wait_ms/2` returns `{:ok, n} | {:error, :table_unavailable}`, callers explicitly handle the table-missing branch (Session.Server can choose: delay 5s and retry, or stop with `:backoff_unavailable` so the supervisor takes over).

The current shape says "we know this can happen, here's a silent default that papers it over" — exactly what no-silent-drops is supposed to eliminate.

### [HIGH] `Backoff.record_failure` cast races with supervisor restart — count may not be incremented before the next session reads `wait_ms/2`
**File(s):** `lib/grappa/session/server.ex:1217-1221` + `lib/grappa/session/backoff.ex:159-162` + `lib/grappa/session/server.ex:556-570`
**Description:** Sequence:
1. Client crashes; Server's `handle_info({:EXIT, ...})` fires
2. `Backoff.record_failure(...)` is called — this is a `GenServer.cast/2` (asynchronous; goes into Backoff's mailbox)
3. Server returns `{:stop, {:client_exit, reason}, state}`
4. DynamicSupervisor (`max_restarts: 10_000`, very generous) restarts the Server immediately
5. New Server's `init/1` returns `{:ok, state, {:continue, {:start_client, _}}}`
6. New Server's `handle_continue` runs, calls `Backoff.wait_ms(...)` — direct ETS lookup

If step 2's cast hasn't been processed by the Backoff GenServer between steps 2 and 6, the new session reads the OLD count. Backoff's mailbox isn't empty (this cast is in it), but the new Server doesn't await it. In practice the Backoff GenServer is idle and processes the cast in microseconds — but under load (many sessions crashing simultaneously, or a slow Backoff if Phase-5 telemetry is added), the race window opens. The Server's own comment at server.ex:1208-1209 acknowledges this: "the GenServer.cast doesn't block this stop, but the Backoff GenServer's mailbox processes it before our respawned init/1 re-reads wait_ms/2 (the supervisor's restart path is not instant — it runs after this terminate completes)." That assertion is unproven; the mailbox-FIFO guarantee doesn't apply across the (unrelated) supervisor pid.

**Recommended fix:** Convert `record_failure` to `GenServer.call/2` (synchronous). The Server is exiting; one extra synchronous round-trip in `handle_info` is fine. Alternatively, do the ETS write directly from the caller (Backoff exposes the table as `:public` — the read-modify-write is the only thing that needs serialization, and crash-on-failure is already the protective semantic). Easiest path: keep the cast but add a `GenServer.call(Backoff, :flush)` no-op message before exit to force mailbox drain.

### [HIGH] `terminate/2` `try ... catch :exit, _` is broader than necessary; same pattern as 2026-05-12 S11 carryover
**File(s):** `lib/grappa/session/server.ex:613-628`
**Description:** Carryover from previous review (S11 in drafts-2026-05-12/agent-lifecycle.md): `catch :exit, _` swallows EVERY exit reason — including a future `Client.send_quit/2` arity bug, an undefined function (typo refactor), or a programming error in any function the Client.send_quit path transitively calls. Per CLAUDE.md "Let it crash" — defensive try/catch should match specific shapes. The shape here is wide-open, masking arity-change bugs at the WORST possible moment (shutdown, when nobody is reading logs).

Still applies; not addressed in B0..B4. Cluster's "no-silent-drops" theme makes this a doubly-worth fix.

**Recommended fix:** Match the documented benign shapes (and only those):
```elixir
catch
  :exit, {:noproc, _} -> :ok       # client already dead
  :exit, {:timeout, _} -> :ok      # call timeout during shutdown
  :exit, :normal -> :ok
  :exit, :shutdown -> :ok
  :exit, {:shutdown, _} -> :ok
end
```
Anything else (e.g. `{:badarg, _}` from a future Client API bug) crashes — surfacing the bug at deploy time when a `--force-cold` exposes the new shape. Today's shape would silently absorb it.

---

## MED

### [MED] `apply_effects [{:join_failed, ...} | _]` partial-effect leakage carryover (2026-05-12 S8)
**File(s):** `lib/grappa/session/server.ex:2079-2130`
**Description:** Carryover from S8 — partly addressed: the persist-fail branch now logs at error level + does NOT broadcast the `:message` event (so cic doesn't see a "you were rejected" without a backing scrollback row). HOWEVER the broadcast of `SessionWire.join_failed/4` STILL fires unconditionally below the persist case (line 2118), AND the `WindowState.set_failed/4` mutation STILL applies (line 2126). So the failure mode is now: scrollback row missing (changeset error) + state machine flipped to `:failed` + cic shows the failure banner + scrollback shows nothing. On reconnect, cic loads scrollback → empty → user sees "I was rejected from #foo" UI but cannot find the reason in scrollback.

Less bad than originally (no double-rendering of the message), but still atomicity-violating.

**Recommended fix:** Treat persist failure as a hard fail of the entire effect — log error, skip both broadcasts, skip state mutation. The `WindowState.set_failed/4` is the "soft" record that survives the next snapshot push; without it, reconnect cleanly fetches whatever state the server actually has.

### [MED] `WSPresence.notify_sessions/2` uses Phoenix.PubSub for local fan-out (2026-05-12 S13 carryover)
**File(s):** `lib/grappa/ws_presence.ex:326-339`
**Description:** Carryover from S13. WSPresence broadcasts `:ws_connected` / `:ws_all_disconnected` via `Phoenix.PubSub.broadcast/3` — but the consumers are sibling `Session.Server`s on the same node. PubSub is overkill (cross-node delivery isn't needed in single-node deployments) and adds a crash dependency: a transient PubSub bounce that crashes WSPresence (which IS `:permanent`) restarts it with empty state, every session sees `:ws_all_disconnected` after the 30s debounce — every user goes auto-away en-masse on a PubSub blip.

Not addressed in B0..B4.

**Recommended fix:** Switch to `Registry.dispatch/3` against `Grappa.SessionRegistry` matching the user_name slice. Local-only fan-out, no PubSub dependency, no "registry of subscribers" overhead.

### [MED] `cancel_and_drain` is a public-with-`@doc-false` function; carryover (2026-05-12 S12) + new ghost-recovery untested branch
**File(s):** `lib/grappa/session/server.ex:2446-2460`
**Description:** Same as S12 — `def cancel_and_drain` (not `defp`) marked `@doc false` for test access. Three callers internal to Server.ex: auto-away timer, pending-auth timer, ghost-recovery timer. This is the right pattern in spirit but should live in `Grappa.Session.TimerHelpers` — a sibling module that's a clean test surface AND avoids exporting a private semantic from the GenServer module. See carryover.

Add: when reading the ghost-recovery branch (`advance_ghost/2` at server.ex:1762, `:ghost_timeout` handler at 1376-1380), the cancel_and_drain call site for `:ghost_timeout` only fires on terminal phase (`:succeeded` / `:failed`). The non-terminal `step` returning `:cont` does NOT cancel or rearm the timer (server.ex:1772-1773) — meaning the original 8s timer keeps ticking from the FIRST step, even when subsequent NickServ NOTICEs / 401s reset progress. Sub-second NickServ acks should comfortably finish in 8s, but a slow-but-progressing services chain (timer stays armed at e.g. 6s remaining when phase advances) gets less budget than the architecture suggests.

**Recommended fix:** Lift `cancel_and_drain` into `Grappa.Session.TimerHelpers`. Separately, document or refactor the ghost-recovery timer behavior — either reset on phase transition (refresh the budget per step) or document that 8s is a HARD ceiling on the entire 4-step round trip, not per-step.

### [MED] `record_in_flight_join` lazy TTL sweep is O(N²) per autojoin loop (2026-05-12 S7 carryover)
**File(s):** `lib/grappa/session/server.ex:2386-2420`
**Description:** Same finding as 2026-05-12 S7. Lazy `Enum.reject + Map.new` runs per insert; autojoin of N channels → O(N²) traversals at 001. Not changed in B0..B4. For N=50 (power user), 2500 ops; for N=500 (operator with many channels), 250000 ops at boot.

**Recommended fix:** Replace lazy sweep with a single `Process.send_after/3`-driven sweep at insert time only when map size crosses a threshold, or move sweep to a dedicated `:sweep_in_flight_joins` info handler scheduled every 30s.

### [MED] `pending_auth_timeout` discards password without auditing capture origin
**File(s):** `lib/grappa/session/server.ex:1323-1326` + `lib/grappa/session/ns_interceptor.ex` + `lib/grappa/session/server.ex:1750-1757`
**Description:** When the 10s pending-auth timer fires without +r confirmation, the password is dropped silently with `Logger.debug("pending_auth discarded — +r MODE timeout")`. No telemetry, no audit row, no operator-visible signal. This means a misconfigured network where NickServ NEVER confirms +r (because the network doesn't run a NickServ, or the IDENTIFY went to /dev/null) silently consumes operator-typed passwords — visitor never gets "registered" status, retries indefinitely, leaks 1 password per IDENTIFY into the bouncer's heap (gc'd, but observable via :sys.get_state).

The "no-silent-drops" cluster's theme suggests every termination state — including timeouts — should leave a trail.

**Recommended fix:** Emit `:telemetry.execute([:grappa, :session, :pending_auth, :discarded], %{count: 1}, %{subject: state.subject_label, network_id: state.network_id})` so operator dashboards can detect the misconfiguration. Optionally surface to cic via a typed `auth_timeout` event on the user topic so the user knows "your IDENTIFY didn't get confirmed; check your password."

### [MED] `Bootstrap.spawn_one/2` + `Bootstrap.spawn_visitor/2` are near-twins; carryover S22 partly addressed via SpawnOrchestrator but the visitor path still nests case-of-case
**File(s):** `lib/grappa/bootstrap.ex:235-317`
**Description:** S22 carryover. `spawn_visitor/2` does:
```
case VisitorSessionPlan.resolve(visitor) do
  {:ok, plan} ->
    case Networks.get_network_by_slug(plan.network_slug) do
      {:ok, %Network{id: id}} -> spawn_with_admission(...)
      {:error, reason} -> Logger.error(...) + acc.failed+1
    end
  {:error, reason} -> Logger.error(...) + acc.failed+1
end
```
Two error branches with identical shapes. Refactorable to `with`:
```elixir
with {:ok, plan} <- VisitorSessionPlan.resolve(visitor),
     {:ok, %Network{id: id}} <- Networks.get_network_by_slug(plan.network_slug) do
  spawn_with_admission({:visitor, visitor.id}, id, plan, capacity_input, log_keys, acc)
else
  {:error, reason} ->
    Logger.error("visitor session start failed", visitor_id: visitor_id, network: slug, error: inspect(reason))
    %{acc | failed: acc.failed + 1}
end
```
Half the indent, single error log shape, identical semantics.

### [MED] `Visitors.Reaper` `Logger.info` only fires on non-zero sweeps; zero-sweeps are silent (anti-pattern relative to no-silent-drops)
**File(s):** `lib/grappa/visitors/reaper.ex:90-100`
**Description:** "Sweeps that delete zero rows stay quiet (no log line)" per moduledoc. This is a deliberate noise-reduction choice — but it means an operator wondering "is the reaper running?" has no signal until something gets deleted. There's no `:telemetry` emission for either branch (`:tick` or `:sweep`). The 60s cadence makes liveness observability via logs unreliable.

For a `:permanent` GenServer that's literally responsible for cleanup of the per-(client, network) cap lifecycle (a security-adjacent concern — visitor expiration), liveness signal matters.

**Recommended fix:** Emit `:telemetry.execute([:grappa, :visitors, :reaper, :swept], %{count: n}, %{})` on EVERY tick (even zero). Keep the conditional `Logger.info` for non-zero. The telemetry fires per-tick at zero-cost and gives Phase 5 PromEx a "reaper is alive + sweep rate" gauge.

### [MED] `Backoff.failure_count/2` is `@doc false` but consumed at server.ex:564 (carryover 2026-05-12 S6)
**File(s):** `lib/grappa/session/backoff.ex:191-202` + `lib/grappa/session/server.ex:564`
**Description:** Same finding as previous review S6. Function still `@doc false`, still consumed by Server's Logger metadata. Drift risk unchanged.

**Recommended fix:** Same as S6 — promote to public OR fold the count into the `wait_ms/2` return shape: `{ms, count}`.

---

## LOW

### [LOW] `Application.start/2` calls `Grappa.Admission.Config.boot/0` BEFORE the supervisor — any `raise ArgumentError` in `validate_non_disabled!/3` aborts node boot with a stack trace, not an operator-friendly message
**File(s):** `lib/grappa/application.ex:21-27` + `lib/grappa/admission/config.ex:80-119`
**Description:** Operator misconfigures `:captcha_secret` at deploy → boot crashes with `(ArgumentError) captcha_secret required when provider is Grappa.Admission.Captcha.Turnstile` and a fat stack trace from `Application.start/2`. Operator sees the BEAM exit; `scripts/deploy.sh` healthcheck fails; not obvious it was a config typo.

**Recommended fix:** Catch the `ArgumentError` at `Application.start/2` and log with operator-friendly context: `Logger.error("admission config invalid — refusing to boot. Set CAPTCHA_SECRET in env or change CAPTCHA_PROVIDER. See compose.yaml.")` then `{:error, {:bad_config, msg}}` so the supervisor never starts. Same crash, but the operator-facing surface is the configuration item, not the BEAM trace.

### [LOW] `Visitors.Reaper.sweep/0` returns `{:ok, length(expired)}` — where "length(expired)" is enumerated NOT deleted
**File(s):** `lib/grappa/visitors/reaper.ex:62-80`
**Description:** Comment acknowledges this: "per-row delete failures still count toward the total because the enumeration is the contract." But this means `:tick` logs `affected: n` where `n` is "rows we tried to delete" not "rows we successfully deleted." Operator counting deletions sees inflated numbers under any DB pressure (FK constraint failures, sqlite busy retries).

**Recommended fix:** Track success/failure split:
```elixir
{ok, fail} = Enum.reduce(expired, {0, 0}, fn v, {o, f} ->
  case Visitors.delete(v.id) do
    :ok -> {o + 1, f}
    {:error, _} -> {o, f + 1}
  end
end)
{:ok, %{ok: ok, failed: fail}}
```
And log `affected: ok, failed: fail`. Honest counters.

### [LOW] `Session.Server.delegate/2` recursion depth — `apply_effects/2` recurses linearly through the effect list AND calls `EventRouter.route/2` from within Server (if the effect is `:reply` and triggers a downstream wire reply)
**File(s):** `lib/grappa/session/server.ex:1885-1891` + `lib/grappa/session/server.ex:2280-2283`
**Description:** Not a current bug. `apply_effects` for `:reply` calls `Client.send_line/2` (a `cast` to the linked Client) — no recursion back into Server. But the pattern of "effect produces wire write produces upstream message produces inbound `{:irc, msg}` produces another `delegate/2`" is a one-message-cycle pattern that's fine today; if a future effect type triggers a synchronous `Server.handle_call` from inside `apply_effects` it would deadlock (Server calling itself via the GenServer mailbox).

**Recommended fix:** Document in `apply_effects/2`'s `@doc` that effects MUST NOT call back into Server synchronously; only async sends to other processes. Trip-wire test: a property test that `apply_effects/2` never calls `GenServer.call(self(), _)`.

### [LOW] `WSPresence.client_closing/2` does NOT demonitor the pid — relies on the subsequent `:DOWN` to clean up `refs_to_user`
**File(s):** `lib/grappa/ws_presence.ex:259-273`
**Description:** When `client_closing/2` fires on the last socket, it removes the pid from `state.sockets` immediately + emits `:ws_all_disconnected`. The monitor reference in `state.refs_to_user` is left untouched — relies on the actual pid `:DOWN` arriving to be cleaned up. If the cic tab uses `pagehide` to send `client_closing` but the underlying socket pid stays alive (e.g. "hidden but not destroyed" on a phone backgrounded), the ref stays in the map indefinitely.

In practice the WS pid dies seconds after `pagehide` because cic terminates the channel cleanly, so this is almost-always fine. But under long-lived hidden tabs (Safari's "back-forward cache" behavior) the leak is real, bounded only by the next page reload.

**Recommended fix:** Demonitor in `client_closing/2`:
```elixir
ref = state.refs_to_user
      |> Enum.find(fn {_, name} -> name == user_name end)
      |> elem(0)
Process.demonitor(ref, [:flush])
state = %{state | refs_to_user: Map.delete(state.refs_to_user, ref)}
```
(Need to track ref-by-pid too — current map is ref→user, missing pid→ref.) Or accept the leak as bounded and document it.

### [LOW] `Bootstrap.validate_visitor_networks!/1` AND `validate_credential_servers!/2` run AFTER `Networks.list_credentials_for_all_users/0` — they CANNOT report misconfigurations that prevent the credential list from loading at all
**File(s):** `lib/grappa/bootstrap.ex:186-210`
**Description:** If `Credentials.list_credentials_for_all_users/0` itself raises (e.g. corrupt sqlite WAL, schema migration mismatch), Bootstrap's `:transient` Task crashes BEFORE the validators run. The supervisor restarts the task `max_restarts: 3` times and gives up — the operator sees a Task crash trace, not the validator's friendly "run mix grappa.add_server" hint. The validators are "honest signal" only when the basic DB query succeeds.

**Recommended fix:** Wrap the queries with rescue + operator-friendly error:
```elixir
def run do
  credentials = try_list_credentials()
  visitors = try_list_visitors()
  ...
end

defp try_list_credentials do
  Credentials.list_credentials_for_all_users()
rescue
  e ->
    raise RuntimeError, "failed to load credentials at boot: #{Exception.message(e)}. \
                         Check sqlite integrity (`scripts/db.sh PRAGMA integrity_check`) \
                         and that migrations are up to date (scripts/mix.sh ecto.migrate)."
end
```
Same shape as the existing W7 / servers-bound invariants — failure leads to operator action, not a stack trace.

---

## NIT

### [NIT] `Backoff.compute_wait/1` uses `:rand.uniform/1` for jitter — non-determinism makes tests assert ranges instead of values
**File(s):** `lib/grappa/session/backoff.ex:240-250`
**Description:** Test config sets `base_ms` to a few ms so jitter ±25% is meaningful. Tests against `wait_ms/2` either need `assert ms in low..high` or assert an exact distribution shape — both noisier than asserting an exact value. Fine for production (jitter avoids herd respawn) but would benefit from a test seam.

**Recommended fix:** Module attribute `@jitter_pct` is already there; add `compute_wait_no_jitter/1` for tests, OR a `Application.compile_env(:grappa, [:session_backoff, :jitter_pct], 25)` so test config can set jitter to 0.

### [NIT] `WindowState.to_wire/3` returns `{:error, :not_tracked}` for `:pending` AND `:parked` AND unknown — three distinct states collapsed into one tag
**File(s):** `lib/grappa/session/window_state.ex:267-291`
**Description:** Caller can't distinguish "channel never tracked" from "channel pending join" from "channel parked." The current `_ -> {:error, :not_tracked}` arm conflates them. Cic's snapshot path doesn't care today, but a future REST `GET /windows/:channel` consumer might.

**Recommended fix:** Three distinct error tags: `{:error, :pending}`, `{:error, :parked}`, `{:error, :not_tracked}`. Cic's snapshot path can keep collapsing if that's appropriate; REST callers gain the discrimination.

---

## Trajectory Risks

The cluster's stated trajectory after B5/B6 is push notifications → image upload → voice → mobile UI polish → PUBLIC OPEN. Each phase amplifies the risk surface of the lifecycle layer:

1. **Push notifications.** Will need to consume `Mentions.aggregate_mentions/6`'s output — currently triggered only on `unset_away_internal/2` (server.ex:2588). If push wants real-time delivery (not "on away unset"), the trigger surface widens. Today's `:visitor_committer` opaque-callback pattern works because there's exactly one consumer; adding a `:push_notifier` callback for every Session.Server creates a third opaque callback (visitor_committer + credential_failer + last_joined_persister + push_notifier). That's the line at which a `Session.Server.callbacks :: %{}` typed bundle starts looking better than ad-hoc fields. **Recommendation:** consolidate the four callbacks into a `start_opts.callbacks` map BEFORE adding the fourth.

2. **Image upload.** External HTTP calls (litterbox upload from cicchetto). Lifecycle impact: only if the bouncer ever proxies the upload itself (it shouldn't per `project_image_upload`). If it does, that's a new long-running synchronous path inside Session.Server — incompatible with the current `init/1` non-blocking discipline.

3. **Voice / mobile UI polish.** Pure cic concerns; no lifecycle exposure expected.

4. **PUBLIC OPEN.** This is the killer trajectory. Today's per-client cap defaults to 1; admission rejections are surfaced via FallbackController's HTTP 429-shape envelopes. PUBLIC OPEN means random unauthenticated humans hitting the captcha + the network-circuit breaker. Three risks:
   - The `NetworkCircuit` cooldown jitter (±25%) means after N=5 simultaneous failures, the bouncer rejects everyone for a randomized 4-6 minute window. A bot scanning the visitor login endpoint can trigger this for legitimate users — DOS-by-circuit-breaker-trip. **Recommendation:** Pre-PUBLIC-OPEN, add per-IP rate limiting at the Endpoint layer so the circuit breaker only sees per-network-aggregate failures from real distinct IPs, not bot-generated noise from one IP.
   - The `Bootstrap.spawn_all/1` serial path (S5 carryover) becomes operator-visible: if the bouncer accumulates many credentials post-launch, every restart is O(N) on Bootstrap. **Recommendation:** Parallelize before launch.
   - The `Backoff` ETS table is unbounded across `(subject, network_id)` keys — every visitor's failed-connect leaves an entry, never garbage-collected unless the visitor reconnects successfully (which clears via `record_success`). After 24h of public traffic the table could have 10k+ stale entries. **Recommendation:** Add a periodic sweep (analogous to `Visitors.Reaper`) for entries older than the cap_ms duration.

5. **Cluster discipline note for B5/B6.** The 2026-05-12 review's CRIT count was 0 with 5 HIGH; this review is CRIT=1, HIGH=6. Two new HIGHs are direct consequences of the B1 EventRouter change (CRIT-1 + HIGH-1). One HIGH is the standing memory's known-but-unfixed ETS leak. Pattern: cluster-shipping landed B1's PRIMARY fix but the SECONDARY surfaces (AUTHENTICATE leak, empty-trailing drop) didn't get scoped. Per `feedback_landed_claim_evidence`, the cluster's "no-silent-drops" thesis is incompletely realized. Fix CRIT-1 + HIGH-1 in a follow-up commit BEFORE B5 lands; the others are review-paste-able into the cluster's followup queue.
