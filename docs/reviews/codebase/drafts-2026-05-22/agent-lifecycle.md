# Lifecycle scope — 13 findings (0 CRIT, 4 HIGH, 6 MED, 3 LOW)

## HIGH

### S1. `Backoff.record_failure` is NOT called from `terminate/2` — only from one specific `handle_info` path
**File:** `lib/grappa/session/server.ex:1378-1382`
**Category:** crash-boundary alignment / restart-strategy correctness
**Severity:** HIGH

`Grappa.Session.Backoff`'s moduledoc (`lib/grappa/session/backoff.ex:30-31`) states:

> `record_failure/2` — bumps the count; called from `Session.Server.terminate/2` on any non-`:normal` exit.

The doc is wrong. `record_failure` is called ONLY from `handle_info({:EXIT, client_pid, reason}, %{client: client_pid} = state)` when `reason != :normal and reason != :shutdown` — i.e. *only* when the linked `IRC.Client` crashes. `terminate/2` itself never calls `Backoff.record_failure`.

Concrete failure path this opens:

  * `Session.Server.handle_info` clause raises on a malformed message (or any future handler bug)
  * `terminate/2` runs with `reason = {%RuntimeError{...}, stack}` — falls into the second `def terminate(_, state)` clause (line 687) which only emits lifecycle telemetry and returns `:ok`. No backoff bump.
  * `DynamicSupervisor`'s `:transient` policy restarts. New `init/1` reads `wait_ms = 0`. Immediate respawn.
  * The same bug fires again on the same message class. Tight loop until `max_restarts: 10_000 / 60s` blows the budget — at which point `SessionSupervisor` exits, killing every OTHER session in the bouncer (CLAUDE.md "Crash boundary alignment").

Also affected: `init/1` rejecting opts via `{:stop, reason}` (Client crash inside `do_start_client/2` with `{:error, reason}` does record_failure first — fine — but ANY future `init/1` bail-out path will not).

**Fix:** Move the `Backoff.record_failure` call into `terminate/2` on the abnormal-reason clause (matched alongside the `:shutdown` lifecycle emit), OR add an explicit `try` around the `do_start_client` path and rely on `terminate/2` for the EXIT-from-Client-crash classification. Update the moduledoc + the rationale comment at server.ex:1362-1369 to match whichever invariant lands.

---

### S2. Bare `:ok = Client.send_*` matches in 8+ Session.Server handlers crash the session on a dead socket
**File:** `lib/grappa/session/server.ex:1016, 2537, 2846, 2912, 2921, 2941, 2947, 1949`
**Category:** crash-boundary alignment / no-silent-swallow inverse
**Severity:** HIGH

The U-cluster cleanup (2026-05-17, comment at lines 651-660) hardened `IRC.Client.handle_call({:send, _}, _, _)` to return `{:error, :no_socket | :closed | _}` instead of raising on a dead socket — and added `feedback_no_silent_drops_closed` to forbid swallowing the tagged error.

Most `Session.Server` send paths comply (`send_privmsg`, `send_topic`, `send_nick`, `send_quit`, `send_kick`, etc. all `case`-match the return). BUT the following still use bare `:ok =`:

  * `handle_call({:send_mode, target, modes, params}, _, state)` (line 1016) — raw /mode escape hatch
  * `defp send_chunked_mode/4` (line 2846) — every chunked verb (/op /deop /voice /devoice /ban /unban) flows through here
  * `apply_effects([{:reply, line} | rest], state)` (line 2537) — CTCP VERSION replies (and any future `:reply` effect)
  * `set_explicit_away_internal/3` (line 2906 + 2912) and `set_auto_away_internal/1` (line 2921) and `unset_away_internal/2` (line 2941 + 2947) — all four AWAY paths
  * `flush_lines/2` (line 1949) — GhostRecovery emitted lines

Concrete failure: operator types `/op alice` on a session whose upstream just closed. `Client.send_line` returns `{:error, :closed}`. `:ok = ...` raises `MatchError`. `Session.Server` crashes with `{:badmatch, _}` reason. Bumps Backoff. Supervisor restarts. The operator's UI message disappears with no feedback; reconnect ladder starts.

This is the CRASH side of the same coin the IRC.Client fix closed for `Session.Server.terminate/2`. The contract `Client.send_*` callers MUST honor is `send_result :: :ok | {:error, ...}` — bare-matching narrows it incorrectly.

**Fix:** Replace every `:ok = Client.send_*` with a `case`-match that returns `{:reply, {:error, reason}, state}` or `{:noreply, state}` (with a `Logger.warning` for the diagnostic path). Mirror the `send_privmsg` shape at server.ex:1849-1859 exactly.

---

### S3. `Bootstrap.spawn_with_admission` `case` lacks a catch-all and is not coupled to `Admission.capacity_error_atoms()`
**File:** `lib/grappa/bootstrap.ex:380-435`
**Category:** silent-failure / type-shape drift
**Severity:** HIGH

`Admission` defines `@capacity_error_atoms` as a runtime canary list (`lib/grappa/admission.ex:83-88`) explicitly for the FC exhaustiveness test, and documents:

> Both MUST move in lockstep — adding a tag to one without the other surfaces as a missing test case or a missing dialyzer pattern.

But Bootstrap's case in `spawn_with_admission/6` (the OTHER consumer of `Admission.capacity_error/0`) does NOT reference `capacity_error_atoms()`. It hard-codes the four shapes — `:visitor_cap_exceeded`, `:user_cap_exceeded`, `:client_cap_exceeded`, `{:network_circuit_open, _}` — with no fallback clause.

Concrete failure path: a future cluster adds (say) `:identity_tier_locked` to `Admission.capacity_error()`. Test suite + FallbackController catch the gap. Bootstrap doesn't — the case raises `FunctionClauseError` on the unmatched tag. Bootstrap is `:transient`; the supervisor restarts up to 3× in 5s then exits the application. Every credential row is left unspawned and the bouncer crash-loops on boot.

The catch-all could be a `{:error, other}` arm with `Logger.error("bootstrap: unknown admission error", error: inspect(other))` and `acc` increment of `network_failed`. Same response as `{:start_failed, _}` semantically. Better still: make the test canary list authoritative — `for tag <- Admission.capacity_error_atoms(), do: ...` style — so the test suite refuses to compile if Bootstrap drifts.

**Fix:** Add `{:error, other} -> ...` catch-all in `spawn_with_admission/6` with explicit `Logger.error` + counter bump; OR refactor to consume `Admission.capacity_error_atoms()` so the test canary catches missing arms.

---

### S4. Bootstrap's web-only log forces visibility of `parked + failed` only — silently ignores other states
**File:** `lib/grappa/bootstrap.ex:232-245`
**Category:** log-honesty / closed-set drift
**Severity:** HIGH

`log_web_only_warning` says:

```elixir
"bootstrap: 0 credentials in :connected state " <>
  "(#{counts.parked} parked, #{counts.failed} failed) — running web-only. "
```

`Credential.connection_states/0` is currently `[:connected, :parked, :failed]` (`lib/grappa/networks/credential.ex:62`), so this works. But the log line hard-codes `counts.parked` + `counts.failed` — if a future cluster adds a fourth state (e.g. `:archived`, `:identity_lockout`), the total will be > 0 with parked + failed = 0, and the line will lie. The CLAUDE.md log-honesty rule (Bootstrap pre-T-4 lying about "no credentials bound") is the exact origin of this code.

This is the SAME class of bug as S3 — closed-set enumeration that doesn't iterate over the canonical list.

**Fix:** Render every state with non-zero count: `counts |> Enum.reject(fn {s, n} -> s == :connected or n == 0 end) |> Enum.map_join(", ", fn {s, n} -> "#{n} #{s}" end)`. Removes the drift risk and stays honest under closed-set growth.

---

## MEDIUM

### S5. `Operator.reset_circuit/2` uses `:sys.get_state` to drain a cast — couples Operator to NetworkCircuit internals
**File:** `lib/grappa/operator.ex:269`
**Category:** abstraction leak / `:sys` abuse
**Severity:** MEDIUM

```elixir
:ok = NetworkCircuit.reset(network_id)
# Drain the cast through the NetworkCircuit mailbox so the
# post-reset ETS snapshot reflects the operator verb.
_ = :sys.get_state(NetworkCircuit)
post = Enum.find(NetworkCircuit.entries(), &match?({^network_id, _, _, _, _}, &1))
```

`:sys.get_state/1` is a debug primitive (CLAUDE.md "Use infrastructure, don't bypass it"). It works here because it flushes the mailbox, but it couples Operator to NetworkCircuit's GenServer-backed-by-ETS shape — a future refactor to a Registry / persistent_term / different process would silently break this drain (and the operator would see stale post-reset entries with no error).

**Fix:** Expose `NetworkCircuit.reset_sync/1` (or have `reset/1` itself be a synchronous `call` — the existing `:operator_reset` telemetry is once-per-invocation regardless of cast-vs-call, so the choice is purely about delivery semantics). Operator then calls the public verb without touching `:sys`.

---

### S6. `Session.Server.handle_info({:EXIT, ...})` clean-Client clause is unreachable today but inverts to silent restart if Client gains a self-stop path
**File:** `lib/grappa/session/server.ex:1398-1411`
**Category:** evolution risk / restart-strategy correctness
**Severity:** MEDIUM

The clean-exit clause for `{:EXIT, client_pid, :normal | :shutdown}` (line 1398-1401) returns `{:stop, :normal, state}` — correctly preventing `:transient` respawn. The comment (lines 1386-1397) acknowledges this is unreachable in production today (`Client` has no `self-stop` path; supervisor `:shutdown` of the parent bypasses).

The risk is that the third catch-all clause at line 1408-1411 silently propagates `:shutdown | :normal` from a non-Client linked process:

```elixir
def handle_info({:EXIT, _, reason}, state)
    when reason == :shutdown or reason == :normal do
  {:stop, reason, state}
end
```

Comment says this is "currently unreachable in production (Client is the only linked spawn per init/1)" — but the comment is the only defense. There is NO guard against a future call site that linkages a Task or sibling process from a Session.Server handler. The risk class is real (CLAUDE.md "Crash boundary alignment").

**Fix:** Either (a) `raise` in the third clause to make any future linked spawn surface immediately, OR (b) add a `Boundary` annotation or compile-time check that `Process.link/1` and `Task.start_link/1` are not called from `Session.Server`. Lightweight option: pattern-match `client_pid` exhaustively in the first two clauses and remove the catch-all.

---

### S7. `cancel_and_drain/2` only drains one queued message — assumes timer-per-slot serialization
**File:** `lib/grappa/session/server.ex:2799-2811`
**Category:** subtle race
**Severity:** MEDIUM

```elixir
def cancel_and_drain(ref, msg) when is_reference(ref) and is_atom(msg) do
  case Process.cancel_timer(ref) do
    ms_left when is_integer(ms_left) -> :ok
    false ->
      receive do
        ^msg -> :ok
      after
        0 -> :ok
      end
  end
end
```

The `receive ... after 0` drains AT MOST ONE message of the matching atom. The three call sites (`:auto_away_debounce_fire`, `:pending_auth_timeout`, `:ghost_timeout`) each maintain a single-slot timer ref on Session.Server state and the surrounding code keeps invariant "at most one stale message of each kind in the mailbox at a time" — but the invariant is only as strong as the code that enforces it. The pattern documented at 1335-1348 (`ws_all_disconnected`'s "two rapid disconnects ~30s apart") relies on each disconnect path calling `cancel_and_drain` BEFORE arming a fresh timer. If a future handler arms a timer without first canceling, two `:auto_away_debounce_fire` can queue; `cancel_and_drain` would drain only one.

Not a known bug today — the three slots are well-disciplined. But this is the kind of invariant CLAUDE.md asks plans to enforce structurally, not by convention. A `while` / recursive drain (`while message present in mailbox` loop) would be O(N-queued) and zero-cost when N == 0, removing the invariant from the surface.

**Fix:** Loop the receive: `defp drain_all(msg) do receive do ^msg -> drain_all(msg) after 0 -> :ok end end`. Constant overhead, no correctness obligation on call sites.

---

### S8. `Visitors.Reaper` schedules next `:tick` AFTER `sweep/0` completes — not on a strict 60s wall clock
**File:** `lib/grappa/visitors/reaper.ex:109-129`
**Category:** architecture smell
**Severity:** MEDIUM

```elixir
def handle_info(:tick, state) do
  {:ok, n} = sweep()
  ...
  schedule_tick(state.interval_ms)
end
```

`schedule_tick` fires only after `sweep/0` returns. With N expired visitors each requiring a `Visitors.delete/1` (which CASCADEs across `messages`, `accounts_sessions`, `query_windows`, `push_subscriptions`, `user_settings`, `read_cursors`, `visitor_channels`) the sweep could realistically take several seconds under load. Cadence drifts to "every 60s + sweep_duration". A backlog amplifies the skew.

This matches the same anti-pattern documented for `Push.Sender` rate-limit elsewhere. The fix is `Process.send_after(self(), :tick, max(0, interval - sweep_duration_ms))` OR a monotonic-clock-based "next tick at" calculation. The Reaper is not on the hot path so the bug isn't user-visible today — but a misbehaving Cloak / a slow disk can amplify it silently.

**Fix:** Either compute next-tick relative to monotonic time + interval, OR schedule the tick at the START of the handler (before `sweep`) so sweep duration consumes within the interval rather than extending it.

---

### S9. `Application.start/2` reads `Application.get_env(:grappa, :start_bootstrap)` and `:attach_admin_telemetry` at runtime — distinct boot-time boundary documents differently
**File:** `lib/grappa/application.ex:169, 194`
**Category:** consistency
**Severity:** MEDIUM

Both calls happen inside `start/2` — that's the documented boot-time boundary. Fine. But the CLAUDE.md rule (`config_as_ipc` ban) is enforced via the `Admission.Config.boot/0` + `:persistent_term` pattern that the rest of the codebase uses. `bootstrap_child/0` and `attach_admin_telemetry?/0` instead do a direct `Application.get_env/3` per call.

This is fine because both functions are ONLY called during `start/2` (no runtime read). But the precedent is inconsistent: `Grappa.Admission.Config` exists as a designated boundary module; `Grappa.Bootstrap.Config` (or similar) does not. The day someone calls `Application.get_env(:grappa, :start_bootstrap)` from a controller or test helper, the ban is silently violated and no one catches it because there's no `:persistent_term` chokepoint to surface "this was supposed to be boot-only."

**Fix:** Either (a) move `:start_bootstrap` and `:attach_admin_telemetry` into the `Grappa.Admission.Config`-style persistent_term setup so all runtime config flows through one designated module, OR (b) explicit `@compile {:no_warn_undefined, ...}` + a comment marking these two reads as boot-time exceptions equivalent to Admission.Config.

---

### S10. `Operator.disconnect_session` emits `:session_disconnected` even when the credential was already `:parked`/`:failed`
**File:** `lib/grappa/operator.ex:335-340, 391-397`
**Category:** event-emission honesty
**Severity:** MEDIUM

The `with` chain at line 335-340 calls `disconnect_user_session` and emits `:session_disconnected` on `:ok`. But `disconnect_user_session` returns `:ok` on the `:parked | :failed` branch (line 391-398) — where nothing was actually disconnected because there was no live session to disconnect from.

The admin events ring buffer (M-11) will show "the operator disconnected this session" when in fact the session was already parked by prior action (T32 disconnect, k-line). Operator dashboard cannot distinguish "I clicked Disconnect and it took effect" from "I clicked Disconnect on an already-dead session."

Symmetric anti-pattern to the visitor-disconnect branch (line 361-363) which DOES gate on `Session.whereis/2` before emitting — that's the right shape.

**Fix:** Gate the `emit_session_disconnected` call on the actual `:connected → :parked` transition having occurred — return `{:ok, :transitioned} | {:ok, :noop}` from `disconnect_user_session`, emit only on `:transitioned`. Or check `Session.whereis/2` first (matches the visitor branch pattern).

---

## LOW

### S11. `Grappa.Version.current/0` reads `mix.exs` from disk on every call
**File:** `lib/grappa/version.ex:33-38`
**Category:** informational
**Severity:** LOW

Documented intentional design (defeats `Phoenix.CodeReloader` staleness of `Application.spec(:grappa, :vsn)`). The file is page-cached so the cost is sub-microsecond per call — but every CTCP VERSION reply (`Grappa.Session.EventRouter`'s 297) and every release-info endpoint hits the disk lookup. A busy bouncer servicing 100 CTCP VERSIONs/sec hits the syscall 100 times.

Cache strategy options: (a) `:persistent_term`-cached at `Application.start/2` with explicit invalidation on `cic-bundle-changed` or admin reload; (b) read once per minute via a small process. Both would also defeat hot-reload staleness once paired with the reload broadcast already in place.

**Fix:** Optional — cache via `:persistent_term`, invalidate on `POST /admin/reload`. Current shape is documented and correct; only optimize if profiling shows mix.exs reads in the hot path.

---

### S12. `Session.Server.client_opts/1` builds Client opts inline — duplicated shape between `start_opts/0` typespec and the runtime map
**File:** `lib/grappa/session/server.ex:1960-1973`
**Category:** typed-shape drift
**Severity:** LOW

The `client_opts/1` function constructs a new map from `init_opts()` for `IRC.Client.start_link/1`. The shape mirrors `Client.opts()` but the mapping is hand-rolled. Adding a field to `Client.opts()` (say a new `:reconnect_policy` for Phase 5) requires adding to BOTH the Client typespec AND this builder. No compile-time enforcement that the two stay in sync — same class of bug the FC exhaustiveness test catches for `Admission.capacity_error_atoms()`.

**Fix:** Optional — for Phase 5 reconnect policy, consider exposing `IRC.Client.opts_from_session_plan/1` so the builder lives next to the typespec.

---

### S13. `WSPresence.notify_sessions/2` broadcasts to a topic shape that's documented as user-rooted but currently fanned out via `Topic.ws_presence`
**File:** `lib/grappa/ws_presence.ex:327-339`
**Category:** informational / topic-naming consistency
**Severity:** LOW

`Topic.ws_presence(user_name)` is a sibling topic to `Topic.user(subject_label)`. CLAUDE.md says PubSub topics are user-rooted with the `grappa:user:{user_name}` prefix mandatory and "Single source of truth: `Grappa.PubSub.Topic`." Verify `Grappa.PubSub.Topic.ws_presence/1` honors the `grappa:user:{user_name}/ws_presence` shape (it likely does — but call it out explicitly so future readers don't introduce a sibling-prefix variant).

The wider concern: WSPresence carries a per-user map `%{user_name => MapSet.t(pid())}` keyed on `user.name`. Visitor subjects use the `"visitor:" <> visitor.id` opaque subject_label, which is the same shape. The unified registration (per the doc at lines 144-159) means the map mixes user_names and visitor:UUIDs as keys — that's fine, but the function names (`register/2`, `ws_count/1`, etc.) take a `String.t() user_name` parameter shape that lies about its accepted set. Type-shape rename `subject_label` (matches the broader codebase convention) would document the constraint.

**Fix:** Optional — rename `user_name` parameter → `subject_label` in WSPresence public API, OR document that the parameter accepts both user_name and `"visitor:<uuid>"` strings.

---

## Notes

* The `terminate/2` `try/catch` block at session/server.ex:672-683 is correctly narrow per HIGH-16 (no-silent-drops B6.8). Each caught `:exit` reason is named and documented.
* `Backoff.record_failure` cast→call flip (HIGH-15) is documented at backoff.ex:165-184; the lifecycle invariant is correct conditional on terminate/2 honoring the contract (see S1).
* `NetworkCircuit`'s observation-token + cooldown-expire dance (H6) at network_circuit.ex:289-310 is structurally sound — the match-pin on `^observed_cooled_at` correctly no-ops a stale cast.
* Supervision-tree ordering invariants in `lib/grappa/application.ex:41-158` are well-commented and consistent with CLAUDE.md.
* `SpawnOrchestrator` correctly lives as a top-level boundary (avoiding the Networks → Session → Admission → Networks cycle); the rationale at `spawn_orchestrator.ex:20-54` is sound.
* `HotReload.LongLivedModules` correctly enumerates all `:permanent`/`:transient` long-lived modules in scope (`Backoff`, `WSPresence`, `NetworkCircuit`, `AdminEvents`, `Session.Server`, `IRC.Client`, `IRC.AuthFSM`, `Visitors.Reaper`, `Uploads.Reaper`). The `Bootstrap` Task is correctly absent (no callback state).
* `Operator.terminate_session({:user, user_id}, _, actor_user_id, _)` self-protection guard at line 431-433 correctly blocks admin self-termination. Visitors fall through (visitors can never be admins by construction).
