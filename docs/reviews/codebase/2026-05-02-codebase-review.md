# Codebase Review — 2026-05-02

**Scope:** `cluster/visitor-auth` ff-merged into `main` (delta
`origin/main..main` ≈ 99 commits — Tasks 1–25.5 of
`docs/plans/2026-05-02-visitor-auth.md` plus S16 cicchetto +
IRC.Client hotfixes).

**Method:** Six parallel agents per scope (`irc/`, `persistence/`,
`lifecycle/`, `web/`, `cicchetto/`, `cross-module + infra`) per
`docs/reviewing.md` section 1. PROBLEMS-ONLY format. Findings
deduplicated where multiple agents flagged the same root cause.

**Reviewer:** Codebase review agents dispatched 2026-05-02 in main
session (post-S16 ship-finalize).

## Severity summary

| Module/scope | CRITICAL | HIGH | MEDIUM | LOW |
|--------------|---------:|-----:|-------:|----:|
| irc/ | 0 | 1\* | 1 | 2 |
| persistence/ | 1 | 3\*\* | 5 | 3 |
| lifecycle/ | 0 | 2\* | 4\*\* | 3 |
| web/ | 1 | 4 | 4 | 5 |
| cicchetto/ | 2 | 3 | 11 | 4 |
| cross-module + infra | 0 | 4\* | 4\* | 2 |
| **TOTAL (deduped)** | **4** | **14** | **24** | **19** |

\* = `IRC.Client.Process.sleep` finding flagged by 3 agents (irc/, lifecycle/, cross-module/) — counted once.
\*\* = `Login.login/2 \\ []` default arg flagged by 4 agents (persistence/, lifecycle/, web/, cross-module/) — counted once.

Total deduped: **61 findings** (4 CRITICAL, 14 HIGH, 24 MEDIUM, 19 LOW).

---

## CRITICAL

### C1. `Plugs.Authn` visitor TTL expiry path skips W11 purge contract

**Module:** persistence/ + web/ | **File:** `lib/grappa_web/plugs/authn.ex:93-94`
**Category:** W11 invariant violation / contract drift

The `Visitors` moduledoc (`lib/grappa/visitors.ex:27-29`) names
`Plugs.Authn` as one of three canonical `purge_if_anon/1` call sites
(alongside Login Task 9 preempt and Logout Task 25.5). The expiry
branch in `assign_subject/2` returns `{:error, :expired_visitor}` →
401 but neither calls `Visitors.purge_if_anon/1` nor
`Accounts.revoke_session/1`. The expired anon visitor row + its
`accounts_sessions` row both linger until the Reaper's 60s tick
CASCADEs them. CP11 lines 2888–2947 (Late-S16) treat W11 as
load-bearing — the contract drift is bug-shaped: Reaper-only-cleanup
on the synchronous error path means the bearer-rejection edge can
yield logically-deleted-but-DB-present visitor rows up to a minute,
during which `find_or_provision_anon/3` could trip
`(nick, network_slug)` uniqueness against a tombstone.

**Fix:** In the `:expired` branch, call `Accounts.revoke_session(session.id)`
+ `Visitors.purge_if_anon(visitor_id)` BEFORE returning the error
tuple. If the Reaper-only path is intentional (defensible — Reaper
handles ALL TTL expiry uniformly), update `Visitors` moduledoc to
remove the `Plugs.Authn` callsite claim so the docstring stays
honest.

### C2. `Plugs.ResolveNetwork` crashes (500) for every authenticated visitor session

**Module:** web/ | **File:** `lib/grappa_web/plugs/resolve_network.ex:38`
**Category:** Subject discriminated union not honored / NEW regression

The plug unconditionally reads `conn.assigns.current_user`, set ONLY
for user sessions by `Plugs.Authn`. A visitor with a valid bearer
hitting any `/networks/:network_id/...` route (channels, messages,
members, nick, topic) triggers `KeyError` → Phoenix 500.

CP11 documents this surface as "Task 30 deferred" — but the cluster's
auth pipeline now ACCEPTS visitor bearers and routes them into a
500-crashing plug. PRE-cluster, no visitor type existed, so these
routes returned 401 (correct rejection). POST-cluster, they 500
mid-action (operator-log-noisy stack trace, no observability into
which subject kind hit which route). This is a NEW failure mode the
cluster created — flag it here even though the fix lands in Task 30.

**Fix:** Branch on subject. Either expose `:current_subject = {:user, id} | {:visitor, id}`
from `Plugs.Authn` and rewrite `resolve/2` to dispatch (visitor:
assert `network.slug == visitor.network_slug`, else `:not_found`); OR
add a `defp resolve_for_visitor/2` clause. Same fix applies to the
four downstream controllers (see H10). At minimum, gate the four
controllers' actions with a `defp require_user(conn)` helper that
returns `{:error, :forbidden}` for visitors so the wire surface is a
uniform 403 instead of 500 stack-traces — buys time before Task 30
lands the proper subject-aware controllers.

### C3. cicchetto `getSubject()` does NO schema validation on parsed JSON

**Module:** cicchetto/ | **File:** `cicchetto/src/lib/auth.ts:65-68`
**Category:** TypeScript strictness / wire-shape drift / XSS-adjacent

`JSON.parse(raw) as api.Subject` skips `unknown` narrowing.
localStorage is mutated by the user (devtools), browser extensions,
and any successful XSS. A tampered `{"kind":"user"}` (missing
`id`/`name`) types as `Subject`; consumers reading `subject.name` get
`undefined` typed as `string`. CLAUDE.md mandates `unknown` narrowing
on `JSON.parse`/`fetch` body reads. The cast also silently accepts a
payload whose `kind` is neither `"user"` nor `"visitor"` — TS
exhaustiveness checks downstream pass at compile time and crash at
runtime.

**Fix:** `const parsed = JSON.parse(raw) as unknown;` then a runtime
narrowing predicate: `if (typeof parsed !== "object" || parsed === null || (parsed.kind !== "user" && parsed.kind !== "visitor")) { localStorage.removeItem(SUBJECT_KEY); return null; }`
then narrow per-kind. Same pattern as `api.ts`'s discriminated union
but enforced at the persistence boundary.

### C4. cicchetto visitor sessions never join WS topics — wrong socket-key prefix

**Module:** cicchetto/ | **File:** `cicchetto/src/lib/subscribe.ts:58` and `cicchetto/src/lib/userTopic.ts:34`
**Category:** Wire-shape drift / cross-module assumption

Server-side `UserSocket.assign_subject/2`
(`lib/grappa_web/channels/user_socket.ex:82`) sets
`socket.assigns.user_name = "visitor:" <> visitor.id` and
`GrappaChannel.authorize/2` checks `Topic.user_of(parsed) ==
socket.assigns.user_name`. cicchetto builds the topic via
`joinChannel(u.name, slug, ch.name)` →
`grappa:user:${userName}/network:...`, where `u` comes from
`MeResponse` (the User.name shape, never `"visitor:<uuid>"`).

For a visitor session, even if `/me` worked (it doesn't — see C2 +
H8), `u.name` would be `Visitor.nick`, not the prefixed visitor id.
`GrappaChannel.authorize/2` returns `forbidden` and the visitor never
receives any WS event. This is an UNDERLYING root cause of the "no
networks sidebar for visitors" symptom CP11 ascribed to Task 30 — but
cicchetto's TS code has NO branch on `subject.kind` to construct the
right topic prefix. Fixing Task 30's server-side controllers without
fixing this leaves visitors silent.

**Fix:** Replace `u.name` with a derived `socketUserName` mirroring
`UserSocket.assign_subject/2`: `getSubject()?.kind === "visitor" ? "visitor:" + subject.id : user().name`.
Centralise in `auth.ts` (export `socketUserName()`) so both
`subscribe.ts` and `userTopic.ts` consume the same accessor — same
verb, shared noun. This unblocks half the Task 30 work and is
independent of the server-side `/me` patch (H8).

---

## HIGH

### H1. `IRC.Client.handle_continue` blocks GenServer mailbox on connect-fail throttle

**Module:** irc/ + lifecycle/ + cross-module/ (deduped from 3 agents) | **File:** `lib/grappa/irc/client.ex:275`
**Category:** OTP misuse / `Process.sleep` inside callback

The connect-failure path runs `Process.sleep(@connect_failure_sleep_ms)`
(default 30s prod) inline before `{:stop, ...}`. CLAUDE.md OTP rule
"blocking work in `init/1` without `{:continue, _}` freezes the
parent supervisor" applies the same hazard to `handle_continue/2` —
even though the supervisor isn't formally serialized, the linked
Session.Server is held captive. During the 30s sleep:
1. Operator-issued `DynamicSupervisor.terminate_child` (the
   documented S16 mitigation) waits up to 30s per child instead of
   being prompt — 3 sessions = 90s.
2. Linked Session.Server sits idle; any `GenServer.call(session, ...)`
   blocks for the call timeout (5s default).
3. Module-attribute ordering bug-class: `@connect_failure_sleep_ms`
   MUST be defined before `handle_continue/2` references it
   (`Process.sleep(nil)` → FunctionClauseError — recurring CP11
   vigilance item).

The hotfix is documented and the proper Phase-5 backoff is captured
in `docs/todo.md:230` ("Reconnect/backoff policy when upstream IRC
drops"). Flag here for visibility; the band-aid is acceptable
short-term but the operator-friction it caused during S16 mitigation
warrants a non-blocking-throttle interim patch.

**Fix:** Convert to deferred-`{:stop, ...}` pattern: schedule a
`Process.send_after(self(), :connect_failed_giveup, @connect_failure_sleep_ms)`
+ `{:noreply, %{state | connect_failed_reason: reason}}`; handle
`:connect_failed_giveup` info with `{:stop, {:connect_failed,
reason}, state}`. Cancel timer in any new `terminate/2` if parent
terminates child early. Captures the throttle without holding the
mailbox hostage. (Phase 5 backoff replaces this entirely; this fix is
one screen of code now.)

### H2. `find_or_provision_anon/3` race-loser surfaces `Ecto.Changeset.t()` outside spec

**Module:** persistence/ | **File:** `lib/grappa/visitors.ex:78-94` and `lib/grappa/visitors/login.ex:78-88`
**Category:** spec violation / race handling

Two concurrent `POST /auth/login` requests with the same nick both
`Repo.get_by` → nil → `create_anon` → second `Repo.insert` trips the
`(nick, network_slug)` unique constraint and returns `{:error,
%Ecto.Changeset{}}`. `Login.dispatch(nil, ...)` propagates that via
`with`. `login_error()` enumerates 9 atoms — `Ecto.Changeset.t()` is
not one of them, so the spec is violated.
`AuthController.visitor_error_response/3` falls through to the
catchall and returns 500. Compare `Networks.find_or_create_network/1:53-75`
which deliberately retries `Repo.get_by` after a changeset error to
recover the race-loser cleanly.

**Fix:** Mirror the `find_or_create_network/1` race-recovery pattern
in `find_or_provision_anon/3`: on `{:error, %Ecto.Changeset{}}`,
retry `Repo.get_by(Visitor, nick: nick, network_slug: slug)` once;
return the row if present, else surface the changeset. Collapses the
race into idempotent `{:ok, Visitor.t()}` and keeps `login_error()`
honest.

### H3. `Visitors.Login.login/2` `\\ []` default arg — CLAUDE.md violation

**Module:** persistence/ + lifecycle/ + web/ + cross-module/ (deduped from 4 agents) | **File:** `lib/grappa/visitors/login.ex:99`
**Category:** CLAUDE.md "no default arguments via `\\`"

`def login(%{...} = input, opts \\ [])`. The `opts` default exists
solely so test paths can shrink the 8s timeout via
`:login_timeout_ms`. CLAUDE.md "Code-shape rules" bans `\\` defaults
except for "genuine config defaults where the default is the correct
production behavior" — and forbids weakening production code for
tests ("Never weaken production code to make tests pass"). The two
callers (`AuthController.visitor_login/3` passes `[]`, tests pass
`[login_timeout_ms: …]`) can both pass the keyword list explicitly.
This is the LONE remaining `\\` default in `lib/`.

**Fix:** Remove the default. `AuthController.visitor_login/3` already
passes `Login.login(input, [])` (explicit). Update any test that
relied on the default. Brings `lib/` to ZERO `\\` defaults — total
consistency.

### H4. `Visitors.delete/1` wipes registered visitors via Reaper TTL — semantic gap with `purge_if_anon` docstring

**Module:** persistence/ | **File:** `lib/grappa/visitors.ex:201-211` (consumed by `lib/grappa/visitors/reaper.ex:63`)
**Category:** lifecycle invariant ambiguity

`purge_if_anon/1`'s docstring (`visitors.ex:251-263`) promises:
"Registered visitor (`password_encrypted` set): no-op, the NickServ-password identity persists across logouts."
But `Reaper.sweep/0` enumerates `Visitors.list_expired/0` (which
includes registered visitors past their 7d TTL) and calls
`Visitors.delete/1` — which unconditionally `Repo.delete`s the row
regardless of `password_encrypted`. So a registered visitor going
idle for >7d (no `touch/1` activity) is fully wiped including their
stored NickServ password, contradicting the "persists across logouts"
promise as a user would read it.

**Fix:** Either (a) extend `Reaper`/`Visitors.delete` to respect the
anon-vs-registered distinction (registered get longer TTL or separate
cleanup, anons get the 48h sweep) or (b) tighten `purge_if_anon/1`'s
docstring to explicitly state "registered identity persists across
LOGOUTS only — TTL expiry still wipes the row including the
password." Pick one; current shape lets the reader assume password
durability that doesn't exist.

### H5. `Visitors.Reaper.sweep/0` unsynchronized between manual callers and the GenServer tick

**Module:** lifecycle/ | **File:** `lib/grappa/visitors/reaper.ex:58-76`
**Category:** OTP misuse / use infrastructure don't bypass it

`sweep/0` is a public module-level function — it does NOT call into
the GenServer; it talks to `Repo` directly. The Reaper GenServer
calls `sweep()` on its `:tick`. An operator (or a future REST/admin
endpoint) calling `Reaper.sweep()` from any other process can race
the tick — both call `Visitors.delete(v.id)` for the same row; the
loser gets `{:error, :not_found}` and `Logger.error("reaper delete
failed", error: :not_found)` even though the other path succeeded.
False-error log noise + observability drift.

**Fix:** Make `sweep/0` a `GenServer.call(__MODULE__, :sweep)` (or
`:sync_sweep`) so all sweeps go through the mailbox and serialize.
Move actual logic to `do_sweep/0` private. Tests that need
synchronous sweep stay clean (`start_supervised!({Reaper, ...})`
already starts the GenServer). Fixes the race AND restores "one path
through every door".

### H6. `Visitors.Reaper` started under `:permanent` — wrong restart strategy + missing `trap_exit`

**Module:** lifecycle/ | **File:** `lib/grappa/visitors/reaper.ex:35`
**Category:** OTP misuse / restart strategy

`use GenServer` defaults `restart: :permanent`. Reaper is best-effort
cleanup — if it crashes, the next boot/tick catches up since
`list_expired/0` is time-bound. CLAUDE.md: "`:permanent` for
infrastructure (Repo, Endpoint, PubSub)." Reaper is NOT infrastructure
on the same tier. A bug in `Visitors.delete/1` triggering per-tick
crash hits the application supervisor's restart budget (default
`max_restarts: 3` over 5s) and brings DOWN THE WHOLE APP — even
though a 60s-cadence sweep crashing is recoverable by skipping a tick.

Combined with no `Process.flag(:trap_exit, true)` + no `terminate/2`
cleanup, an in-flight `Repo` query during shutdown gets killed
mid-flight.

**Fix:** `use GenServer, restart: :transient`. Document the choice in
moduledoc ("Reaper is best-effort; crashes are skip-this-tick events,
not data-loss events").

### H7. `MessagesController.create` and 4 sibling controllers crash (500) for visitors — Task 30 surface, NEW regression

**Module:** web/ | **File:** `lib/grappa_web/controllers/messages_controller.ex:105` (also `index/2:67`)
**Category:** Subject discriminated union not consumed / NEW regression

`user_id = conn.assigns.current_user_id` raises `KeyError` for a
visitor session. Same pattern in `ChannelsController` (lines
68/119/145/169), `MembersController:37`, `NickController:27`,
`NetworksController:24`, `MeController:17`. CP11 lists this as "Task
30 deferred (5 controllers)" — confirming the inventory.

NEW regression class introduced by this cluster: pre-cluster these
would 401 (no visitor type existed); post-cluster they 500 mid-action
because the `:authn` pipeline accepts the bearer. Same root cause as
C2 but at the controller layer instead of the plug.

**Fix:** Per Task 30 plan in `docs/plans/2026-05-02-visitor-auth.md` —
branch on a `current_subject` assigns key. Until then, gate the
actions with a `defp require_user(conn)` helper that returns
`{:error, :forbidden}` for visitors so the wire surface is uniform
403 instead of stack-trace 500.

### H8. `auth_controller.ex` IDENTIFY-failure log line risks NickServ password leakage

**Module:** web/ (cluster code path) | **File:** `lib/grappa/visitors/login.ex:227-230`
**Category:** Security / log hygiene

`send_post_login_identify` logs `reason: inspect(reason)` on
`Session.send_privmsg` failure. The PRIVMSG body contains
`"IDENTIFY " <> password`. Many `:invalid_line` / changeset error
tags include the offending `body` field — `inspect/1` of an
`Ecto.Changeset` walking changes will print `body: "IDENTIFY
<plaintext>"` to stdout. The Phoenix `:filter_parameters` allowlist
filters request params only; it does NOT filter `Logger.warning/2`
metadata or messages.

**Fix:** Either (a) sanitise the reason before logging —
`Logger.warning("post-login IDENTIFY failed", visitor_id:
visitor.id, reason: error_tag(reason))` where `error_tag/1` returns
only the atom tag — or (b) document the audited tags in the `@spec`
of `Session.send_privmsg/4` and assert no body bytes in any
`{:error, _}` shape. Currently the only protection is "no error path
leaks the body today" — brittle invariant for credentials handling.

### H9. `auth_controller.ex` bypasses `FallbackController` 401/error envelope

**Module:** web/ | **File:** `lib/grappa_web/controllers/auth_controller.ex:184-186`
**Category:** Wire-shape consistency / leaky abstraction

`send_error/3` open-codes `conn |> put_status(s) |> json(%{error:
code})` for 7 different visitor-error tags + `mode1_login`'s
`invalid_credentials` (line 104). The cluster's own
`FallbackController` already standardizes `%{error: "<snake_case>"}`
for `:bad_request`, `:invalid_credentials`, `:unauthorized`, etc. The
`mode1_login` call returning a bare `Plug.Conn.t()` cannot leverage
`action_fallback`, so login is structurally locked into the bypass.
Identical wire bytes today but the convention enshrined in
`FallbackController`'s moduledoc was sidestepped — adding a new
visitor error tag now requires editing two emitters.

**Fix:** Refactor `login/2` + private branches to return `{:error,
atom_tag}` and let `action_fallback GrappaWeb.FallbackController`
render. Add `:malformed_nick`, `:password_required`,
`:password_mismatch`, `:ip_cap_exceeded`, `:upstream_unreachable`,
`:timeout` to `FallbackController.call/2` clauses + spec union. The
`:anon_collision` case (which needs `Retry-After`) can still set the
header in the controller before returning the tag.

### H10. Bearer extraction duplicated across `auth_controller.ex` + `Plugs.Authn`

**Module:** web/ | **File:** `lib/grappa_web/controllers/auth_controller.ex:188-193` and `lib/grappa_web/plugs/authn.ex:106-111`
**Category:** Duplication / leaky abstraction

Two identical `["Bearer " <> token] when token != ""` extractors.
CLAUDE.md "Implement once, reuse everywhere": if the case-3 anon
token-rotation path (Task 13/W13) needs the bearer at the
`/auth/login` door (which is OUTSIDE `:authn`), the extraction
primitive belongs as a public helper on `Plugs.Authn` (or a sibling
`GrappaWeb.Plugs.Bearer` module) shared by both call sites. Drift
risk: tomorrow someone tightens `Plugs.Authn`'s parser (e.g. trim,
case-insensitive scheme) and the auth-controller copy silently
disagrees.

**Fix:** Extract to `GrappaWeb.Plugs.Authn.extract_bearer(conn) ::
{:ok, String.t()} | :error` and consume from both sites.

### H11. cicchetto `MeResponse` type has no visitor variant

**Module:** cicchetto/ | **File:** `cicchetto/src/lib/api.ts:28-32`
**Category:** Wire-shape drift / discriminated-union miss

Server-side `MeController.show/2` reads `conn.assigns.current_user`
unconditionally — for visitor sessions only `:current_visitor` is
assigned, so the controller crashes with `KeyError` → 500 (this is
H7's `MeController:17` finding from another angle). cicchetto's
`MeResponse = {id, name, inserted_at}` mirrors only the user-side
shape. Even after the server is fixed (Task 30 follow-up), cicchetto's
type must mirror the discriminated union from `Subject` (`{kind:
"user"|"visitor", ...}`). Today every visitor login leaves the bearer
in localStorage, then `/me` 500s and `subscribe.ts`'s effect never
fires (the `if (!t || !u) return` short-circuit holds forever because
`user()` stays `undefined`). User-visible symptom: empty sidebar +
zero WS activity.

**Fix:** Coordinate with the server-side `MeController` patch (Task
30): make `/me` return the discriminated union (mirror
`AuthJSON.subject_wire`), update `MeResponse` here to match. In the
meantime, gate `me()` on `getSubject()?.kind === "user"` so visitor
tokens don't request the broken endpoint.

### H12. cicchetto `userTopic.ts` `joined` flag never resets on token rotation

**Module:** cicchetto/ | **File:** `cicchetto/src/lib/userTopic.ts:23-41`
**Category:** OTP/reactivity — identity-scoped state regression

Every other store in the post-A4 split has `on(token, ...)` cleanup
arm that resets module-singleton state on identity transition (see
`scrollback.ts:46-53`, `selection.ts:33-40`, `members.ts:41-48`,
`mentions.ts:21-25`, `subscribe.ts:42-48`). `userTopic.ts` does not —
`let joined = false` is captured by the closure but never re-set on
`token` rotation. After logout-then-login (or token rotate), the
effect re-runs against the new identity, sees `joined === true` from
the prior identity, returns early. The user-topic listener for
`channels_changed` is wired to the OLD identity's Phoenix channel
(dropped by socket.ts's force-reconnect), never to the new one.
New-identity `channels_changed` events fire into the void; sidebar
stays stale until full page reload.

**Fix:** Add the same `createEffect(on(token, (t, prev) => { if (prev != null && t !== prev) joined = false; }))`
pattern. Since this is the documented A1/C7 invariant, consider
extracting a shared helper in `lib/identityScope.ts` so the next
store doesn't drift again.

### H13. cicchetto `Login.tsx` error mapping doesn't surface visitor-side error codes

**Module:** cicchetto/ | **File:** `cicchetto/src/Login.tsx:36-40`
**Category:** Wire-shape drift / UX

`AuthController` returns 7+ visitor-side error codes
(`malformed_nick`, `password_required`, `password_mismatch`,
`ip_cap_exceeded`, `anon_collision`, `upstream_unreachable`,
`timeout`) plus user-side `invalid_credentials`. Login.tsx only
special-cases `invalid_credentials`; everything else falls through to
`err.message`, which for ApiError is `"${status} ${code}"` —
e.g. `"429 ip_cap_exceeded"` to the end user. The `409 anon_collision`
case also carries a `Retry-After` header that cicchetto throws away.
Mode-2 visitor flow ergonomics broken.

**Fix:** Switch on `err.code` exhaustively (with `assertNever`
default) producing a friendly string per code; for `anon_collision`
also read the response header (extend ApiError to carry headers).
Coordinate messaging strings with the server's error allowlist —
same closed-set-as-atom rule from CLAUDE.md applied to wire tokens.

### H14. Dev console drops structured Logger metadata (`$metadata` missing from format)

**Module:** cross-module/ | **File:** `config/dev.exs:28`
**Category:** logging / observability — contradicts memory pin `project_logging_format.md`

`config/dev.exs:28` overrides the global console formatter to
`format: "[$level] $message\n"`. The base `config/config.exs:57-117`
defines `format: "$time $metadata[$level] $message\n"` plus a 30-key
`:metadata` allowlist. Because Elixir Config merges last-wins per
key, dev.exs's bare `format:` wins and `$metadata` is silently
dropped from EVERY dev log line. All structured-KV calls
(`Logger.info("session started", user: id, network: slug)`) print as
`[info] session started` in dev, hiding every operator-debugging
field.

The memory pin (`project_logging_format.md`) promises: "The KV shape
survives the format swap." Promise broken in dev. This also explains
why two patches (Login.ex:228, Accounts.ex:269) fall back to inline
`visitor_id=#{id}` interpolation — developers under dev couldn't see
the KV form work.

**Fix:** Change `config/dev.exs:28` to `format: "$time $metadata[$level] $message\n"`
matching base, OR delete the line entirely (defaults inherit from
`config/config.exs`). Then audit Login.ex:228 + Accounts.ex:269 to
drop the inline interpolation and use KV (visitor_id is already in
the allowlist).

---

## MEDIUM

### M1. `IRC.Parser` `String.upcase/1` for command normalization mishandles non-ASCII

**Module:** irc/ | **File:** `lib/grappa/irc/parser.ex:162`
`String.upcase(raw)` then matches `@known_commands`. RFC 2812 §2.3
defines commands as ASCII letters; `String.upcase/1` on multi-byte
UTF-8 silently accepts e.g. `"privmsg\xff"` as `{:unknown,
"PRIVMSG\xff"}` rather than rejecting an obviously-malformed
command. Closed-set boundary not defended.
**Fix:** Either restrict command to ASCII letters by guard (`<<c, _::binary>> when c in ?A..?Z or c in ?a..?z`)
rejecting otherwise with `{:error, :no_command}`, or use
`String.upcase(raw, :ascii)` (Elixir 1.13+).

### M2. `Visitor.password_encrypted` field name actively misleads at every read site

**Module:** persistence/ | **File:** `lib/grappa/visitors/visitor.ex:49`, `lib/grappa/visitors/login.ex:181-188`, `lib/grappa/visitors/session_plan.ex:83-100`
After Cloak's `:load` callback, `visitor.password_encrypted` carries
**plaintext**. `Login.check_password/2:181` matches `is_binary(encrypted)`
and feeds the value to `Plug.Crypto.secure_compare/2` — the variable
name suggests ciphertext, but comparison is plaintext-vs-plaintext.
`Networks.Credential` solved the same trap with `Credential.upstream_password/1`
accessor (`credential.ex:230-231`). `Visitors.Visitor` lacks both
accessor and explicit warning.
**Fix:** Add `Visitor.upstream_password/1` mirroring the Credential
pattern. Update `Login.check_password/2` and `SessionPlan.build_plan/3`
to use it.

### M3. `visitor_channels.network_slug` duplicates `Visitor.network_slug` with no FK

**Module:** persistence/ | **File:** `lib/grappa/visitors/visitor_channel.ex:32`, migration `priv/repo/migrations/20260502080806_create_visitor_channels.exs:8`
`Visitor.network_slug` is fixed at row creation. Every
`VisitorChannel` for that visitor MUST carry the same slug — already
implied by `belongs_to :visitor`. Storing redundantly creates a drift
surface: no schema validation that
`visitor_channel.network_slug == visitor.network_slug` and no DB
constraint. CLAUDE.md "Don't duplicate state that already exists —
derive it. Every parallel structure needs housekeeping that will drift."
**Fix:** Drop the column (slug derivable via `visitor` join). If kept
for query-without-join performance, add changeset validation +
DB-level CHECK or trigger.

### M4. Migrations 20260502085339 + 20260502100316 use raw SQL DDL bypassing Ecto.Migration DSL

**Module:** persistence/ | **File:** `priv/repo/migrations/20260502085339_add_visitor_id_to_messages.exs:33-67` (also `20260502100316:21-46`)
CLAUDE.md "Runtime Data": "Never apply DDL manually via raw SQL.
Always Ecto.Migration so `schema_migrations` stays in sync." Both
migrations use `execute("CREATE TABLE ...")` / `execute("ALTER TABLE
... RENAME ...")` to work around `ecto_sqlite3`'s lack of `modify` +
`create constraint` support. `schema_migrations` tracks WHICH
migrations ran, not WHAT they did, so technically tracked — but the
rule's intent (DSL → portable + reversible + greppable) is violated.
The CHECK constraint cannot be expressed via DSL for sqlite, but
table re-creation could.
**Fix:** Either (a) document an explicit exception to the CLAUDE.md
rule for sqlite ALTER-TABLE-recreate migrations (with engineering
rationale spelled out), or (b) refactor to use `Ecto.Migration.create
table(...)` for the new table shape and limit `execute/1` to the
CHECK clause + the row-copy `INSERT...SELECT`.

### M5. `Visitors.Login.@max_per_ip` `compile_env/3` default value masks missing config

**Module:** persistence/ | **File:** `lib/grappa/visitors/login.ex:65`
`@max_per_ip Application.compile_env(:grappa, :max_visitors_per_ip, 5)`
uses the third-arg default `5`. Memory pin
`feedback_dialyzer_plt_staleness` notes "defaults belong in
`config/config.exs` not just `test.exs`" — relying on `compile_env`
defaults at the read site means the value is invisible from
`config/*.exs` greps. Compare `@visitor_network` (line 64) which has
no default → forces `config/*.exs` to declare it explicitly. The W3
cap is load-bearing for per-IP defense.
**Fix:** Drop the `5` default. Force the value to live in
`config/config.exs` (prod=5) and `config/test.exs` (test=2) explicitly.

### M6. `find_or_provision_anon/3` skips per-IP cap check — relies on caller composition

**Module:** persistence/ | **File:** `lib/grappa/visitors.ex:80-86`
Moduledoc admits: "Per-IP cap enforcement is the caller's
responsibility." Today `Visitors.Login` is sole caller and does call
`check_ip_cap/1` first. But `find_or_provision_anon/3` is exported on
public Visitors surface — any future caller (mix task, internal flow)
that forgets to compose `count_active_for_ip/1` first silently
bypasses the W3 cap. CLAUDE.md "Use infrastructure, don't bypass it"
+ W3 is a security boundary, not a perf knob.
**Fix:** Move per-IP cap check INTO `find_or_provision_anon/3` so the
cap is enforced at the admission boundary regardless of caller.
Caller (`Login`) becomes thin pass-through. Cap-bypass operator path
gets a separate explicit verb (`find_or_provision_anon_unchecked/3`).

### M7. `Mix.Tasks.Grappa.Boot.start_app_silent/0` collides with live release Endpoint on port 4000

**Module:** lifecycle/ | **File:** `lib/mix/tasks/grappa/boot.ex:42-49`
CP11 (lines 2881-2886) flags this as known doc gap. The function
unconditionally calls `Application.ensure_all_started(:grappa)` which
boots `GrappaWeb.Endpoint`. Any mix-task invocation against a LIVE
running release via `docker compose exec grappa mix grappa.create_user
...` will EADDRINUSE on port 4000. Required workflow: `docker
compose run --rm grappa bin/grappa eval ...` (oneshot). Moduledoc
explains bootstrap suppression but says nothing about Endpoint
collision.
**Fix:** Add moduledoc note + paragraph in function `@doc`:
"WARNING: this task starts the full :grappa app including
`GrappaWeb.Endpoint`. Do NOT run via `docker compose exec` against a
live release. Use `docker compose run --rm grappa bin/grappa eval
'Mix.Tasks.Grappa.<TaskName>.run([...])'` (oneshot) instead."
Optionally probe `:gen_tcp.connect/3` against `127.0.0.1:#{port}`
first and `Mix.raise/1` with the suggested invocation.

### M8. `Bootstrap.run/0` does NOT preload `:network` for visitors — N+1 boot queries

**Module:** lifecycle/ | **File:** `lib/grappa/bootstrap.ex:184-205`
Every active visitor row triggers separate `Networks.get_network_by_slug(slug)`
call. Bounded by distinct visitor networks (currently 1, design plans
multiple). `spawn_visitors/0` then calls `Networks.get_network_by_slug(plan.network_slug)`
AGAIN inside `spawn_visitor/2` (line 225) for every single visitor —
`VisitorSessionPlan.resolve/1` already loaded the network internally.
Redundant DB read per visitor.
**Fix:** Hoist a `slug → network_id` map from one query before the
loop, pass through `spawn_visitor/3`. Have `VisitorSessionPlan.resolve/1`
return `{:ok, plan, network}` so caller doesn't re-fetch.

### M9. `Bootstrap.validate_visitor_networks!/0` raises and restart-loops the entire app supervisor

**Module:** lifecycle/ | **File:** `lib/grappa/bootstrap.ex:194-204`
`Bootstrap` is `use Task, restart: :transient`. `validate_visitor_networks!/0`
raises on orphans; Task restarts up to supervisor's `max_restarts: 3`
over 5s; each restart re-runs same query, gets same orphans, raises;
on 4th the entire application supervisor exits, taking running web
surface DOWN — operator loses running grappa to a config-state issue
that should be a DEGRADED-but-RUNNING bouncer ("orphan visitors
known, web up").
Moduledoc itself says (lines 31-39): "**Failure modes — boot web-only,
never crash the app**" — validation contradicts documented invariant.
**Fix:** Convert `validate_visitor_networks!/0` to `Logger.error("orphan
visitors detected: ...")` + SKIP those visitors in `spawn_visitors/0`
(filter `Visitors.list_active()` by "slug resolves to a Network row").
Bouncer comes up web-only; orphans documented in log; operator runs
`mix grappa.reap_visitors` at leisure. Mirrors `Bootstrap.run/0`'s
"best-effort" credential path — same shape for both subjects.

### M10. `:visitor_network` slug is the prod slug `"azzurra"` in test config too — drift surface

**Module:** lifecycle/ | **File:** `config/test.exs:38` + `config/config.exs:17`
Both files set `:visitor_network` to `"azzurra"`. PROD network is
azzurra; tests use a fixture also called "azzurra". A future test
creating a fixture with a different name and forgetting to override
`:visitor_network` lets `Login.visitor_network/0` fall back to the
production-slug-named-fixture and tests pass for the wrong reason.
**Fix:** Change `config/test.exs` `:visitor_network` to a test-only
sentinel slug (e.g., `"test-network"`). Update `Grappa.AuthFixtures`
to default `network_with_server/1` to that slug.

### M11. `auth_controller.logout/2` — `revoke_session` after `purge_if_anon` is dead-write + misleading audit log

**Module:** web/ | **File:** `lib/grappa_web/controllers/auth_controller.ex:74-78`
For anon visitors, ordering is: `stop_session` → `purge_if_anon`
(deletes visitor row, CASCADE wipes `accounts_sessions` row via
`sessions_visitor_id_fkey ON DELETE CASCADE`) → `revoke_session(current_session_id)`
finds zero rows and logs `"session revoked" affected: 0`. Every
anon-visitor logout writes a misleading audit line. Registered
visitors hit `purge_if_anon` no-op so revoke does work — operator
can't distinguish either case from log.
**Fix:** Either (a) skip `revoke_session` on anon-visitor branch
since CASCADE handles it, or (b) reorder revoke-then-purge (revoke
first finds 1 affected, then purge cascades — accurate audit trail).

### M12. `Visitors.touch/1` on every authenticated REST request — silent DB write pressure

**Module:** web/ | **File:** `lib/grappa_web/plugs/authn.ex:84` (and `user_socket.ex:78`)
Plug calls `Visitors.touch(visitor_id)` synchronously on EVERY
visitor-authenticated request + every socket connect. The 1h cadence
gate is enforced inside `Visitors.touch/1:152` (`maybe_bump`) — but
only AFTER unconditional `Repo.get(Visitor, visitor_id)` (line 130).
Every visitor request does extra SELECT even when no UPDATE happens.
For chatty REST clients (cicchetto polls `/me`, `/networks`,
`/networks/:n/channels`, `/networks/:n/channels/:c/members` on focus),
doubles per-request DB round-trip count for visitor sessions.
**Fix:** Either (a) move cadence gate to fast in-process check (ETS
counter keyed by visitor_id with last-touch wall time) so SELECT is
skipped under cadence threshold, or (b) batch via Telemetry. Document
in `Visitors.touch/1` moduledoc which path the cadence gate runs on.

### M13. `format_ip` / `user_agent` helpers belong on shared `GrappaWeb.RequestContext`

**Module:** web/ | **File:** `lib/grappa_web/controllers/auth_controller.ex:195-205`
Both helpers private to `auth_controller`. Phase 5 X-Forwarded-For /
trusted-proxy work (called out at moduledoc line 18) will need IP
resolution at every authenticated entry point — Plugs.Authn,
UserSocket, future audit log emitter. Hardcoding in login controller
orphans future trusted-proxy logic.
**Fix:** Promote to `GrappaWeb.RequestContext` (or
`GrappaWeb.Plugs.RemoteIp` plug that assigns `:remote_ip` once per
conn). Phase 5 hardening then has single landing site.

### M14. `MeController` does not return Visitor profile despite visitor sessions existing

**Module:** web/ | **File:** `lib/grappa_web/controllers/me_controller.ex:17`
`render(conn, :show, user: conn.assigns.current_user)` raises
`KeyError` for visitor (Task 30 surface — same root cause as H7).
Beyond the 500, `GET /me` is the canonical "who am I" door — for
visitors it should return `{kind: "visitor", id, nick, network_slug,
expires_at}`. Cicchetto can't render a visitor's name/expiry without
it. The `AuthJSON.login` response carries it on initial login but
`/me` is what the SPA hits on rehydrate (paired with H11 client-side).
**Fix:** Per Task 30 Step 30.5 — branch on subject assign and add
`MeJSON.show(%{visitor: ...})` clause.

### M15. cicchetto `auth.ts` registers 401 handler as module-load side-effect

**Module:** cicchetto/ | **File:** `cicchetto/src/lib/auth.ts:51`
`api.setOn401Handler(() => setToken(null))` runs at top level. In
tests calling `vi.resetModules()` and re-importing auth, the api
module is also reset — handler is null until auth re-imports api.
Order-of-import dependence is brittle. Impossible to opt-out the
handler in a test asserting raw 401 behaviour. Module-load side-effect
hides the dependency.
**Fix:** Export `installAuthHandlers()` from auth.ts, call once from
`main.tsx` before `render()`. Symmetric with `applyTheme()` — both
boot-time side effects, both should be explicit.

### M16. cicchetto `socket.ts` token-rotation drops socket then immediately reconnects without awaiting close

**Module:** cicchetto/ | **File:** `cicchetto/src/lib/socket.ts:56-65`
phoenix.js `Socket.disconnect(callback?, code?, reason?)` — callback
fires when close frame is acked. cicchetto calls `s.disconnect(); s.connect();`
synchronously. On slow link the open-frame for new connection can
race the still-in-flight close; phoenix.js handles gracefully but
joined-channel `phx_close` events arrive AFTER new `connect()`
started. Test only verifies counts, not ordering.
**Fix:** Pass callback to disconnect: `s.disconnect(() => s.connect());`.
Update test to assert connect happens AFTER disconnect callback.

### M17. cicchetto `localStorage.setItem` lacks try/catch — Safari Private Browsing throws

**Module:** cicchetto/ | **File:** `cicchetto/src/lib/auth.ts:39-41`, `61`, `theme.ts:55-60`
`localStorage.setItem` throws `QuotaExceededError` in iOS Safari
Private Browsing and embedded webview contexts. cicchetto's iOS PWA
story is explicit (S45 in DESIGN_NOTES). Login flow crashing on
localStorage write leaves UI indeterminate (token signal updated,
persistence failed).
**Fix:** Wrap each `setItem` in try/catch; on failure log via
structured channel + still update in-memory signal (degrade to
session-only auth). Same for SUBJECT_KEY + theme writes.

### M18. cicchetto `MembersPane` once-per-channel gate means stale member list never refreshes within a session

**Module:** cicchetto/ | **File:** `cicchetto/src/lib/members.ts:54-65`, `MembersPane.tsx:30-32`
`loadedChannels` Set prevents refetching `GET /members` for a channel
within a single bearer scope. NAMES-class drift (server-side bug,
missed JOIN, missed PART, mode change while disconnected from WS)
never reconciled until bearer rotates. WS-delivered deltas via
`applyPresenceEvent` cover known events but assume WS is perfect log
— it isn't (no `:resume` epoch sequencing yet).
**Fix:** Either expose `forceRefreshMembers(slug, name)` for Phase 5
manual refresh, invalidate `loadedChannels` entry on re-select after
N seconds, OR document acceptance + add Phase 5 reconciliation TODO.
Same problem in `scrollback.ts` `loadedChannels`.

### M19. cicchetto `subscribe.ts` shadows `u` (outer = `user()`, inner = `untrack(user)`)

**Module:** cicchetto/ | **File:** `cicchetto/src/lib/subscribe.ts:51,81`
Same identifier `u` rebound inside closure for `if (mentionsUser(...))`.
Outer `u` already in scope; nested `untrack(user)` taken to avoid
tracking. Shadowing makes reactivity contract opaque.
**Fix:** Rename inner to `currentUser` (or skip the rebind — outer
`u` already non-tracked because the effect already tracks `user()`
at line 51).

### M20. cicchetto `tabComplete` reads `membersByChannel()` outside tracked context — non-deterministic under store mutations

**Module:** cicchetto/ | **File:** `cicchetto/src/lib/compose.ts:201-243`
Called from `Shell.tsx`'s `cycleNickComplete` keybinding handler
(NOT a Solid tracked context). Reading `membersByChannel()` returns
value at moment of keypress — correct — but if cycle is in progress
and JOIN/PART arrives between Tab presses, matches list rebuilds from
different snapshot, breaking cycle's index. Edge case (nick-cycling
during netjoin behaves erratically).
**Fix:** Snapshot matches list inside cycle anchor (carry `matches:
string[]` instead of `idx: number`).

### M21. cicchetto ARIA / a11y gaps — focus management on drawer open, no `aria-modal`, hamburger emoji w/o text alt

**Module:** cicchetto/ | **File:** `cicchetto/src/Shell.tsx:142-203`, `SettingsDrawer.tsx:43-48`, `TopicBar.tsx:33-60`
- `<aside class="settings-drawer" role="dialog" aria-label="settings">` lacks `aria-modal="true"` — screen readers don't trap focus.
- Drawer opens don't move focus to drawer; close doesn't restore focus to trigger.
- Hamburger buttons render `☰` text — aria-label correct but glyph not marked decorative (`<span aria-hidden="true">☰</span>`).
- `topic-bar-topic` empty span renders as focusable target via reflow but has no `aria-hidden`.
**Fix:** Add `aria-modal="true"`; programmatic focus on drawer
open/close + trap focus (small custom hook); decorative glyphs
`aria-hidden="true"`. Standard PWA a11y hygiene per `docs/reviewing.md` sec 1.

### M22. cicchetto `mentionMatch.ts` regex compiles on every match

**Module:** cicchetto/ | **File:** `cicchetto/src/lib/mentionMatch.ts:12-16`
`new RegExp(...)` on every PRIVMSG. Cache key is `nick`.
**Fix:** Memoize per-nick in module-scoped Map, evict on token
rotation (consume same `on(token)` cleanup pattern).

### M23. cicchetto `MembersPane` tier classification recomputes on every render

**Module:** cicchetto/ | **File:** `cicchetto/src/MembersPane.tsx:18-22,39`
For 200-member channel, every signal change in `membersByChannel`
recomputes `tierClass` for all 200. Phase 5 scale ceiling.
**Fix:** Memoize via `createMemo` per-entry or precompute on
`applyModeString` boundary.

### M24. cicchetto `Login.tsx` `<input>` `required` attribute on identifier but not on password — sparse error wiring

**Module:** cicchetto/ | **File:** `cicchetto/src/Login.tsx:51-66`
Identifier has `required`; password optional (correct for visitor
flow). Mode-1 user submitting empty password → server returns 401
`invalid_credentials` → display "Invalid name or password." — no hint
that password was missing. Pair with H13.
**Fix:** Explicit per-error-code message table (see H13).

### M25. Inline interpolation of `visitor_id` despite allowlist key (4 callsites)

**Module:** cross-module/ | **File:** `lib/grappa/visitors/login.ex:228`, `lib/grappa/accounts.ex:269`, `lib/grappa/session/server.ex:428`, `lib/grappa/visitors/reaper.ex:91`
Per `~/.claude/projects/-srv-grappa/memory/project_logging_format.md`:
"Need a new metadata key: extend `config/config.exs` allowlist
FIRST, then use it. Don't inline as a workaround." `:visitor_id` is
already in the allowlist (`config/config.exs:100`). These lines just
bypass it — likely side effect of H14 (dev format strips metadata).
The reaper count case (`reaper swept #{n}`) needs a new `:swept` (or
reuse `:affected`) allowlist key.
**Fix:** Replace with KV: `visitor_id: visitor.id` /
`visitor_id: visitor_id`. For reaper: extend allowlist with `:swept`
(or reuse `:affected`) and call `Logger.info("reaper swept", affected: n)`.

### M26. `Visitor` schema moduledoc references nonexistent `GRAPPA_VISITOR_NETWORK` env var

**Module:** cross-module/ | **File:** `lib/grappa/visitors/visitor.ex:20`
Moduledoc says: `A config rotation (GRAPPA_VISITOR_NETWORK change)
renders existing rows orphans...` — but `GRAPPA_VISITOR_NETWORK` does
NOT exist anywhere (`grep -r GRAPPA_VISITOR_NETWORK config/
.env.example compose*.yaml` is empty). Per CP11 S16 Task 23
retro-amend, the slug is fixed at compile-time via
`Application.compile_env/2` reading from `config/config.exs:17`
(`"azzurra"` literal). Misleads operator into hunting for an env var
that doesn't exist.
**Fix:** Replace `GRAPPA_VISITOR_NETWORK change` with `:grappa,
:visitor_network in config/config.exs change (compile-time; requires
image rebuild via scripts/deploy.sh)`. Same reword in
`docs/plans/2026-05-02-visitor-auth.md:97,422`.

### M27. `compose.prod.yaml` doesn't propagate `LOG_LEVEL` / `POOL_SIZE` env vars that `.env.example` documents

**Module:** infra/ | **File:** `compose.prod.yaml:38-50` vs `.env.example`
`.env.example` documents `LOG_LEVEL`, `POOL_SIZE`, `PORT` as optional
knobs. `compose.prod.yaml` exports `PORT` (line 42) but does NOT pass
`LOG_LEVEL` or `POOL_SIZE` through to the container. `runtime.exs`
reads them via `System.get_env(...) || default`, so .env entries are
silently ignored on prod stack.
**Fix:** Add `LOG_LEVEL: ${LOG_LEVEL:-info}` and `POOL_SIZE:
${POOL_SIZE:-10}` to `compose.prod.yaml` `services.grappa.environment`.

### M28. `purge_if_anon/1` `Repo.delete` `{:ok, _}` match crashes on `{:error, changeset}`

**Module:** persistence/ | **File:** `lib/grappa/visitors.ex:264-277`
Middle branch ignores result of `Repo.delete(visitor)` via `{:ok, _}`
pattern match — if delete returns `{:error, changeset}` (concurrent
FK violation in some weird edge case), `=` match crashes the calling
process. Per CLAUDE.md OTP rules, let-it-crash is OK — but the purge
runs from `Login.dispatch/4` (request path, would 500 the login
response) and `AuthController.maybe_terminate_visitor/1` (logout
path, would 500 the logout response). Realistic only if a CASCADE FK
fails or DB read-only, but if either happens the user sees a 500.
**Fix:** Either accept let-it-crash semantics + note in moduledoc,
OR rescue `Ecto.StaleEntryError` + add `Logger.warning` + still
return `:ok`.

---

## LOW

### L1. `IRC.Client` `to_charlist(opts.host)` on UTF-8 host string can produce surprising codepoints

**Module:** irc/ | **File:** `lib/grappa/irc/client.ex:265`
For UTF-8 binary containing IDN host (`"münchen.example"`),
`to_charlist/1` produces Unicode codepoint list which
`:gen_tcp.connect/4` passes to `inet_db` — `:inet.gethostbyname/1`
does NOT speak Punycode and fails with `:nxdomain`. Latent boundary
bug. Operators bind ASCII hostnames today.
**Fix:** Tighten `Identifier.valid_host?/1` regex to `[\x21-\x7e]`,
or Punycode-encode at `Client` boundary via `:idna.utf8_to_ascii/1`.

### L2. `IRCServer` test helper acceptor crashes silently on accept timeout, leaks listen socket

**Module:** irc/ (test support) | **File:** `test/support/irc_server.ex:111-113`
30s accept budget swallows `{:error, _}` silently. If accept times
out, spawned process exits normally but `state.listen` (listening
socket on parent GenServer) never closed. Across hundreds of suite
allocations under shared docker container, accumulates fd pressure.
Missing `terminate/2` callback.
**Fix:** Either `:gen_tcp.close(listen)` on timeout branch + signal
parent to stop, OR add `terminate(_, %{listen: l})` that closes the
listen socket.

### L3. `Networks.unbind_credential/2` `Repo.transaction` lacks explicit isolation semantics for sqlite single-writer

**Module:** persistence/ | **File:** `lib/grappa/networks/credentials.ex:155-172`
Function comment notes "sqlite is single-writer so the transaction
cost is negligible." Reasoning (concurrent `bind_credential/3` race)
relies on serialized writes — true for sqlite but undocumented. If
persistence layer ever moves to multi-writer engine (Postgres for
Phase 6+), transaction needs `:repeatable_read` or `:serializable`.
**Fix:** Add comment acknowledging sqlite single-writer assumption +
flag as Postgres-migration footgun.

### L4. `Reaper.sweep/0` per-row failure log uses `Logger.error` for benign no-op transient

**Module:** persistence/ | **File:** `lib/grappa/visitors/reaper.ex:67-72`
`Visitors.delete/1` returns `{:error, :not_found}` on missing row.
If Reaper enumerates expired row + concurrent `purge_if_anon`
(logout, login preempt) deletes between enumerate and delete, Reaper
logs `Logger.error("reaper delete failed", ...)`. Race is benign +
idempotent.
**Fix:** Pattern-match `{:error, :not_found}` separately and log at
`:debug` (or skip).

### L5. `Accounts.Session.changeset/2` `validate_subject_xor/1` reads `get_field` instead of `get_change`

**Module:** persistence/ | **File:** `lib/grappa/accounts/session.ex:108-119`
XOR validator uses `get_field` (falls back to struct's current value
if no change staged), so an UPDATE that changes neither subject id
but had both populated upstream would pass validation. Practically
unreachable (sessions insert-only — no `update_session/2`). Same
shape mirrored in `Scrollback.Message.validate_subject_xor/1`. Compare
`Accounts.validate_subject_exists/1` uses `get_change` deliberately
(line 182, 185) — siblings disagree.
**Fix:** Standardize on one or the other + comment the choice.

### L6. `Bootstrap.spawn_one/2` & `spawn_visitor/2` carry redundant `network: visitor.network_slug` Logger metadata

**Module:** lifecycle/ | **File:** `lib/grappa/bootstrap.ex:228-249`
`spawn_visitor` passes `network: visitor.network_slug` as keyword
metadata in 3 of 4 log lines; `Session.Server.init/1` already calls
`Log.set_session_context(opts.subject_label, opts.network_slug)`.
Pre-spawn lines need it explicitly (Bootstrap runs as Task without
session context). Post-spawn redundant.
**Fix:** Trim post-spawn lines.

### L7. `Grappa.Release.@repos` hardcoded list duplicates `mix.exs :ecto_repos` with NO compile-time consistency check

**Module:** lifecycle/ | **File:** `lib/grappa/release.ex:33`
S8 comment (line 25-32) explains why `Application.fetch_env!(@app,
:ecto_repos)` was rejected. Chosen alternative is "mirror this list
with `mix.exs` `:ecto_repos` — drift would now be silent." That's
exactly the bad shape S8 was trying to avoid.
**Fix:** Drop a compile-time check via `compile_env`-mismatch raise,
OR add a test asserting `@repos == Application.get_env(:grappa,
:ecto_repos)`.

### L8. `Bootstrap.spawn_one/2` and `spawn_visitor/2` both inline 4-line `Enum.reduce` accumulator pattern — duplicate "collect-or-bail"

**Module:** lifecycle/ | **File:** `lib/grappa/bootstrap.ex:124-134, 207-219`
`spawn_all/1` and `spawn_visitors/0` are mirror-symmetric structurally.
"Reuse the verbs, not the nouns."
**Fix:** Extract `defp spawn_and_count(items, kind, spawn_fun)` private
helper.

### L9. `endpoint.ex` session signing salt placeholder still in source

**Module:** web/ | **File:** `lib/grappa_web/endpoint.ex:28` (also documented at line 13)
`signing_salt: "rotate-me"` ships in source. Moduledoc acknowledges
Phase 5 will lift to runtime config. Today the cookie store is unused
(no auth flow writes session) so benign — but visitor-auth cluster's
`Plug.Session` pipeline is now attached at line 46 and any future
plug calling `put_session/3` would sign with a literal-in-source salt.
**Fix:** Move to `runtime.exs` alongside `secret_key_base` per
moduledoc plan.

### L10. `endpoint.ex` `Plug.Telemetry` event prefix doesn't include visitor metadata

**Module:** web/ | **File:** `lib/grappa_web/endpoint.ex:37`
Phase 5 PromEx will need `kind: :user | :visitor` as label dimension;
today every visitor request invisible in any per-subject Telemetry
aggregation.
**Fix:** Add a `GrappaWeb.Plugs.SubjectMetadata` plug after `:authn`
calling `Logger.metadata(subject_kind: ...)` + emitting `[:grappa,
:request, :subject_seen]`. Requires extending metadata allowlist in
`config/config.exs:59`.

### L11. `Plugs.Authn.assign_subject` clauses share zero structure

**Module:** web/ | **File:** `lib/grappa_web/plugs/authn.ex:70-104`
Two `defp assign_subject/2` clauses each compute different
`{loaded, assigns_keys}` pair. As Task 30 lands, plug should set BOTH
legacy `current_user[_id]` / `current_visitor[_id]` AND new
`current_subject` tuple — otherwise downstream controllers fork into
two branches per assigns key.
**Fix:** Add `assign(conn, :current_subject, {:user, user.id})` /
`{:visitor, visitor.id}` to both clauses now (one-line change), so
Task 30 is a pure consumer-side refactor.

### L12. `infra/nginx.conf` REST allowlist regex matches Task 25.5's `/auth/logout` correctly but documentation gap for future visitor routes

**Module:** web/ adjacent | **File:** `infra/nginx.conf:104`
Allowlist regex: `^/(auth|me|networks|healthz)(/|$)`. Currently fine
(visitor work routes through `/auth/login`, `/auth/logout`, `/me`,
`/networks/...`). If visitor-PWA polish cluster adds e.g.
`/visitors/:id/expires_at`, nginx silently 404s before grappa sees
the request.
**Fix:** Add comment to nginx.conf:104 referencing visitor-auth Task
30 follow-up; document the "if you add a top-level route, edit both
router.ex AND nginx.conf" rule.

### L13. cicchetto `package.json` script `"test"` runs `vitest run` but `"check"` doesn't include tests — CI gate gap

**Module:** cicchetto/ | **File:** `cicchetto/package.json:11-13`
**Fix:** Add `"test"` to `check` script or document CI invocation order.

### L14. cicchetto `index.html` no `<noscript>` fallback

**Module:** cicchetto/ | **File:** `cicchetto/index.html:21-23`
**Fix:** Add `<noscript>This app requires JavaScript.</noscript>`.

### L15. cicchetto `vite.config.ts` proxy hardcoded to `host.docker.internal` — no override path for non-Docker dev

**Module:** cicchetto/ | **File:** `cicchetto/vite.config.ts:97-103`
Acknowledged in comments but no env-var override. Phase 1 only-target
audience is operator using `scripts/bun.sh` (Docker), so deferring is OK.
**Fix:** Optional — accept `process.env.GRAPPA_BACKEND` to override.

### L16. cicchetto `ScrollbackPane.tsx` `formatTime` uses local timezone — undocumented choice

**Module:** cicchetto/ | **File:** `cicchetto/src/ScrollbackPane.tsx:32-38`
For a bouncer used across timezones, two clients see different
timestamps for same message. Whether desired is product decision; if
"yes", current code fine; if "render server time always", switch to
`toUTCString` / `getUTCHours`.
**Fix:** Document the choice in function jsdoc.

### L17. cicchetto `ScrollbackPane.tsx` `meta` field reads use `typeof === "string"` narrowing — no compile-time pinning of meta-key set

**Module:** cicchetto/ | **File:** `cicchetto/src/ScrollbackPane.tsx:103,111-112,127`
Meta key allowlist (per `lib/grappa/scrollback/meta.ex`) is fixed
server-side — drift between TS and Elixir sets silent. Phase 5+
significant typing investment but pins contract at compile time.
**Fix:** Mirror `Scrollback.Meta`'s per-kind shape table as TS
discriminated `MessageMeta` type, parameterize on `MessageKind`.

### L18. `Visitors.commit_password/2` doc dup on guards

**Module:** persistence/ | **File:** `lib/grappa/visitors.ex:104-117` + `lib/grappa/visitors/visitor.ex:88-91`
`Visitor.commit_password_changeset/3` has guard + docstring;
`Visitors.commit_password/2` has equivalent guard. Defensible
defense-in-depth.
**Fix:** None required. Optional: docstring the chain.

### L19. cicchetto SW `navigateFallbackDenylist` doesn't list `/healthz`

**Module:** infra/ | **File:** `cicchetto/vite.config.ts:78` (denylist) vs `infra/nginx.conf:105` + `lib/grappa_web/router.ex:52`
Server-side `/healthz` in nginx allowlist, but cicchetto SW's
`navigateFallbackDenylist: [/^\/auth/, /^\/me/, /^\/networks/, /^\/socket/]`
omits `/healthz`. User explicitly navigating to `/healthz` while SW
installed gets cached `index.html` instead of backend.
**Fix:** Add `/^\/healthz/` to `navigateFallbackDenylist`.

---

## Trajectory

### What did we build in the last N sessions?

CP10 closed seven correctness clusters + the D-cluster god-module
splits (Networks, IRC.Client, cicchetto/lib/networks.ts) — three
applications of the verb-keyed sub-context principle across two
languages. Phase 3 walking-skeleton landed: PWA installed on iPhone,
operator round-trip verified at `http://grappa.bad.ass`.

CP11 S1–S15 was the pre-`visitor-auth` interregnum (text polish, P4-V
plan, post-P4-1 cluster arc planning). S16 was the entire
visitor-auth cluster end-to-end: Tasks 1–25.5 LANDED, two prod
hotfixes (cicchetto Tasks 24/25 single-identifier login + IRC client
connect-failure throttle), browser smoke 6/9 PASS, deployed twice,
deferred Tasks 30 (visitor REST surface — 5 controllers) and Task 31
(per-IP active-session admission control).

Theme: the project moved decisively from "Phase 2 multi-user auth +
Phase 3 client walking skeleton" into the "auth-triangle close" arc
sketched in CP10's post-Phase-3 trajectory: M2 (NickServ-as-IDP) +
M3 (anon ephemeral) merged into a single visitor-auth cluster
combining Mode-1 (admin user) + Mode-2 (anon visitor) + Mode-3
(NickServ-IDP visitor) under one Subject discriminated union.

### Does recent work serve the core mission?

**Yes, with caveats.** The visitor-auth cluster directly serves the
"always-on IRC bouncer + REST/WS API + browser PWA" mission — it
unblocks the second largest user constituency (Italian Hackers'
Embassy IRC regulars who don't want to register for a vjt-managed
account but DO want pocket-irssi). The Mode-3 NickServ-IDP path is
load-bearing for "Azzurra-natives can use grappa without operator
intervention."

**Caveats:**
- Task 30 was deferred — the visitor-REST controller surface is
  fundamentally INCOMPLETE. The visitor-auth cluster shipped a
  half-finished feature: bearer accepted, sessions spawned, scrollback
  written — but every REST controller a visitor would need (channels,
  messages, members, nick, me) returns 500. The browser smoke caught
  6/9 scenarios; the 3 deferred (S2/S3/S4 chat-driven) are the
  product's reason for existing. **Visitors today can log in and
  receive nothing.** This is the C2/H7/H11/M14 cluster of findings.
- Task 31 (per-IP active-session admission control) was identified as
  a NEW cluster-level need during S16 smoke — azzurra's CLONES limit
  (3 concurrent connections per IP) tripped during a 4-session burst.
  W3 caps visitors-per-IP but doesn't account for users + visitors
  combined. Currently no mitigation; the IRC.Client `Process.sleep`
  hotfix addresses rate, not count.

### What's stalling?

Nothing has been in todo for 2+ weeks without progress — the
visitor-auth cluster collapsed M2+M3+M3-A from todo's "post-Phase-4
additive" track into a single S16-week sprint. But Task 30 + Task 31
need to land BEFORE the visitor-auth cluster can be called "shipped"
in any user-facing sense.

The recurring tax-of-deferral items (Phase 5 hardening: TLS verify,
PromEx, Reconnect/backoff, scrollback eviction, HSM-keyed Vault) all
date back to Phase 1 and continue to accumulate. None blocking
today, but the list grows every cluster.

### Observation items due

- The Phase 5 Reconnect/backoff item is now load-bearing — H1's
  `Process.sleep` band-aid in IRC.Client is acceptable short-term but
  bit the operator twice during S16. Promote from observation to
  Phase 5 immediate.
- The Phase 5 a11y audit item (`docs/todo.md:182-188`) needs upgrade
  given M21 / cicchetto a11y findings — these are not just iOS
  VoiceOver gaps but `aria-modal`/focus-trap/decorative-glyph misses.
- The "test-suite flakes surfaced during D-cluster correctness
  campaign" (todo.md:93-115) — three flakes catalogued, no progress.
  Still observation; may compound when Task 31 cluster lands.

### Risk check

**HIGH-priority risks:**

1. **C1 (Plugs.Authn expiry skips W11 purge)** — visitor lifecycle
   contract drift. Anon visitor rows can outlive their `accounts_sessions`
   row by up to 60s. Concurrent re-login by same nick in that window
   trips uniqueness constraint, surfaces as `Ecto.Changeset.t()` outside
   the spec'd `login_error()` union (H2), hits `FallbackController`
   catchall as 500. Not yet seen in prod (smoke wasn't bursty enough),
   but a real anon-driven workload would hit this.

2. **C2/H7 (visitor → 500 cascade)** — the visitor-auth cluster
   shipped a feature where the auth pipeline accepts visitor bearers
   and routes them into 500-crashing controllers. This is observable
   to anyone curl'ing the API with a visitor bearer. Operator surface
   noisy.

3. **C3/C4 (cicchetto subject validation + topic prefix)** — even
   after Task 30 lands the server-side fix, cicchetto cannot consume
   a visitor session correctly. The C4 topic-prefix bug is a
   silent-no-op (visitor never receives WS events); the C3 validation
   miss is an XSS-adjacent risk in localStorage poisoning. Both need
   landing alongside Task 30, not after.

4. **H1 (IRC.Client Process.sleep)** — non-blocking-throttle fix
   should land before Task 31 (which adds new admission-control
   surface) — otherwise operator-mitigation pattern compounds.

5. **H8 (NickServ password leak via inspect)** — credential-handling
   code path with a "no error path leaks the body today" implicit
   invariant. Brittle.

**MEDIUM-priority risks:**

- M9 (Bootstrap.validate_visitor_networks!/0 crashes app supervisor
  on orphan visitors) — config-state issue takes down running web
  surface.
- H4 (Reaper wipes registered visitors via TTL — docstring lies about
  password persistence). Not bug-shaped today (registered visitors
  log in regularly, never hit 7d TTL), but a single Italian-summer
  vacation breaks the operator's stored Azzurra password.
- H14 (dev console drops `$metadata`) — explains 4 inline-interpolation
  Logger calls (M25). Quietly invalidates the structured-KV
  observability discipline pinned in memory.

### Recommendation

**Land Task 30 + Task 31 NEXT, not "after the cluster ships."** The
visitor-auth cluster is functionally HALF-shipped: bearer accepted +
session spawned + scrollback written, but EVERY REST surface a visitor
needs returns 500. CP11 frames Tasks 30/31 as "follow-up cluster" —
this review's CRITICAL findings argue they're part of the SAME ship.
A shipped feature where 5 of 6 user-facing controllers crash is not
shipped.

Before either task starts, address H1 (IRC.Client Process.sleep
non-blocking-throttle, ~one screen of code) and H14 (dev console
metadata format, one-line config change) — both unblock cleaner
follow-up work and remove operator friction the cluster created.

The 4 CRITICAL findings cluster around ONE root cause: the cluster
plumbed the Subject discriminated union through the auth pipeline
but stopped before the consumer surfaces (controllers + cicchetto
WS topic). The fix shape is consistent: `current_subject = {:user, id} |
{:visitor, id}` everywhere (server: a single plug-side assigns key;
client: a single `socketUserName()` accessor).

After Task 30 + Task 31 + the H1/H14 fixes, the cluster genuinely
ships. Until then, deferring origin push is correct: CP11 explicitly
deferred origin push pending review — this review says push is
premature until visitors can actually USE the surface.
