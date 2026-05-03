# Codebase Review — 2026-05-03

**Scope:** Delta since `docs/reviews/codebase/2026-05-02-codebase-review.md`
(commit `ae42ebf` → main HEAD `95d1564`, 73 commits). Covers:

  * **T30** — visitor REST surface (CP11 S19; 8 feature commits +
    cicchetto consumer surface).
  * **S20** — `Session.Backoff` ETS GenServer hotfix (per-(subject,
    network) exponential reconnect + crash-survival).
  * **T31 Plan 1** — admission infrastructure (CP11 S21; 12 tasks
    + 18 cluster commits): `Admission` boundary,
    `Admission.NetworkCircuit` ETS GenServer,
    `Admission.Captcha.{Disabled,Turnstile,HCaptcha}` impls,
    schemas (`accounts_sessions.client_id`,
    `networks.{max_concurrent_sessions, max_per_client}`).
  * **T31 Plan 2** — admission integration (CP11 S22; 14 tasks
    + 25 cluster + 3 deploy-fix commits): Login + Bootstrap +
    Plugs.ClientId + AuthController wiring; FallbackController
    error mapping; cicchetto clientId + captcha widget;
    `mix grappa.set_network_caps` operator-bind verb.
  * **PRIVMSG round-trip e2e addendum** (CP11 S22 close-out, post-T31).

**Method:** Seven parallel agents — six line-level scopes per
`docs/reviewing.md` §1 (`irc/`, `persistence/`, `lifecycle/`, `web/`,
`cicchetto/`, `cross-module + infra`) and one architecture/boundary
agent per `docs/reviewing.md` §2 (focused on `Admission` boundary
shape, `NetworkCircuit`/`Backoff` overlap, Captcha cohesion, wire-
shape drift). PROBLEMS-ONLY. Findings deduplicated where multiple
agents flagged the same root cause; deduplicated finding gets the
strongest severity any agent assigned.

**Reviewer:** seven codebase-review agents dispatched 2026-05-03 in
main session (post-T31 close + PRIVMSG addendum).

## Severity summary

| Module/scope | CRITICAL | HIGH | MEDIUM | LOW |
|--------------|---------:|-----:|-------:|----:|
| irc/ (mostly pre-existing, zero delta commits in scope) | 0 | 1 | 4 | 2 |
| persistence/ | 0 | 2 | 6 | 4 |
| lifecycle/ | 0 | 3\* | 5 | 4 |
| web/ | 0 | 2 | 5 | 4 |
| cicchetto/ | 0 | 2 | 7 | 6 |
| cross-module + infra | 0 | 4 | 7 | 5 |
| architecture / boundary | 0 | 1 | 6 | 4 |
| **TOTAL (deduped)** | **0** | **12** | **35** | **27** |

\* `Application.get_env at runtime` flagged by lifecycle (H1), web
(W3), and architecture (A2) — counted once in HIGH.

Total deduped: **74 findings** (0 CRITICAL, 12 HIGH, 35 MEDIUM, 27 LOW).

**Headline:** No CRITICAL regressions. T31 cluster landed clean.
HIGH findings cluster on **two** themes:

  1. **Architectural drift around `Grappa.Admission`** — five runtime
     `Application.get_env` reads in admission/captcha modules
     (CLAUDE.md "runtime banned"); captcha provider names hand-mirrored
     in 5 sites (joins the existing cross-language enum drift theme);
     `Captcha.Turnstile` ↔ `Captcha.HCaptcha` near-duplicate impls;
     `GrappaWeb` Boundary deps doesn't list `Admission` despite hard-
     coded module references.
  2. **Frontend correctness gaps in the captcha + login flow** —
     captcha widget mount errors swallowed (login deadlocks if CDN
     blocked); `friendlyMessage` missing `captcha_required` arm
     (raw `400 captcha_required` ships to UI when provider misconfigured);
     captcha widget cleanup races on rapid mount/unmount.

There is also one **non-T31 HIGH** — `User logout doesn't disconnect
active WebSocket` (W1), which mirrors S22's user-logout-terminates-
sessions Task 7 fix at the REST/Session layer but stops short of the
WS layer.

Per the orchestrator HALT trigger ("CRITICAL findings surface FIRST"):
zero CRITICAL — proceed to the per-area breakdown.

---

## HIGH

### H1. `Application.get_env` runtime reads in `Admission`, `Captcha.Turnstile`, `Captcha.HCaptcha`, `FallbackController`

**Module:** lifecycle/ + web/ + architecture | **Files:**
`lib/grappa/admission.ex:209-213`, `lib/grappa/admission/captcha/turnstile.ex:20-22`,
`lib/grappa/admission/captcha/h_captcha.ex:20-22`,
`lib/grappa_web/controllers/fallback_controller.ex:191,195`
**Category:** CLAUDE.md "Application.get_env runtime banned" violation

CLAUDE.md OTP rule: "boot-time only, runtime banned. Banned at
runtime — neither read nor written from any GenServer callback,
controller, context function, plug body, or release task. Pass config
via `start_link/1` opts; the supervisor reads env at boot and injects."

T31 introduced **five** runtime reads on the request hot path:
`Admission.verify_captcha/2` (context fn), `Turnstile.verify`
(context fn), `HCaptcha.verify` (context fn), and TWO inside
`FallbackController` (`captcha_site_key/0` + `captcha_provider_wire/0`,
controller plug body). The `Admission` moduledoc unilaterally
self-justifies this as "the single documented exception" — but that
exemption was added by this commit, not pre-existing in CLAUDE.md.

**Three problems compound:**

1. The rule's deterrent function erodes — next contributor cites T31
   as precedent.
2. The captcha provider can't be substituted via `start_link/1` opts
   in tests, forcing `Application.put_env` round-trips, which is
   exactly the IPC-via-config anti-pattern the rule outlaws.
3. The runtime read traps the operator: env-var change at runtime
   takes effect only because there's no init-time injection — Plan 1's
   deploy-bug #1 (`compose.prod.yaml` env vars not propagated)
   succeeded silently because of exactly this layering. Boot-time
   discipline would have failed loudly with `:noproc`-style crash
   instead of silently falling back to `Disabled`.

**Fix:** Resolve captcha config to a struct once at boot in
`Grappa.Application.start/2` (read all `:admission` keys, validate
required fields when provider != `Disabled`, store as immutable
state via `:persistent_term` or inject into `NetworkCircuit`'s
state). Verb sites (`Admission.verify_captcha/2`, FallbackController)
read from the resolved struct, not `Application.get_env`. Mox path:
test app starts with `start_bootstrap: false` and a fake-module key
in the keyword the supervisor reads — mirror-symmetric with
`:start_bootstrap`'s test exception (the only pre-existing CLAUDE.md
exception).

### H2. `User logout` does not terminate active WebSocket connections

**Module:** web/ | **File:** `lib/grappa_web/controllers/auth_controller.ex:90-94`
**Category:** authorization-boundary leak

`logout/2` revokes the bearer + stops `Session.Server` processes
(Task 7), but never calls `Endpoint.broadcast("user_socket:#{user_name}",
"disconnect", %{})`. `UserSocket.id/1`
(`channels/user_socket.ex:65`) is set precisely for this disconnect
verb. Without the broadcast, an active WebSocket subscription to
`grappa:user:<name>/...` continues receiving PubSub pushes after the
bearer has been revoked. Symmetric gap: the bearer-as-connect-
credential model only holds at connect time, never re-checked
mid-flight. Both subject branches affected (user + visitor).

**Fix:** After `Accounts.revoke_session/1`, call
`GrappaWeb.Endpoint.broadcast("user_socket:#{user_name}",
"disconnect", %{})` for both branches. `user_name` is `user.name`
(user) or `"visitor:<id>"` (visitor) — already the conn-side
`current_user` / `current_visitor` assigns. Add a regression test
that opens a socket, hits `DELETE /auth/logout`, and asserts
`"phx_close"` push.

### H3. Captcha widget mount errors swallowed — login deadlocks if CDN blocked

**Module:** cicchetto/ | **File:** `cicchetto/src/Login.tsx:69-80`
**Category:** error-path-swallowing / UX deadlock

`createEffect` calls `mountCaptchaWidget(...).then((c2) => {cleanup
= c2})` with NO `.catch`. If Cloudflare's CDN is blocked
(ad-blockers like uBlock Origin block `challenges.cloudflare.com`
by default for many users), `loadScript` rejects with `failed to
load https://challenges.cloudflare.com/turnstile/v0/api.js` and the
rejection is swallowed by the `void` + `.then`. Captcha container
renders empty, no error toast, login button re-enabled
(`finally setSubmitting(false)` already ran). User sees a blank gap
— login unrecoverable until they reload.

**Fix:** Chain `.catch((err) => { setCaptcha(null); setError("Captcha
unavailable. Disable ad-blocker or try again."); })` on the mount
promise. Cover with a vitest case that does NOT pre-inject the
script and stubs `script.onerror` (the existing test
`captcha.test.ts:19-26` pre-injects, never exercising
`loadScript`'s actual code path — see M-cicchetto-4 below).

### H4. `friendlyMessage` missing `captcha_required` arm — raw `400 captcha_required` leaks to UI

**Module:** cicchetto/ | **File:** `cicchetto/src/Login.tsx:16-37`
**Category:** wire-shape drift / UX

When `captcha_provider` env is misconfigured (DESIGN_NOTES line 1425
— anything other than the two known atoms falls back to Disabled,
but Login responses still emit `captcha_required` if the gate fires),
`Login.tsx`'s narrowing `if (provider === "turnstile" || provider
=== "hcaptcha")` correctly skips mounting, then falls through to
`setError(friendlyMessage(err))`. `friendlyMessage` has NO case for
`"captcha_required"` so it returns `err.message`, which is the
literal string `"400 captcha_required"`. That ships to a `<p
role="alert">`. Operators see Phoenix error tokens in the UI.

**Fix:** Add `case "captcha_required":` arm returning a generic
"Verification temporarily unavailable" copy. Same edit unblocks the
"provider: disabled with captcha gate enabled" config edge case.

### H5. `captcha_provider_wire/0` hard-codes impl-module list in `GrappaWeb`; `GrappaWeb` Boundary deps does not list `Admission`

**Module:** architecture / web | **File:**
`lib/grappa_web/controllers/fallback_controller.ex:194-200`,
`lib/grappa_web.ex:11-23`
**Category:** boundary leak

`FallbackController.captcha_provider_wire/0` pattern-matches on
captcha-impl module atoms by literal name (`Grappa.Admission.Captcha.Turnstile`
→ `"turnstile"`, etc.). Those modules belong to the `Grappa.Admission`
top-level boundary. `GrappaWeb`'s `use Boundary, deps: [...]` lists
`Accounts, IdentifierClassifier, IRC, Networks, PubSub, Scrollback,
Session, Visitors` — `Admission` is **absent**. The same controller
also reads `Application.get_env(:grappa, :admission, ...)` directly.

Either (a) Boundary is silently ignoring module-as-atom literals in
case patterns (real risk — Boundary's analyzer focuses on
aliases/calls), letting cross-boundary coupling drift, OR (b) the
rule is enforced and the build is currently passing only because
`mix boundary` isn't a CI gate.

**Fix:** Add `Grappa.Admission` to `GrappaWeb`'s Boundary deps;
add a `wire_name/0` callback to the `Captcha` behaviour returning
the snake_case wire token; expose `Grappa.Admission.captcha_provider_wire/0`
that resolves the configured impl + asks it.
`FallbackController` calls the verb instead of the case. Provider
list owned by Admission, mirrored once.

### H6. `NetworkCircuit.check/1` race: cooldown-expire cast can clobber a fresh failure

**Module:** lifecycle/ | **File:**
`lib/grappa/admission/network_circuit.ex:117-142, 173-205, 227-244`
**Category:** GenServer mailbox-ordering bug

Sequence:

1. `T0`: circuit `:open`, `cooled_at_ms = 1000`, now=1001 →
   `check/1` casts `{:cooldown_expire, network_id}`, returns `:ok`.
2. `T0+ε`: caller probes, fails, calls `record_failure/1` → cast
   `{:failure, network_id}` lands in mailbox **before** the
   `:cooldown_expire`.
3. `handle_cast({:failure, ...})` reads ETS, sees `:open` with
   `now - prior_start > @window_ms`, resets count to 1 and inserts
   `{network_id, 1, now, :closed, 0}`.
4. `handle_cast({:cooldown_expire, ...})` runs, finds `:closed`,
   no-ops — fine.
5. **Alternative interleaving** (the bug): failure cast first writes
   `{count, _, :open, _}`, then expire cast runs `case :ets.lookup`
   finds `:open` with `now >= cooled_at_ms` still true → `:ets.delete`
   — and emits `circuit_close(:cooldown_expired)` for an entry that
   just re-tripped on the same tick.

The expire-cast handler doesn't re-check that `state == :open`
corresponds to the **same** opening it observed. A failure that
re-opens the circuit between the `check/1` cast and the expire-cast
handler will be deleted and resurface as a `:cooldown_expired` close
event followed by no `:open` (since count was 1 again). Visible
operator effect: bogus close events; concrete: a flapping upstream
produces a broken open/close ordering in telemetry.

**Fix:** Capture `cooled_at_ms` at the `check/1` cast site and pass
it: `{:cooldown_expire, network_id, observed_cooled_at}`. In the
handler, match `[{_, _, _, :open, ^observed_cooled_at}]` — guard
against any state mutation since observation.

### H7. `NetworkCircuit.handle_cast({:failure, ...})` window-reset path drops `prior_circuit_state`

**Module:** lifecycle/ | **File:**
`lib/grappa/admission/network_circuit.ex:181-187`
**Category:** state-machine drift

Branch `if now - prior_start > @window_ms do {1, now, :closed} ...`:
when the rolling window expires, the code returns
`prior_circuit_state = :closed` regardless of the actual prior state.
If the circuit was `:open` with `cooled_at_ms` not yet elapsed but
the *failure window* (60s) elapsed, the reset re-classes the circuit
to `:closed` for transition-detection purposes — but the ETS row
still holds `:open` with a future `cooled_at_ms`. Then if `count >=
@threshold` evaluates false (it's 1), `:closed, 0` is inserted,
**silently closing the circuit before its cooldown elapsed**.

The window and the cooldown are independent (per the brief). Here,
a failure during cooldown but past window erases the cooldown.

**Fix:** Only reset window when `prior_state == :closed`. If
`prior_state == :open` and `now < cooled_at_ms`, drop the failure
record (per moduledoc "no half-open"). Add test: failure arrives
while circuit is open.

### H8. `mix grappa.set_network_caps` raises `KeyError` on missing `--network`

**Module:** cross-module + infra | **File:**
`lib/mix/tasks/grappa.set_network_caps.ex:58`
**Category:** UX regression / test pins buggy behavior

`Keyword.fetch!(opts, :network)` raises `(KeyError) key :network not
found in: []`. The shortdoc says `--network` is required; raise
should be friendly via `Mix.raise/1` like the `attrs == 0` branch
on line 70, not via a raw `KeyError`. The test
`test/mix/tasks/grappa/set_network_caps_test.exs:61-67` actually
**pins** this UX:
`assert_raise KeyError`. Operator sees an Elixir stacktrace.

**Fix:** Replace `Keyword.fetch!` with explicit
`slug = Keyword.get(opts, :network) || Mix.raise("--network <slug> is required")`.
Update test to `assert_raise Mix.Error`. Same shape pattern as
existing `attrs == 0` clause. Same fix needed for "unknown slug"
path (`Ecto.NoResultsError` propagates today — also pinned).

### H9. `client_id` indexed alone on `accounts_sessions` — admission count query won't use it

**Module:** persistence/ | **File:**
`priv/repo/migrations/20260503090000_add_client_id_to_sessions.exs:9`
**Category:** missing/wrong index for hot-path query

Plain `create index(:sessions, [:client_id])` is wrong shape for the
load-bearing query: `Admission.check_capacity/1`'s per-(client,
network) cap counts non-revoked sessions filtered by both
`client_id == ?` and the visitor/user join, plus a network. SQLite
will pick this single-column index, then walk every row matching
the client, scanning revoked + cross-network rows. As `client_id`
cardinality is low (one per device) and a single device is reused
across networks, this scales poorly. Folds together with the
already-filed partial-index follow-up (`where: "client_id IS NOT
NULL"`).

**Fix:** Composite + partial: `create index(:sessions, [:client_id,
:network_id], where: "client_id IS NOT NULL AND revoked_at IS
NULL")`. Verify with `EXPLAIN QUERY PLAN` before committing.

### H10. `Networks.update_network_caps/2` cannot CLEAR a cap — `nil` silently dropped

**Module:** persistence/ | **File:** `lib/grappa/networks.ex:132-140`,
`lib/grappa/networks/network.ex:59`
**Category:** API gap

`Network.changeset` casts caps then `validate_number(greater_than:
0)`. Casting an explicit `nil` puts a `nil` change but `validate_number`
is a no-op on nil. Ecto only writes keys present in attrs, so
"update only `max_concurrent_sessions`" leaves `max_per_client`
untouched — **there is no path to RESET a cap from `5` back to `nil`
("unlimited") via this verb**. Operator who set a cap by mistake
cannot undo it through the documented operator-bind verb. T31
plan's spec calls "absent = unlimited" so the missing clear path
is a real gap.

**Fix:** Add an explicit clear option to `update_network_caps/2`
(e.g. `--clear-max-sessions`/`--clear-max-per-client` mix-task
flags) or introduce `clear_network_cap/2` putting `nil` via
`Ecto.Changeset.change/2`.

### H11. `.env.example` missing T31 captcha env vars — repeat of `fd9ce80` deploy bug

**Module:** cross-module + infra | **File:** `.env.example` (whole file —
no `GRAPPA_CAPTCHA_*` entries)
**Category:** compose-env drift / repeat of deploy-fix-1

Deploy-time bug `fd9ce80` was about *forgetting to wire env vars in
`compose.prod.yaml`*. The companion drift survives:
`compose.prod.yaml:57-59` lists `GRAPPA_CAPTCHA_PROVIDER`,
`GRAPPA_CAPTCHA_SITE_KEY`, `GRAPPA_CAPTCHA_SECRET`, but
`.env.example` does NOT mention them. Operators copying
`.env.example` to `.env` will not know these knobs exist; the prod
stack will silently fall back to `Disabled` provider — exactly the
failure mode `fd9ce80` claimed to fix. Same class of bug, one
config file later.

**Fix:** Add a `# T31 admission captcha (optional — leave unset for
Disabled provider)` block to `.env.example` listing all three keys
with brief comments. Better: add a runtime startup check that emits
`Logger.warning` when `GRAPPA_CAPTCHA_PROVIDER` is set to
`turnstile`/`hcaptcha` but `GRAPPA_CAPTCHA_SECRET` is nil. The
existing warning at `runtime.exs:84-89` covers `site_key=nil` only.

### H12. IRC `send_pong/2` echoes NUL bytes from upstream — parser strips CR/LF but NOT `\x00`

**Module:** irc/ | **File:** `lib/grappa/irc/client.ex:229-235`,
`lib/grappa/irc/parser.ex:262-269`
**Category:** charset boundary / wire-injection (PRE-EXISTING — no IRC
delta in scope, surfaced in this round)

`send_pong/2`'s docstring justifies omitting the `safe_line_token?`
guard: "the parser strips ALL `\r`/`\n` from inbound bytes ... so by
the time `Session.Server` echoes the token here it cannot contain
CR/LF." True for CR/LF, but `Parser.strip_crlf/1` strips ONLY `\r`
and `\n` — NOT `\x00`. `Identifier.safe_line_token?/1` rejects all
three. A hostile upstream emitting `PING :tok\x00<garbage>\r\n`
rides the NUL straight through `Parser.parse → run_fsm_step →
Session.Server → Client.send_pong → :gen_tcp.send`, putting
attacker-controlled NUL bytes into the bouncer's outbound stream.
Most ircd reject NUL outright (RFC 2812 §2.3) but the contract gap
means the invariant "Session.Server's PONG echo path cannot smuggle
bytes upstream" is not actually held. Asymmetry: `send_privmsg/3`
rejects NUL via the guard, `send_pong/2` does not.

**Fix:** Either (a) extend `Parser.strip_crlf` (rename to
`strip_unsafe_bytes`, add NUL to the `:binary.replace` list), making
the parser invariant match `safe_line_token?`; or (b) gate
`send_pong/2` on `Identifier.safe_line_token?(token)` and crash on
violation. (a) is safer — single source of truth at the parse
boundary.

---

## MEDIUM

The 35 MEDIUM findings are listed below grouped by area. Each carries
file:line + category + fix one-liner; full evidence in the per-agent
reports preserved during synthesis (paraphrased here).

### Lifecycle / OTP

  * **M-life-1.** `Backoff` and `NetworkCircuit` ETS named-tables
    survive GenServer death (creation in `init/1`); ETS readers
    (`Backoff.wait_ms/2`, `NetworkCircuit.check/1`) raise
    `ArgumentError` on `:ets.lookup` between crash and respawn.
    Wrap reads in `try/rescue` with safe defaults, OR move table
    creation to `Application.start/2` with `heir:` to survive
    GenServer restarts.
  * **M-life-2.** `Backoff.handle_cast({:reset, _}, _)` and
    `{:success, _}` are operationally identical — both delete the
    ETS key. Distinguished only by intent at call site, no telemetry/
    log/test asserting they remain distinct. Either add telemetry to
    surface the distinction or collapse to one cast with a reason
    atom.
  * **M-life-3.** `Bootstrap.spawn_one/2` and `spawn_visitor/2`
    duplicate identical capacity-check + `{:error,
    :network_cap_exceeded}` + `{:error, {:already_started, _}}`
    branches. Refactor to `spawn_with_admission/3` taking
    `{subject, network_id, plan, log_keys}`.
  * **M-life-4.** `Bootstrap.spawn_one/2` cap-rejected counter routing
    is misleading — `{:error, :network_cap_exceeded}` increments
    `failed`, but `failed` is documented as real failures only.
    Operator dashboard can't distinguish operator policy from real
    config errors. Add `skipped` counter; reserve `failed` for real
    failures.
  * **M-life-5.** `Bootstrap.spawn_one/2` does NOT call
    `Backoff.reset/2` before respawn — Bootstrap restart re-applies
    stale backoff. Moot today (fresh Application.start = fresh ETS),
    but if Phase 5 introduces table persistence (DETS/heir), this
    becomes a real bug. Add explicit reset in
    `Bootstrap.spawn_one`, or comment why it's intentional.

### Persistence / schemas

  * **M-pers-1.** `client_id` is `:string` for an opaque UUID v4 — no
    length / shape validation in changeset. A 10MB blob in
    `X-Grappa-Client-Id` would land in DB. Add
    `validate_format(:client_id, ~r/\A[0-9a-f-]{36}\z/i)` or a length
    cap.
  * **M-pers-2.** `validate_subject_xor/1` adds error to `:user_id`
    only — `:visitor_id` gets no error key in `Session` and
    `Message`. REST surface introspecting `errors_on(cs)` for
    visitor-only flows sees no `:visitor_id` error and incorrectly
    concludes visitor is fine. Attach error to whichever field is
    at fault, or to a synthetic `:subject` key.
  * **M-pers-3.** `Visitor.create_changeset/1` does not validate
    `:expires_at` is in the future. Caller computes `now + 48h` but
    a buggy/malicious mix-task could pass `~U[3000-...]`.
    Add `validate_change(:expires_at, ...)` or document operator
    paths are trusted.
  * **M-pers-4.** `visitors.network_slug` denormalised — drift risk
    vs. `Networks.Network.slug`. No FK. `visitor_channels.network_slug`
    is a SECOND copy. Future `Networks.update_network_slug/2` would
    silently de-link every visitor row. Document slug as immutable
    in `Network` moduledoc OR migrate to `network_id` FK.
  * **M-pers-5.** `messages.visitor_id` is indexed alone — but per-
    subject iso fetch is `(visitor_id, network_id, channel,
    server_time)` (the user side has the matching composite). T30
    widened `Scrollback.fetch/5` for visitors; visitor traffic is the
    bouncer's heaviest path post-launch. Add migration:
    `create index(:messages, [:visitor_id, :network_id, :channel,
    :server_time])`.
  * **M-pers-6.** `Networks.find_or_create_network/1` swallows non-
    uniqueness changeset errors on the recovery path. On insert
    failure, falls back to `Repo.get_by` even when the changeset
    error was something other than uniqueness. Inspect the
    changeset; only do the lost-race lookup when slug uniqueness
    is the cited error.

### Web layer

  * **M-web-1.** `MeController` discriminated dispatch crashes on race
    between subject TTL expiry. `Plugs.Authn` co-assigns
    `current_user`/`current_visitor` with `current_subject`, but the
    contract is convention not type. `MeController.show/2` matches
    `{:user, _}` then reads `conn.assigns.current_user` —
    `KeyError` if the matching struct isn't loaded. Same shape in
    `NetworksController`, `ChannelsController`. Drop the
    discriminator and pattern-match on the loaded struct's presence,
    OR inline a single subject-loader returning `{:user, %User{}} |
    {:visitor, %Visitor{}}` from the plug.
  * **M-web-2.** `AuthController.@visitor_network_slug` uses
    `compile_env` but value is operator-rotatable. Slug is baked into
    the BEAM at compile time. DESIGN_NOTES references rotation;
    rotation requires re-release rebuild. Switch to `Application.get_env`
    runtime read OR inject through controller `init/1`. Document
    rotation semantics.
  * **M-web-3.** `AuthController.visitor_login/3` reads
    `conn.params["captcha_token"]` without shape validation. A 10MB
    string OR JSON nested object lands deep in
    `Admission.verify_captcha/2`. Add `is_binary(captcha_token)
    and byte_size(captcha_token) < 4096` shape-check before calling
    `Login.login/2`.
  * **M-web-4.** `ChannelsController.merge_channel_sources/2` non-
    deterministic on MapSet enumeration in absence of the final
    sort. Fragile — future tiebreaker (e.g. mode) trips. Sort on
    `(name, source)` so ordering is fully deterministic.
  * **M-web-5.** `Plugs.ClientId` moduledoc claims "verbatim, server
    stores" + "URL-safe ASCII" but regex is the SUBSET
    `~r/\A[A-Za-z0-9_-]+\z/`. Fix moduledoc to match the regex.

### Cicchetto

  * **M-cic-1.** Wire-shape: `friendlyMessage` covers 5 of 6 admission
    tokens — `captcha_required` missing (also tracked as H4, kept
    here for the broader audit trail). `AdmissionError` declares
    `captcha_failed` but the brief says `captcha_invalid` — server
    emits `captcha_failed` (server↔client match). Stale terminology
    in the brief.
  * **M-cic-2.** `Login.tsx:53-54` `as` casts trust wire blindly
    (`err.info.provider as "turnstile" | "hcaptcha" | "disabled"`).
    Narrow with `typeof err.info.site_key === "string" &&
    (err.info.provider === "turnstile" || ...)`.
  * **M-cic-3.** `clientId.ts:22-23` `bytes[6] ?? 0` — defensive-OR-
    zero in a crypto path is a smell. `new Uint8Array(16)` cannot
    have `bytes[6] === undefined`. Use `bytes[6]!` or
    `// biome-ignore`. Cosmetic but reads as a real possibility.
  * **M-cic-4.** Captcha tests pre-inject the `<script>` tag, masking
    real CSP/ad-blocker failure modes. `loadScript`'s
    `document.head.appendChild + onerror` path is never exercised.
    Add a test that does NOT pre-inject and asserts
    `mountCaptchaWidget` rejects when `script.onerror` fires —
    pairs with H3.
  * **M-cic-5.** `mountCaptchaWidget` cleanup tracking races on
    rapid mount/unmount. `let cleanup` outside the effect, `onCleanup`
    registers immediately, `cleanup` is `undefined` until `then`
    resolves. Effect re-run reassigns `cleanup` without first calling
    the previous one — toggling captcha leaks each prior widget
    (Turnstile keeps a hidden iframe + global listeners). Move
    cleanup tracking into the effect closure: `let local = false; ...
    if (local) c2(); else cleanup = c2; ...`.
  * **M-cic-6.** `auth.ts:51` calls `api.setOn401Handler(...)` at
    module-load — registers a global side effect outside any test
    reset. Test isolation depends on import order. Move to
    `bootstrap()` called from `main.tsx`, OR provide a
    `clearAllAuthState()` test helper.
  * **M-cic-7.** `MeResponse` `displayNick` returns `string` but
    `ScrollbackPane.tsx:181-184`'s `userNick` reads `user()` resource
    which has loading state; spec lies on the `MeResponse | undefined`
    case. Practically a no-op (falsy → null), but cover with a
    resource-loading unit test.

### Cross-module + infra

  * **M-cross-1.** Captcha env-var → config canonicalization missing
    (deploy-time fix not generalized). Three places now have to stay
    in sync: `runtime.exs` reads, `compose.prod.yaml` propagates,
    `.env.example` documents. No boot-time assertion. Add a comment
    block at top of `runtime.exs` listing every env var read + a
    one-liner mandate "every entry here MUST appear in
    `compose.prod.yaml` AND `.env.example`". Or boot-time check in
    `Grappa.Application.start/2` (warn on missing prod env vars).
  * **M-cross-2.** `Bypass.expect_once/3` in captcha tests asserts
    call count when only outcome matters. If `verify/2` gains a
    retry on connection failure, every existing test breaks for
    irrelevant reasons. Switch `expect_once` → `expect` for
    success/failure tests; keep `expect_once` only when the test
    name explicitly says "calls endpoint once."
  * **M-cross-3.** `Captcha.{Turnstile,HCaptcha}` test files are 76-
    line near-duplicates differing only in module name + endpoint
    config key. CLAUDE.md "Implement once, reuse everywhere." Either
    one shared test module with `@moduletag` parameterization, or a
    behaviour-conformance test helper.
  * **M-cross-4.** `:hcaptcha_endpoint` / `:turnstile_endpoint` config
    keys: undocumented test-only seam. They sit in the same keyword
    list as production keys. Add moduledoc note OR move overrides
    to a compile-time `@endpoint` so they cannot leak to prod.
  * **M-cross-5.** CSP `connect-src 'self' ws: wss:` accepts WebSocket
    connections to ANY host on the internet. Phoenix Channels uses
    same-origin WS. Tighten to `connect-src 'self' ws://grappa.bad.ass
    wss://grappa.bad.ass https://challenges.cloudflare.com`. Drop
    `ws://` clause when TLS lands in Phase 5.
  * **M-cross-6.** CSP duplicated verbatim across two `add_header`
    blocks (`infra/nginx.conf:82,134-138`) because nginx
    `add_header` inheritance is replaced (not merged) by a more-
    specific block. Hoist to `include /etc/nginx/snippets/security-
    headers.conf` referenced from both locations.
  * **M-cross-7.** `Application.put_env(:grappa, :admission, ...)` in
    tests writes `:captcha_secret`, `:hcaptcha_endpoint`,
    `:turnstile_endpoint` — values the moduledoc exception does NOT
    cover (only provider module). Either widen moduledoc to
    acknowledge secret + endpoint can be test-overridden, OR refactor
    tests to pass these as function arguments.

### Architecture

  * **M-arch-1.** `Captcha.Turnstile` and `Captcha.HCaptcha` are
    35-line near-duplicates — abstraction at wrong granularity. The
    `Captcha` behaviour abstracts what differs (provider name) but
    HTTP-verify shape is identical. Promote shared shape to
    `Grappa.Admission.Captcha.SiteVerifyHttp` (private helper, NOT
    behaviour); per-impl modules collapse to ~6 lines.
  * **M-arch-2.** `Admission.NetworkCircuit` and `Session.Backoff`
    overlapping responsibility, distinct keys. Both are ETS-backed
    GenServers tracking failure state with jitter. Distinct
    today — but if a third instance arrives, repeat. Extract
    `Grappa.RateLimit.JitteredCooldown` (pure, no GenServer);
    consume from both. Defer full unification until a 3rd instance
    arrives.
  * **M-arch-3.** Six new admission error atoms have no `@type`
    union — `FallbackController` `@spec` is hand-mirror only. Adding
    a 7th atom is a 5-site edit (Admission/Captcha `@type` +
    FallbackController `@spec` + clause + cicchetto union +
    `friendlyMessage` switch + tests). Define `@type
    Grappa.Admission.error :: capacity_error() | Captcha.error()`;
    FallbackController `@spec` references it. Also: candidate target
    for the cicchetto codegen story (existing trajectory theme).
  * **M-arch-4.** `client_id` is `:string` everywhere — schema
    column + plug regex `~r/\A[A-Za-z0-9_-]+\z/` admits non-UUIDs
    + Admission typespec `String.t() | nil`. Three slightly-different
    contracts. Tighten plug to UUID v4 format AND mirror via
    `field :client_id, Grappa.ClientId` custom Ecto type, OR
    explicitly document that `client_id` is "any opaque ≤64-byte
    ASCII token" everywhere.
  * **M-arch-5.** `Admission.capacity_input` carries `subject_kind` +
    `subject_id` as parallel fields, not `subject :: {:user, id} |
    {:visitor, id}`. Inverts the discriminated union T30 plumbed.
    Either drop unused `subject_*` fields (call site only consumes
    `client_id` + `network_id` + `flow`) or reshape to the canonical
    union.
  * **M-arch-6.** Three deploy-time bugs share one structural pattern:
    prod-only config boundaries are not registry-tested. The
    DESIGN_NOTES post-mortem captures the lesson but no architectural
    countermeasure exists. Introduce `Grappa.Bootstrap.preflight/0`
    (or `Grappa.Application.preflight/0`) walking the captcha config
    + asserting required env vars are non-nil for non-Disabled
    providers. Plus a CI test parsing `infra/nginx.conf` and
    asserting CSP entries for each captcha provider in the impl
    module list.

### IRC (delta = zero, but the agent surfaced pre-existing gaps)

  * **M-irc-1.** `parse_prefix/1` produces `{:nick, "", nil, nil}` and
    other empty-string nick/user/host shapes when input is malformed
    (`!user@host`, `nick!@host`, `nick!user@`, bare `:`). Normalize
    empty-string components to `nil`. Empty string propagates into
    PubSub broadcasts + scrollback rows depending on a non-empty
    sender label.
  * **M-irc-2.** `IRCServer.do_wait_for_line/3` busy-polls every 10ms
    via `GenServer.call`, codifying a `Process.sleep(10)` busy-wait
    in test-support — collides with the same vigilance that
    addressed S18 H1. Replace with synchronous predicate-based
    wait.
  * **M-irc-3.** `parse_cap_list/1` missing `@spec`; `Message.tags`
    lookup helpers absent — typed shape bypassed by callers
    (`tags` is `%{optional(String.t()) => String.t() | true}` but
    no helper for "fetch a tag with a default"). Add `Message.tag/2`
    + `Message.tag/3`; spec `parse_cap_list`.
  * **M-irc-4.** `do_unescape/2` line 201 catch-all clause is spec-
    compliant but undocumented. If someone "tightens" the parser by
    removing it, an unknown escape `\q` crashes with
    `FunctionClauseError`. Add comment block citing IRCv3 §3.3 + a
    doctest pinning the behavior.

---

## LOW

The 27 LOW findings are summarized as one-liners (file:line + fix).
Full evidence in agent reports — synthesized list:

  * **L-irc-1.** `Message.sender_nick/1` returns `"*"` magic string for
    `nil` prefix — document or move to a tagged tuple/atom sentinel.
  * **L-irc-2.** `IRCServer` test acceptor leaks listen socket on
    non-`:ok` accept return; add `terminate/2` to close.
  * **L-pers-1.** `:auth_method` (and `messages.kind`) is `:string` in
    DDL but enum at schema layer — add DB-level CHECK constraint.
  * **L-pers-2.** `Scrollback.fetch/5`'s `subject_where/2` dispatch is
    not exhaustive at compile time — add fall-through clause that
    raises `ArgumentError` so a future 3rd subject kind fails clean.
  * **L-pers-3.** `Accounts.touch_session/2` uses raw
    `Ecto.Changeset.change/2`, bypassing schema validations. Add
    `Session.touch_changeset/2`.
  * **L-pers-4.** `visitor_channels.visitor_id` redundant single-col
    index: the unique composite already covers the prefix scan. Drop
    the redundant index (write amplification).
  * **L-life-1.** `compute_cooldown/2` `if jitter == 0 do base_ms`
    short-circuit handles `jitter_pct == 0` but `base_ms == 0` only
    incidentally; folded into the already-filed
    `compute_cooldown(0, _)` follow-up.
  * **L-life-2.** `NetworkCircuit.check/1`'s `cast({:cooldown_expire,
    _})` adds GenServer mailbox load on the read hot path — every
    concurrent Login during expiry casts. Bounded by `@threshold` /
    `@cooldown_ms`. Defer; could CAS via
    `:ets.update_element/3` if it bites.
  * **L-life-3.** `Application.start/2` comment block uses `+` for
    indented bullets; cosmetic. `# TODO(phase-5)` would be greppable.
  * **L-life-4.** `Bootstrap.spawn_one/2` and `spawn_visitor/2`
    duplicated retry/skip/log logic — folded into M-life-3.
  * **L-web-1.** `AuthController` 502/504/500/400 emit local
    `send_error/3` envelope; FallbackController owns the snake_case
    envelope. Two emitters of the same body shape — migrate
    `:upstream_unreachable`, `:timeout`, `:malformed_nick`,
    `:anon_collision` to FallbackController-routed `{:error, atom}`.
  * **L-web-2.** `AuthController.format_ip/1` does not handle IPv4-
    mapped IPv6 (returns `'::ffff:1.2.3.4'`). Audit log inconsistency.
  * **L-web-3.** `MembersController.index/2` redundant tuple
    rebinding; replace with a `with` chain delegating to
    FallbackController.
  * **L-web-4.** `Endpoint.@session_options` `signing_salt: "rotate-me"`
    placeholder — Phase 5 hardening; unused today; flag as it wakes
    up the moment session-cookie is wired.
  * **L-cic-1.** `localStorage.setItem(STORAGE_KEY, fresh)` in
    `clientId.ts` runs on every call when localStorage is unavailable
    (private mode quota / disabled). Wrap in try/catch and fall back
    to in-memory.
  * **L-cic-2.** `clientId.ts` doesn't namespace versions — if
    fallback algorithm ever changes, clients carry v4 forever. Add
    a version prefix or schema-version key.
  * **L-cic-3.** Bearer + subject + clientId in localStorage with
    inconsistent dot-vs-dash separator (`grappa-token`,
    `grappa-subject`, `grappa.client_id`). Rename to
    `grappa-client-id`.
  * **L-cic-4.** `Login.tsx:53` `provider: "turnstile" | "hcaptcha"
    | "disabled"` allows "disabled" but `CaptchaChallenge.provider`
    has only two arms — asymmetry; fold into M-cic-1.
  * **L-cic-5.** `Login.tsx:73` captcha-flow login lacks
    `setSubmitting(true)` around `auth.login(...)` — users can
    spam-click during in-flight captcha-callback request.
  * **L-cic-6.** PWA cache bump: confirm `cleanupOutdatedCaches: true`
    + `clientsClaim: true` in `vite.config.ts` so new CSP allowlist
    (Turnstile) is applied.
  * **L-cross-1.** `compose.yaml` (dev) lacks `GRAPPA_CAPTCHA_*` env
    vars — dev/prod divergence; aligns with the `unified-compose`
    memory pin trajectory.
  * **L-cross-2.** `set_network_caps` test "raises when slug unknown"
    pins `Ecto.NoResultsError` propagation — operator sees Ecto
    stacktrace, not friendly error. Same shape as H8.
  * **L-cross-3.** `register-dns.sh` exists, sits 122 LOC, undocumented
    in CLAUDE.md script roster.
  * **L-cross-4.** `lib/grappa/admission.ex:69` hardcodes
    `@default_max_per_client_per_network 1` duplicating
    `config/config.exs:62`. Use
    `Application.compile_env!(:grappa, [:admission,
    :default_max_per_client_per_network])` — crash-loud at compile
    time if config drifts.
  * **L-cross-5.** `superpowers:requesting-code-review` template
    gate-evidence upgrade — STILL OPEN per DESIGN_NOTES T31 follow-up
    list. Confirm in the next session that the upstream user-global
    skill is updated, OR file a concrete ticket. Not a blocker.
  * **L-arch-1.** Subject discriminated union still leaks via
    `Admission.capacity_input` flat `subject_kind`/`subject_id`
    fields — folded into M-arch-5.
  * **L-arch-2.** `check_capacity/1` composes 3 gates with hand-
    written `with` — adding a 4th gate is invasive. Refactor to
    list-based composition (`@gates [&fn1/2, &fn2/2, ...]` +
    reduce). Defer until a 4th gate.
  * **L-arch-3.** `count_live_sessions/1` raw match-spec couples
    Admission to Session's registry-key shape. Add
    `Grappa.Session.count_for_network/1` returning the integer count;
    Admission consumes the verb, not the shape.
  * **L-arch-4.** Three deploy-time bugs share one structural pattern;
    folded into M-arch-6.

---

## Memory pin staleness — proposed updated cluster arc

`~/.claude/projects/-srv-grappa/memory/project_post_p4_1_arc.md`
currently reads:

> text-polish → M2 NickServ-IDP → anon-webirc(+48h sliding scrollback) →
> P4-V; voice deferred behind auth-triangle close

**Stale.** M2 + M3 + M3a were collapsed via the visitor-auth cluster
(CP11 S1–S16) → T30 (visitor REST) → S20 (Backoff hotfix) → T31 P1
+ T31 P2 (admission control + captcha + per-client cap). The auth
triangle is closed.

**Proposed updated arc** (vjt blesses the actual pin update; this is
the recommendation):

  1. **`text-polish polish-deferred` close-out** — lingering UI items
     + iPhone real-device verify. Open since 2026-04-28; ~5 days of
     drift. Cluster size: small. Not blocking.
  2. **T31 follow-up cleanup cluster** (NEW — flagged by this review):
     - `Application.get_env` runtime reads in Admission/Captcha/
       FallbackController eliminated (H1) — boot-time injection
       pattern.
     - User logout WS disconnect (H2).
     - Captcha provider name → wire-token canonicalization via
       `Captcha` behaviour callback (H5 + M-arch-3).
     - `Captcha.SiteVerifyHttp` extraction (M-arch-1).
     - User-facing captcha failure paths (H3, H4, M-cic-4, M-cic-5).
     - `mix grappa.set_network_caps` + tests friendly errors (H8 +
       L-cross-2).
     - `client_id` schema/index/typing rationalization (H9 + M-pers-1
       + M-arch-4).
     - `Networks.update_network_caps/2` clear-cap path (H10).
     - The 6 Plan 2 micro-followups already filed (partial index, DB
       CHECK constraints, `Network.changeset` test rename,
       `compute_cooldown(0, _)` test, NetworkCircuit semantics
       DESIGN_NOTES entry, `superpowers:requesting-code-review`
       template upgrade).
     Estimated: 1–2 cluster sessions. Pure cleanup; new feature
     work blocked behind it would be over-prioritization, but next
     feature cluster should NOT proceed without addressing H1–H7.
  3. **`anon-webirc` + 48h sliding scrollback** — original arc item;
     after WEBIRC config lands on `/srv/irc` testnet (operator task,
     ~30 min, parallel work). External prerequisite.
  4. **Phase 5 hardening** — TLS for grappa.bad.ass (would let UUID
     v4 fallback retire + simplify CSP allowlist), HSM-keyed
     `Cloak.Vault`, Sobelow-strict CI, JSON logger + PromEx exporter.
     Several findings here unblock once TLS lands (UUID v4 fallback
     retirement, CSP `ws:` clause drop).
  5. **P4-V (voice)** — deferred until 1–4 close.

---

## Open follow-ups already filed

These are in the T31 close-out (DESIGN_NOTES line 1526-1543 + plan
files). Reviewer did NOT re-flag them as findings — they're folded
into the T31 follow-up cleanup cluster proposal above:

  * Partial index `where: "client_id IS NOT NULL"` on
    `accounts_sessions.client_id`.
  * DB-level CHECK constraints on `networks.max_concurrent_sessions`
    + `max_per_client`.
  * `Network.changeset` "rejects negative" test name accuracy
    (currently asserts 0, not negative).
  * `NetworkCircuit.compute_cooldown(0, _)` edge-case test +
    setup-block comment.
  * `NetworkCircuit` semantics DESIGN_NOTES entry (lazy expiry +
    window-vs-cooldown independence).
  * `superpowers:requesting-code-review` template — gates RUN, not
    asserted from inspection.

  * **Newly flagged adjacent follow-up** (CP11 S22 PRIVMSG addendum):
    duplicate scrollback row on visitor-side PRIVMSG (single-source
    echo path observed inserting twice). Filed as Plan 2-adjacent;
    needs investigation. Not regressed by T31 — the addendum
    explicitly noted "doesn't affect e2e correctness."

---

## Trajectory

### What did we build in the last N sessions (since CP10 S1, 2026-04-27)?

  * **CP10 S20** — text-polish (UI polish + iPhone verify + ops fixes:
    port-limit, dirty-schedulers, nginx-healthcheck).
  * **CP11 S1–S16** — visitor-auth cluster (29 tasks): visitor schema,
    visitor channels, login/IDENTIFY/REGISTER/+r MODE handling,
    NickServ-as-IDP, Visitors context, Login classifier, Reaper, anon-
    IP cap (later superseded by T31).
  * **CP11 S17** — codebase review (61 findings, 4 CRITICAL).
  * **CP11 S18** — in-cluster remediation (eight commits: H1 sleep
    fix, C1 W11 contract, C2/C3/C4 Subject discriminated union plumb,
    H8 password-leak fix, H14 metadata format).
  * **CP11 S19** — T30 visitor REST surface + e2e GREEN + origin
    pushed.
  * **CP11 S20** — S20 hotfix `Session.Backoff` ETS GenServer
    (azzurra K-line incident; per-(subject, network) reconnect
    backoff that survives `:transient` restart).
  * **CP11 S21** — T31 Plan 1 admission infrastructure.
  * **CP11 S22** — T31 Plan 2 admission integration + captcha widget
    + 3 deploy-time fixes; T31 CLOSED.
  * **CP11 S22 addendum** — PRIVMSG round-trip e2e verified post-
    close.

**Theme:** Closing the post-Phase-4 ops cluster + auth-triangle.
ALL recent work serves this thread coherently.

### Does recent work serve the core mission?

**Yes.** The mission per CLAUDE.md: always-on IRC bouncer + REST + WS
event push + browser PWA + downstream IRCv3 listener facade.

  * Visitor-auth cluster + T30 + T31 = anonymous + ad-hoc users can
    now sign in safely on a public-facing instance, with anti-abuse
    gates that don't break mobile CGNAT users (the design rejected
    per-IP outright).
  * S20 backoff = bouncer survives upstream K-line / flap without
    self-perpetuating restart-rate storms.
  * PRIVMSG round-trip e2e = end-to-end browser → REST → IRC →
    Channels works for fresh anon visitors.

**Infrastructure necessary, served the product, did NOT become the
product.** The architectural cost (T31 follow-up cleanup cluster
described above) is concentrated in the new boundary's hygiene, not
in mission drift.

### What's stalling?

  * **`text-polish polish-deferred`** — open since 2026-04-28
    (~5 days). Worktree `grappa-task-text-polish` retained but
    inactive. Items: lingering UI items + iPhone real-device verify.
    Not technically blocked; deprioritized during the auth-triangle
    push. Bring to LANDED close as cluster #1 after this review.
  * **`p4-v` (voice)** — `grappa-task-p4-v-plan` worktree dormant;
    deferred behind auth-triangle, now also behind T31 cleanup +
    anon-webirc + Phase 5 hardening.
  * **Unified compose** — `project_unified_compose` memory pin notes
    dev/prod compose collapse; dev currently lacks nginx → env
    divergence bites WS/origin behavior. Not blocking but the
    `L-cross-1` finding (dev compose missing captcha env vars) is
    one symptom.

### Risk check

  * **Phase 5 hardening still all-deferred.** TLS, Sobelow-strict,
    PromEx, HSM-keyed Vault. The UUID v4 fallback (cicchetto) only
    exists because of the missing TLS — every browser API that
    requires secure-context is a Phase-5 lever locked behind it.
    The `Endpoint.@session_options.signing_salt: "rotate-me"`
    placeholder is dormant but ready to ricochet on any session-
    cookie wire-up.
  * **`NetworkCircuit` race conditions (H6 + H7).** These are
    architectural — the GenServer mailbox-ordering assumption was
    not verified by the agent test. Not breaking prod today
    (T31 prod conditions don't exercise the race), but they will
    bite under bursty failures + recovery.
  * **`Application.get_env` exception creep (H1).** T31 self-justified
    one exception, landed five. Next contributor cites this as
    precedent. Erodes a CLAUDE.md hard rule. The deploy-bug-1
    post-mortem (DESIGN_NOTES) explicitly names the layering as the
    reason the bug succeeded silently — yet the layering remains.
  * **Captcha-provider name = 5th cross-language enum.** Joins
    `auth_method`, `MessageKind`, error tokens, meta keys, topic
    strings. The Phase 5 codegen story (cicchetto wire-shape →
    server source) now has a 6th concrete target.
  * **User logout doesn't disconnect WS (H2).** Bearer-as-connect-
    credential model holds at connect time, never re-checked. Live
    PubSub pushes survive logout. Not breaking but it IS a security
    boundary leak. Mid-tier severity because tokens are short-lived
    + revoking the bearer prevents NEW connects.

### Recommendation

Close `text-polish polish-deferred` first (small, paperwork). Then
**T31 follow-up cleanup cluster** before opening any new feature
work. The H1–H7 cluster is not breaking prod, but adding a 4th
admission gate / a 3rd circuit-breaker / a 4th captcha provider
without first eliminating the runtime `Application.get_env` reads +
canonicalizing the provider list will compound the drift. The cost
of fixing now is bounded (~one cluster session); the cost of
fixing later scales with each new addition. After T31 cleanup,
return to the original arc: anon-webirc → Phase 5 hardening → P4-V.

The codebase is in good shape. T31 closes a real ops problem and
shipped clean. The findings here are housekeeping, not regression.

---

## Verdict

**YELLOW** — proceed, with focused remediation.

Zero CRITICAL findings. The 12 HIGH findings cluster on T31
architectural drift (5 of them: H1, H5 + folded M-arch-1/3/4) and
captcha frontend correctness (H3, H4) plus two non-T31 issues (H2
user-logout-WS, H12 IRC NUL echo asymmetry — pre-existing).

**Next-step summary for vjt:**

  1. Bless or revise the proposed cluster arc above. Update
     `~/.claude/projects/-srv-grappa/memory/project_post_p4_1_arc.md`
     accordingly.
  2. Decide cluster ordering for the T31 follow-up cleanup —
     single bundled cluster or split (e.g. cleanup-A:
     `Application.get_env` elimination + boundary deps; cleanup-B:
     captcha frontend + provider canonicalization; cleanup-C:
     NetworkCircuit race fixes + match-spec verb).
  3. The DESIGN_NOTES T31 entry's existing follow-up list folds into
     the cleanup cluster — no new memory pin required for the
     follow-ups themselves.
  4. The two non-T31 HIGH (H2 user-logout-WS, H12 IRC NUL echo) can
     ride the cleanup cluster or be filed separately — vjt's call.

Reviewer is HALT'd here per orchestrator handoff §196 ("DO NOT begin
remediation"). Awaiting vjt's direction.
