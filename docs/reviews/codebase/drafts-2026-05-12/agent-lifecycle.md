# Codebase Review Draft — Lifecycle
**Agent:** lifecycle/
**Scope:** application + bootstrap + spawn_orchestrator + session/* + admission/* + version + cic + auth + ws_presence + log + pubsub + rate_limit + client_id + mix tasks
**Date:** 2026-05-12

## CRITICAL

_None._

## HIGH

### S1. Visitor sessions also receive `mark_failed`-shape callbacks but visitor `credential_failer` is `nil` — the only user-side credential failer assumes the credential row exists; on a visitor that is k-lined OR permanent-SASL-failed the session simply `{:stop, :normal, _}` with NO operator-visible signal
**File:** `lib/grappa/session/server.ex:1440-1448`
**Category:** lifecycle / silent-failure
The terminal-failure handler runs `if is_function(state.credential_failer, 1)`. Visitor sessions never carry one (per design: ephemeral, no `connection_state` column). Result: a visitor that gets k-lined or hits a permanent SASL failure exits `:normal`, the supervisor does NOT respawn (correct), but the visitor row stays alive in the DB with no fail signal. Next `Bootstrap` re-spawns it. Loop. The Backoff layer mitigates the rate but the visitor's `Visitors.Visitor` row is never marked / reaped. There is no operator-visible signal that "this visitor has been permanently rejected by the upstream IRC network."
**Fix:** Add a `visitor_failer` callback shape mirror-symmetric with `credential_failer`, injected by `Visitors.SessionPlan.resolve/1`, that marks the visitor row in some "failed" state (or simply reaps it). Without a visitor-side terminal-failure surface the bouncer silently retries forever after a network-level ban.

### S2. `Bootstrap.spawn_one/2` (NOT going through `SpawnOrchestrator`) lives next to `spawn_with_admission/6` (which DOES go through the orchestrator) — divergent `:user` flow paths for what should be one verb
**File:** `lib/grappa/bootstrap.ex:235-257` vs `lib/grappa/bootstrap.ex:335-378`
**Category:** verb-reuse / drift risk
`spawn_one/2` resolves the SessionPlan and calls `spawn_with_admission/6`, which in turn calls `SpawnOrchestrator.spawn/4`. So the user path goes orchestrator-mediated. But `Bootstrap.run/0` calls `validate_credential_servers!` BEFORE the spawn loop ever runs — and that validator iterates `Servers.list_servers/1` for every credential network. Then SessionPlan.resolve/1 re-fetches the same server list per row. Two passes for what should be one. The risk is mostly perf for now, but the larger lifecycle smell is: the `SpawnOrchestrator` doc says "two true callers" (Bootstrap + NetworksController) but Bootstrap's `spawn_one` is itself a private wrapper that reaches around the orchestrator's contract for plan-resolution, then back through it for spawn. If a third caller emerges, the plan-resolution-then-spawn dance gets re-implemented again.
**Fix:** Either (a) push `SessionPlan.resolve/1` into `SpawnOrchestrator` so the orchestrator is the SINGLE entry for "give me a session for this credential row," or (b) document explicitly that the orchestrator is intentionally pre-resolved-plan-only and rename `spawn` to `spawn_resolved/4` to surface the contract.

### S3. `Backoff.record_failure` racing against `:transient` respawn — Session.Server's clean `:normal/:shutdown` Client exit clause is RIGHT, but the catch-all wraps both into `{:client_exit, reason}` regardless
**File:** `lib/grappa/session/server.ex:1095-1098`
**Category:** restart strategy / supervisor signaling
The clean-exit clause wraps `:normal/:shutdown` Client EXIT into `{:client_exit, :normal}` / `{:client_exit, :shutdown}` and propagates as the stop reason. Comment says: "Wrapping :normal / :shutdown into {:client_exit, _} is intentional so the supervisor's restart strategy classification stays consistent: :transient sessions don't restart on these reasons." But that's WRONG — `:transient` restarts on **abnormal** exits, where abnormal means anything that is NOT `:normal` or `:shutdown` or `{:shutdown, _}`. `{:client_exit, :normal}` is a TUPLE, not the atom `:normal`, so it IS abnormal. The supervisor WILL respawn. Comment + behavior contradict.
**Fix:** Either return `{:stop, :normal, state}` / `{:stop, :shutdown, state}` directly when the Client exited normally (so the supervisor's `:transient` policy actually skips the restart as the comment claims), OR fix the comment to say "we DO restart on clean Client exit, but Bootstrap doesn't re-spawn so the restart loops via the supervisor's max_restarts budget instead." Either path needs the code OR the comment to change — current state misleads next reader.

### S4. `service_target?/1` — `String.ends_with?(target, "serv")` will misfire on legitimate channel/nick names containing `serv` as suffix (e.g. nick `preserv`, channel `#hubservers`)
**File:** `lib/grappa/session/server.ex:1486-1488`
**Category:** correctness / wire-only filter
The "*Serv suffix is the universal IRC services nick convention" filter (W12 — never persist NickServ password leaks) uses `String.ends_with?` against a downcased target. Channel `#hubservers` would be classified as a service target → wire-only, no scrollback row, no PubSub broadcast. Operator messages to `#hubservers` would silently vanish from scrollback. Same for any nick ending in `-serv` / `serv` (e.g. user `Conserv`, `Dataserv`).
**Fix:** Restrict to known-service-nick allowlist (`["nickserv", "chanserv", "memoserv", "operserv", "botserv", "hostserv", "helpserv"]`) — closed set, no false positives. Channel-prefixed targets (`#`, `&`, `!`, `+`) should bypass the check entirely (services are always nicks).

### S5. `Bootstrap.spawn_all/1` is sequential `Enum.reduce` — one slow `SpawnOrchestrator.spawn/4` (e.g. NetworkCircuit GenServer call jam) blocks the rest of the boot sequence
**File:** `lib/grappa/bootstrap.ex:222-233`
**Category:** boot performance / serialized-spawn
The `init/1`-non-blocking change (CP10) means each individual `Session.Server.init/1` returns fast. But `Bootstrap.spawn_all/1` still iterates serially — `SpawnOrchestrator.spawn/4` calls `Admission.check_capacity/1`, which does `Repo.get(Network, ...)` + `Registry.count_select/2` + potentially `Repo.one(visitor_count_q) + Repo.one(user_count_q)` per row. That's at minimum 3 DB queries per credential, run sequentially. With ~50 credentials Bootstrap takes O(seconds) just on admission-check round-trips before the first session is spawned.
**Fix:** Either parallelize the admission-check pass (`Task.async_stream/3` with bounded concurrency, since they're all DB-bound) or short-circuit known-empty client_id flows at the `:bootstrap_user`/`:bootstrap_visitor` discriminator (Admission already does this for client_cap; same pattern for the network-cap fast path). Bootstrap is best-effort + non-blocking by design, but the BEAM startup latency-to-first-message is operator-visible.

## MEDIUM

### S6. `Backoff.failure_count/2` is `@doc false` but consumed at `Session.Server:514` for Logger metadata — semi-public via doc-false, the `:rescue ArgumentError -> 0` defense ensures stability but the @doc false marker promises "not stable" for what is now a permanent caller
**File:** `lib/grappa/session/backoff.ex:175-186`
**Category:** API contract drift
`Session.Server.handle_continue` uses `Backoff.failure_count(...)` purely for log-line context. The function is `@doc false` but the call site treats it as a real public API (not in tests, not internal-helper-style). If Backoff later removes the function, the Server's structured log breaks silently (the log key drops from output, no compile error since Logger.info accepts any keyword list).
**Fix:** Either promote `failure_count/2` to a real `@doc` (it's read-only, ETS-direct, cheap, and now has a production consumer), or add the value to the `wait_ms/2` return shape (`{ms, count}`) so the call site doesn't need a second lookup.

### S7. `record_in_flight_join/2`'s 30s TTL sweep is amortized-O(n) per insert via `Enum.reject + Map.new` — unbounded under heavy autojoin (50 channels) means 50 list traversals at boot
**File:** `lib/grappa/session/server.ex:2127-2138`
**Category:** scalability / hot-path complexity
For a session with N autojoin channels, the welcome arm `Enum.reduce` calls `record_in_flight_join` N times. Each call rebuilds the `swept` map by `Enum.reject + Map.new` over `state.in_flight_joins`. Quadratic in autojoin set size. For N=50 (a power user), that's 50×50 = 2500 map-element passes at 001 RPL_WELCOME for boot. Modest scale today; ugly at scale + a ticking time bomb if a future operator binds N=500.
**Fix:** Replace the lazy TTL sweep with a single `Process.send_after/3`-driven sweep at insert time only when the map crosses a threshold (e.g. >100 entries), or move the sweep to a dedicated `:sweep_in_flight_joins` info handler triggered every 30s. The amortization argument breaks down when the trigger event itself fires N times in a tight loop.

### S8. `apply_effects/2` recursion for `[{:join_failed, ...} | rest]` — the `case Scrollback.persist_event/1` `{:error, changeset}` branch logs but still falls through to the `SessionWire.join_failed` broadcast + state mutation. Partial-success failure mode: the channel renders the failure banner but no scrollback row is persisted. On reconnect the state is gone but cic shows nothing in the channel scrollback for the failure
**File:** `lib/grappa/session/server.ex:1885-1936`
**Category:** atomicity / partial-effect leakage
The `:join_failed` arm splits work into 3 concerns. If the persist fails (e.g. body too long, FK constraint), the next two effects (broadcast + WindowState mutation) STILL run. Result: cic-side renders "you were rejected from #foo" via the broadcast, but on next page-load the scrollback has no failure row to replay (only the WindowState is gone too — non-persisted). User reconnects → channel renders empty + no failure indication.
**Fix:** Either (a) gate the broadcast + state mutation on `Scrollback.persist_event/1` success (loud failure: log error + skip), or (b) add the WindowState mutation to the failure path so a snapshot push at reconnect still gets `{:error, :failed}`. Current code partly commits the transition.

### S9. `Mix.Tasks.Grappa.Boot.start_app_silent/0` writes `Application.put_env(:grappa, :start_bootstrap, false)` — boot-time only path is OK, but the documented "boot-time only" exception in CLAUDE.md is `lib/grappa/application.ex` start/2; mix tasks aren't in the documented allowlist
**File:** `lib/mix/tasks/grappa/boot.ex:43`
**Category:** documented exception drift
CLAUDE.md says: "Allowed at boot-time configuration boundaries: `config/*.exs`, `lib/grappa/application.ex` start/2 (the documented exception), and inside mix-task helpers BEFORE `Application.ensure_all_started/1` (operator-task suppression of `Grappa.Bootstrap` is mirror-symmetric with `config/test.exs`'s `:start_bootstrap, false` — pre-boot configuration of the same exception point, not config-as-IPC)." So this IS allowed — but the allowlist in CLAUDE.md is buried + the exception isn't obvious from reading just the code. Dropping a `# CLAUDE.md exception: pre-boot config-as-IPC equivalent` comment at the call site would inoculate against an over-zealous future cross-module reviewer flagging this and removing it.
**Fix:** Add a 1-line comment at `lib/mix/tasks/grappa/boot.ex:43` referencing the CLAUDE.md exception so a future reader doesn't attempt to "fix" it.

### S10. `Grappa.Cic.Bundle` boundary is `top_level?: true, deps: [], exports: []` — but `GrappaWeb.GrappaChannel` (after_join push) and `GrappaWeb.AdminController.cic_bundle_changed/2` BOTH reach into it. The `exports: []` means `current_hash/0` is technically not a boundary-public function
**File:** `lib/grappa/cic/bundle.ex:23`
**Category:** Boundary contract / silent boundary leak
The moduledoc says: "Standalone boundary so both `GrappaWeb.GrappaChannel` (after_join push) and `GrappaWeb.AdminController.cic_bundle_changed/2` can call this without crossing forbidden boundary edges." But `exports: []` means `Grappa.Cic.Bundle.current_hash/0` is not a boundary-exported function. If `Boundary.find_violations` runs, this should flag. Either a stale `exports: []` (was meant to export `current_hash/0`?) or the doc lies about being callable from web. Worth a `mix boundary.find_violations` check.
**Fix:** Add `exports: [Bundle]` or restructure as `exports: []` only if `Grappa.Cic` itself were the namespace anchor with `Bundle` underneath. Verify via the boundary tool which is correct.

### S11. `Session.Server.terminate/2` `try/catch :exit` around `Client.send_quit/2` — the comment justifies this, but the `:exit, _` catch is broader than necessary. A genuine programming error (bad function call, undefined function) would `:exit` with a non-`:exit`-from-call-target reason and be silently swallowed
**File:** `lib/grappa/session/server.ex:564-578`
**Category:** defensive try/catch breadth
Comment says: "the linked Client may be dead, the socket may be already closed, or the call may time out. Any of those is benign at shutdown." But `catch :exit, _` swallows EVERY exit reason, including ones from a future bug in `Client.send_quit/2` (e.g. arity change, undefined). Per CLAUDE.md "Let it crash" — defensive try/rescue/catch should be tight.
**Fix:** Match specific shapes — `catch :exit, {:noproc, _}, :exit, {:timeout, _}, :exit, :normal, :exit, :shutdown -> :ok` and let other exit reasons crash. The current breadth means a Client.send_quit refactor that introduces a bug becomes invisible at shutdown.

### S12. `cancel_and_drain/2` is `@doc false` `def` (public) — comment says exposed for tests; same trapdoor-API pattern as S6, with the same drift risk
**File:** `lib/grappa/session/server.ex:2183-2198`
**Category:** test-surface API marking
"Public-with-`@doc false` so unit tests can exercise the primitive directly" — but what about a future caller (sibling submodule that needs the same drain semantics)? The function is structurally generic; promoting it to `Grappa.Session.Util` or similar would be the right move if there are >1 callers. Right now there's exactly one (Server.ex itself) so it could just be `defp` + tested via the call sites.
**Fix:** Either (a) make it `defp` and test via the cancel paths that drive it, or (b) extract to a sibling module if you anticipate other GenServers needing the same primitive (auto-away timer ≠ pending-auth timer ≠ ghost timer all use it today; a `Grappa.Session.TimerHelpers` module would be the natural home).

### S13. `WSPresence` has no `:rescue` on the `Phoenix.PubSub.broadcast/3` — if PubSub is down (transient supervisor bounce), `notify_sessions/2` crashes the WSPresence GenServer. WSPresence is `:permanent` so it restarts with EMPTY state (every user goes to "no sockets" view)
**File:** `lib/grappa/ws_presence.ex:319-325`
**Category:** crash blast radius
Comment in the module says: "A crash in WSPresence (which is `:permanent`) causes a restart with empty state — auto-away for current sessions is lost until the user next disconnects." Documented but the consequence for live sessions is loud — every session sees `:ws_all_disconnected` after the 30s debounce because the WSPresence has zero sockets registered post-restart. Sessions silently auto-away en-masse on a PubSub blip. Mitigation would be to NOT use Phoenix.PubSub here (since this is local-only fan-out to Session.Server's that are siblings in the supervision tree); a Registry lookup + `send/2` would survive PubSub crashes.
**Fix:** Switch `notify_sessions/2` to `Registry.dispatch(Grappa.SessionRegistry, ...)` since it's purely local fan-out. PubSub here is overkill (cross-node delivery isn't needed, single-node deployment); Registry is one less crash dependency.

### S14. `SpawnOrchestrator` Boundary `deps: [Grappa.Admission, Grappa.Session]` — does NOT include `Grappa.Session.Backoff` despite calling `Backoff.reset/2`. Backoff is exported from Session (`exports: [Backoff, Server, Wire]`) so the alias works, but the boundary call itself is a Session-internal reach
**File:** `lib/grappa/spawn_orchestrator.ex:147-149`
**Category:** Boundary correctness
The orchestrator does `alias Grappa.Session.Backoff` and then `Backoff.reset(...)`. This is fine because Session exports `Backoff`. But the moduledoc emphasizes "shared execution framework, no leak" — the Backoff dependency means changes to Backoff's API surface have to consider 3 callers (Bootstrap, NetworksController via wrapping, SpawnOrchestrator), not just the Session-internal callers. Worth a comment in the orchestrator's moduledoc that it consumes Session.Backoff specifically + a note in Backoff's doc about cross-boundary callers.
**Fix:** Add explicit comment in Backoff's moduledoc listing the cross-boundary callers (SpawnOrchestrator + Visitors.Login). Without it, a future Backoff API change can break the orchestrator silently.

### S15. `Visitors.Login.preempt_and_respawn/4` does NOT use `SpawnOrchestrator` — moduledoc justifies this ("verbs diverge enough to fail the verb-reuse test"). But Login's flow is: `check_capacity → ... → Backoff.reset → ... → spawn_and_await`. The 80% IS shared; the divergence is on the BLOCK-AND-WAIT semantics, not the verb pattern
**File:** `lib/grappa/visitors/login.ex:225-241` (referenced) + `lib/grappa/spawn_orchestrator.ex:48-80` (justification)
**Category:** verb-reuse opportunity
The `SpawnOrchestrator` moduledoc lists 4 reasons Visitors.Login can't reuse the verb. Reading them: (1) richer verb (notify_pid + monitor + receive); (2) admission interleaved with non-spawn concerns; (3) Backoff.reset only on Case 2; (4) other concerns wrap the spawn (NetworkCircuit record_success/failure + purge_if_anon + send_post_login_identify). All true — but a `SpawnOrchestrator.spawn_and_monitor/4` variant could absorb concerns 1+3 cleanly, leaving only 2+4 at the call site. Worth a re-evaluation when channel-client-polish is done.
**Fix:** Defer (not for this cluster). When the next operator-spawn surface emerges (e.g. a `/connect` REST verb from cic), revisit. If both sites end up needing notify+monitor, lift `spawn_and_monitor` and route Login through it.

## LOW

### S16. `pending_password_from_opts/1` clause head pattern-matches on `auth_method: :nickserv_identify` — atom enum but no `@type` reference; if `AuthFSM.auth_method()` adds a new value, this clause silently doesn't match (correct fallthrough to nil) but a Dialyzer hint would catch the case where the pattern needs updating
**File:** `lib/grappa/session/server.ex:487-491`
**Category:** type-system leverage
`auth_method` is an atom enum from `AuthFSM`. The pattern `:nickserv_identify` is hard-coded; if AuthFSM adds `:saslscram_sha256` (or any new value) the catch-all returns nil, which is the desired behavior. No bug, but Dialyzer wouldn't catch the case where the new value SHOULD also stage a pending_password.
**Fix:** Add `@type` import or doc-link to `AuthFSM.auth_method()` so a future reader sees the closed set being matched.

### S17. `Grappa.Mentions` `compile_env` for content_kinds `@content_kinds [:privmsg, :notice, :action]` — hard-coded literal, not derived from `Scrollback.Message.kind` typed allowlist
**File:** `lib/grappa/mentions.ex:59`
**Category:** type drift / tight coupling
The "content kinds" allowlist is a fork of the broader Scrollback message-kind enum. If a future kind (e.g. `:reaction`) is added to the Scrollback enum AND it carries a body, Mentions.aggregate_mentions will silently NOT match against it — fresh kind would land in scrollback but mentions-while-away would skip it.
**Fix:** Derive from `Grappa.Scrollback.Message` — e.g. add a `Message.content_kinds/0` function and reference it here. Single source.

### S18. `extract_modes_isupport/2` parses `MODES=N` with `Integer.parse/1` and checks `n > 0` — but a malformed `MODES=999999999` or `MODES=0` either gets accepted (huge N) or silently falls back to default 3. Uncommented decision
**File:** `lib/grappa/session/server.ex:2271-2278`
**Category:** input validation breadth
The clause `{n, ""} when n > 0 -> {:halt, n}` accepts any positive integer including unreasonable values. A misbehaving server advertising `MODES=10000` would bloat MODE lines beyond IRC line-length limits. The fallback `_ -> {:cont, 3}` for `0`/`-1`/`""` is correct but undocumented.
**Fix:** Add a sane upper bound (`n in 1..50` covers every real ircd) so a malformed MODES advert doesn't break framing.

### S19. `Grappa.Auth.IdentifierClassifier` regex `@email_re ~r/^[^@\s]+@[^@\s]+\.[^@\s]+$/` — RFC5322 light, but accepts UTF-8 in localpart. Not wrong (Phase 5 SMTP delivery would catch issues) but the function spec says "rejects malformed input at the boundary" while accepting `é@é.é`
**File:** `lib/grappa/auth/identifier_classifier.ex:27`
**Category:** validation completeness / spec wording
Moduledoc says rejects malformed; in practice "x@y.z"-shaped UTF-8 passes. Correct dispatch is the goal (route to email path); the email path itself is responsible for stricter validation. Doc could be sharper.
**Fix:** Update doc: "minimal email-shape detection — actual email validity checked downstream" already says this, just make the success-typing limits explicit.

### S20. `WSPresence` `reset_for_test/0` Dialyzer suppression `@dialyzer {:nowarn_function, reset_for_test: 0}` — necessary today, but the documented reason ("two clauses depending on Mix.env() at compile time") is a smell. Consider promoting reset to a separate test-only module per CLAUDE.md "test helpers go through their own boundary"
**File:** `lib/grappa/ws_presence.ex:169-177`
**Category:** test-only API marking
The `if Mix.env() == :test do` branch + Dialyzer suppression is a workaround for not having a clean test-helper module. `Grappa.WSPresence.TestHelpers` (compiled only in test) would avoid both the Mix.env runtime check + the Dialyzer suppression.
**Fix:** Defer — works today; revisit if test-only API surface grows.

### S21. `Grappa.Cic.Bundle` regex `@hash_re ~r{<script[^>]+src="/assets/index-([^."]+)\.js"}` — assumes Vite's filename pattern stays stable. A Vite version that emits `index.<hash>.js` (dot instead of dash) silently returns nil
**File:** `lib/grappa/cic/bundle.ex:34`
**Category:** external-tool format coupling
Comment acknowledges "the hash is the chunk-content fingerprint" but assumes the dash separator. Vite has historically used both dash + dot. A vite upgrade flips it → `current_hash/0` returns nil → cic refresh banner stops working silently.
**Fix:** Loosen to match `index[.-]([^./"]+)\.js` so dot or dash both work. Add a unit test for both shapes.

### S22. `Grappa.Bootstrap.spawn_visitor/2` nested case-of-case — readability suffers, error handling is duplicated
**File:** `lib/grappa/bootstrap.ex:273-317`
**Category:** code shape / DRY
Two `case` statements nested 3 deep; both error branches log + bump `failed` counter with the same `Logger.error("visitor session start failed", ...)` shape. The outer `VisitorSessionPlan.resolve` and inner `get_network_by_slug` branches handle errors identically.
**Fix:** Refactor with `with` chain — `with {:ok, plan} <- VisitorSessionPlan.resolve(visitor), {:ok, %Network{id: nid}} <- Networks.get_network_by_slug(plan.network_slug), do: spawn_with_admission(...) else {:error, reason} -> ...` Single error log, half the indent.

### S23. `Grappa.Version.current/0` — `List.last/1` of `Regex.run` result; if regex fails to match (unlikely but possible mid-edit), `List.last(nil)` raises FunctionClauseError
**File:** `lib/grappa/version.ex:33-38`
**Category:** defensive coding / boot fragility
Pipe ends with `then(&Regex.run(...)) |> List.last()`. If `mix.exs` is being edited mid-read OR the regex doesn't match (someone reformats `@version` to backticks), `Regex.run` returns `nil` → `List.last(nil)` raises. CTCP VERSION reply path crashes the EventRouter.
**Fix:** Pattern-match: `case Regex.run(...) do [_, version] -> version; _ -> "unknown" end`. Soft fail to "unknown" instead of crashing the session on a format-attribute parse error.

## Summary
- **0 CRITICAL, 5 HIGH, 10 MEDIUM, 8 LOW**
- Top 3 themes:
  1. **Visitor + user lifecycle asymmetry** (S1, S15) — the visitor flow is a near-twin of the user flow but lacks the credential_failer terminal-failure surface AND doesn't go through SpawnOrchestrator. Two divergent error/respawn paths for one logical concept.
  2. **Defensive try/catch + dead-letter swallow** (S3, S8, S11) — restart-strategy classification (`{:client_exit, :normal}` mistakenly abnormal), partial-effect leakage on persist failure (`:join_failed` arm), and overly-broad `:exit, _` catch in terminate. Each one defeats some "let it crash" or transactional boundary.
  3. **API contract marking** (S6, S10, S12) — `@doc false` functions with real production callers, `exports: []` on a boundary that has external callers per the moduledoc, test-only public functions sitting next to production helpers. Drift risk at the edges of formal API contracts.
