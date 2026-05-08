# Codebase Review — 2026-05-08

**Scope:** Line-level review across 6 surfaces (irc/, persistence/, lifecycle/,
web/, cicchetto/, cross-module + infra), per `docs/reviewing.md` §1.

**Trigger:** Gate enforced by `/start` — ≥12 sessions since last review.
Last codebase review: 2026-05-03 (CP12 closure). Since then: ~14 sessions
(CP12 S31→S44) + CP13 + CP14 + CP15. Project-story episode S40 LANDED
in CP15 B7. Well past the 12-session threshold.

**Sibling architecture review:** `docs/reviews/architecture/2026-05-08-architecture-review.md`
(6 concerns: abstraction-boundaries, responsibility, duplication, dependency,
type-system, extensibility — see end of this file for cross-references).

---

## Executive summary

**Total findings:** 0 CRITICAL · 13 HIGH · 41 MEDIUM · 23 LOW (line-level, 6 scopes).

**Recurring root cause across all scopes — wire-shape discipline incomplete.**
CP15 B7 elevated the wire-module rule to a CLAUDE.md hard invariant (broadcasts
+ Channel pushes go through context-owned `*.Wire` modules). Six clusters surface
the same gap from different angles:

- **Persistence M2-M4** — `QueryWindows.windows_list_payload` typedoc + `GrappaChannel.query_windows_list_payload`
  typedoc still declare raw `[Window.t()]` (the exact pre-fix shape that crashed
  Phoenix's `fastlane!/1` in CP15 B6). Code fixed, types didn't follow.
  `Scrollback.Wire.message_payload/1` emits `kind: :message` (atom) while every
  other event uses strings — no consistency in the closed-set discriminator.
- **Web W2** — same `query_windows_list_payload` typespec landmine, mirrored
  in `grappa_channel.ex`.
- **Web W4** — `MembersJSON` re-shapes wire data the context returns wire-ready
  (two shapes for one domain).
- **IRC S1-S4** — four HIGH findings, all share root: `AuthFSM.step/2` lacks
  phase guards on clauses that should fire only during registration; once
  `:registered` is reached, ERR_NICKNAME (432/433), stray `AUTHENTICATE +` from
  upstream (SASL credential leak under verify_none), and stray 904/905 each
  crash the entire Session. M-irc-1's `nilify/1` parser fix exposed
  `Message.sender_nick/1` returning `nil` despite `@spec :: String.t()`.
- **Lifecycle S1** — `apply_effects([{:joined, ch}])` doesn't strip
  `in_flight_joins[ch]` on self-JOIN echo (contradicts CP15 B2 invariant);
  stale entry can correlate with later 471/473 and overwrite `:joined` → `:failed`.
- **Lifecycle S2** — `handle_info({:EXIT, ...})` records Backoff failure for
  ANY exit reason. T32 disconnect (next cluster) will trigger this; clean
  Client teardown poisons next reconnect.
- **Lifecycle S3** — `Process.cancel_timer` calls don't drain the message
  from the mailbox; `auto_away_debounce_fire` clobbers a newly-scheduled timer.
- **Cicchetto H1** — `awayStatus.ts` + `mentionsWindow.ts` register `on(token, …)`
  callbacks NOT wrapped in `createEffect(…)`; identity-rotation cleanup never
  registers — stores leak prior tenant's data on logout/rotation despite explicit
  moduledoc claims.
- **Cicchetto H2** — token rotation installs duplicate channel-event handlers
  (every WS event fires both, presence/unread/mention counters double; N
  rotations = N+1 handlers per channel).
- **Cicchetto H3** — `Network.nick?: string` admits "key present, value undefined"
  which never matches server contract. Defensive `?? displayNick(u)` fallback
  papers over the visitor case + any future bug — exactly the BUG1 failure mode
  `Networks.Wire`'s typedoc warns against.
- **Cross-infra H1** — `Networks.broadcast_state_change/4` emits via raw
  `Phoenix.PubSub.broadcast/3`, bypasses `broadcast_event/2`, AND no `handle_info/2`
  in `GrappaChannel`. Tests pass via `Phoenix.PubSub.subscribe`; cic NEVER
  receives T32 disconnect/connect over WS. Real bug, real production gap.
- **Cross-infra H2** — `WSPresence` introduces sibling topic prefix
  `grappa:ws_presence:` (CLAUDE.md "don't introduce sibling prefixes" violation),
  AND duplicates topic-string contract by inline-interpolation in 2 files.
- **Cross-infra H3** — `mode1_login` does NOT pass `client_id` to
  `Accounts.create_session/3`; admin user logins skip per-(client, network) cap
  tracking entirely. Visitor branch threads it correctly. **Silent admission-control
  hole introduced by an `\\` default arg** (M2).
- **Web W1** — `MessagesController.create` accepts `"$server"` as a PRIVMSG
  target via shared `validate_target_name/1`. Clients can POST to
  `/networks/:slug/channels/$server/messages` and smuggle `PRIVMSG $server :body`
  upstream (server-mask form), pollute synthetic Server-window scrollback,
  inadvertently probe operator privileges.

**Closed since 2026-05-03 (verified across scopes):**
- `Application.get_env` runtime ban — H1 cluster (5 violations) remediated via
  `Grappa.Admission.Config.boot/0` `:persistent_term` snapshot.
- Logout WS disconnect (H2) — wired in `auth_controller.ex:184-211`.
- Captcha CDN-blocked toast + `captcha_required` friendlyMessage arm (H3, H4).
- M-cic-5/6 (per-effect-run cleanup, `bootstrapAuth()` extraction).
- Lifecycle M-life-1..5 + (Backoff ETS, `spawn_with_admission/6`, tri-counter,
  bootstrap reset, telemetry).
- M-irc-1..4, L-irc-1..2, H12 — all LANDED.

---

## How to read this file

Each scope's raw findings follow, grouped under a `# <scope>/` heading.
Severity headers within each scope: `## CRITICAL`, `## HIGH`, `## MEDIUM`, `## LOW`.
Findings use the format prescribed by `docs/reviewing.md` §1 (`### S<N>. Title`
with **Module** / **File** / **Category** / **Fix**).

Cross-references to the architecture review use `A<N>` IDs — see
`docs/reviews/architecture/2026-05-08-architecture-review.md` for the
concern-based findings (god modules, duplication clusters, type-system
gaps, supervision-tree drift, etc).

---


# irc/

# IRC line-level review — 2026-05-08

Scope: `lib/grappa/irc/{auth_fsm,client,identifier,message,parser}.ex`
+ `test/support/irc_server.ex`. Cross-checked against
`docs/reviews/codebase/2026-05-03-codebase-review.md` and `docs/todo.md`.
All M-irc-1..4, L-irc-1..2, H12 from the previous review confirmed
LANDED (commits `4e02452`, `2175e32`, `56a5a20`, `ac64d1d`, `9cae8d2`,
`c0d119c`, `d65de08`, `dcd1414`).

## HIGH

### S1. AuthFSM crashes Session on post-registration 432/433 (`/nick` rejection)
**Module:** irc | **File:** `lib/grappa/irc/auth_fsm.ex:243-246`
**Category:** logic bug / OTP misuse / state-machine boundary

`step/2`'s 432/433 clause has NO phase guard — it fires on every
`{:numeric, 432|433}` regardless of `state.phase`. Post-registration,
when a user issues `/nick takenname` via `Session.send_nick/4` and the
upstream replies with 433 ERR_NICKNAMEINUSE, the FSM returns
`{:stop, {:nick_rejected, 433, state.nick}, ...}`. `Client.run_fsm_step`
propagates the stop, the linked `Session.Server` receives the EXIT, and
the entire IRC session is restarted by the DynamicSupervisor.

`numeric_router.ex:119-123` already lists 432/433 as `@active_numerics`
to be routed to the active window — meaning the post-registration path
IS expected. The FSM intercepts FIRST and crashes before the routing
runs. The `:nickserv_identify` carve-out at lines 230-236 was added
to keep GhostRecovery alive, but the same logic applies to ALL methods
post-registration: 432/433 during `:registered` is a legitimate slash-
command response, not a registration failure.

**Fix:** Guard the stop clause on `state.phase != :registered`:
```elixir
def step(%__MODULE__{phase: phase} = state, %Message{command: {:numeric, code}})
    when phase != :registered and code in [432, 433] do
  {:stop, {:nick_rejected, code, state.nick}, state, []}
end
```
Add a fall-through clause that lets post-registration 432/433 propagate
to the Session unchanged. Add a regression test driving `/nick badnick`
post-001 and asserting Session stays alive.

### S2. AuthFSM replies to ANY post-registration `AUTHENTICATE +` with SASL credentials
**Module:** irc | **File:** `lib/grappa/irc/auth_fsm.ex:212-214`
**Category:** security / credential exposure

`step/2`'s `:authenticate ["+"]` clause has no phase guard. A
compromised or MITM upstream (recall TLS posture is `verify_none`
per CLAUDE.md) can send `AUTHENTICATE +` AT ANY TIME post-registration
and the FSM will reply with `AUTHENTICATE <base64(\0sasl_user\0sasl_user\0password)>`
on the wire. The phase guard is missing — `:sasl_pending` is the only
phase where AUTHENTICATE + is a legitimate continuation.

Combined with `verify: :verify_none` (Phase 1 expedient), an upstream
operator (or a substituted server during a connection upgrade) can
extract the SASL password verbatim by issuing the prompt at any point.
Even with TLS-verify-on (Phase 5), a hostile but legitimately-connected
upstream can still elicit the credential post-registration.

**Fix:** Phase-guard the clause:
```elixir
def step(%__MODULE__{phase: :sasl_pending} = state,
         %Message{command: :authenticate, params: ["+"]}) do
  {:cont, state, ["AUTHENTICATE #{sasl_plain_payload(state)}\r\n"]}
end
```
Add a fall-through that ignores stray AUTHENTICATE outside `:sasl_pending`.
Cover with a regression test: post-001, feed `AUTHENTICATE +`, assert no
bytes flushed.

### S3. AuthFSM crashes Session on stray post-registration 904/905
**Module:** irc | **File:** `lib/grappa/irc/auth_fsm.ex:220-222`
**Category:** logic bug / state-machine boundary

Same root cause as S1: the 904/905 clause has no phase guard. Post-
registration, a stray 904 (some ircd implementations emit them
spuriously, hostile MITM, future SASL-rekey extensions) triggers
`{:stop, {:sasl_failed, code}, ...}`. The Session crashes and restarts
on what should be observability noise.

**Fix:** Guard on `state.phase in [:awaiting_cap_ack, :sasl_pending]`.
Stray 904/905 outside the SASL chain falls through to the catch-all
`step(state, _) -> {:cont, state, []}`. Same regression-test shape as
S2.

### S4. `Message.sender_nick/1` violates `String.t()` spec on prefixes with empty nick
**Module:** irc | **File:** `lib/grappa/irc/message.ex:124-128`
**Category:** type-safety / spec violation / downstream persistence bug

After M-irc-1 (LANDED 2026-05-04, commit `4e02452`) the parser's
`nilify/1` normalizes empty prefix components to `nil` — so an upstream
emitting pathological prefixes (`:!user@host`, `:@host PRIVMSG ...`,
`:nick!@host`) lands the prefix as `{:nick, nil, _, _}`. But
`Message.sender_nick({:nick, nick, _, _}) -> nick` returns whatever was
in the slot — including `nil`. The `@spec` declares `String.t()` return
type; `nil` is not `String.t()`.

Downstream impact (real, not theoretical):
`Grappa.Session.EventRouter` calls `Message.sender_nick(msg)` six times
(`event_router.ex:190, 198, 204, 255, 347`) and feeds the result into
`Scrollback.Message.changeset` as the `:sender` field. The changeset
runs `validate_required([..., :sender])` + `validate_identifier(:sender,
&Identifier.valid_sender?/1)` (scrollback/message.ex:200-203).
`Identifier.valid_sender?(nil)` returns `false` — the row write fails
silently or crashes the session depending on how `EventRouter`
handles the `{:error, changeset}` shape. Either way, a malformed
upstream prefix (which IS observed in the wild — comment at parser.ex:301
explicitly catalogues `!user@host`, `nick!@host`, `nick!user@`, bare
`:`) breaks scrollback persistence on that line.

**Fix:** Coalesce nil-nick prefixes to the `@anonymous_sender` sentinel
in `sender_nick/1`:
```elixir
def sender_nick({:nick, nil, _, _}), do: @anonymous_sender
def sender_nick({:nick, nick, _, _}), do: nick
```
Add a doctest pinning the `{:nick, nil, _, _}` -> `"*"` mapping.
Dialyzer will catch the spec violation if you also tighten the
`prefix()` type to `{:nick, String.t() | nil, ...}` (already accurate).

## MEDIUM

### S5. AuthFSM `step/2` 903 numeric has no phase guard — emits stray `CAP END` post-registration
**Module:** irc | **File:** `lib/grappa/irc/auth_fsm.ex:216-218`
**Category:** state-machine hygiene

Less severe than S1-S3 (server tolerates stray CAP END), but the same
class of bug: the `{:numeric, 903}` clause unconditionally returns
`{:cont, leave_cap_negotiation(state, :pre_register), ["CAP END\r\n"]}`.
Post-registration this writes `state.phase = :pre_register` (regressing
the FSM from `:registered` back to `:pre_register`!) and emits a
stray CAP END.

The phase regression is the bigger problem — `state.phase = :pre_register`
post-registration could in principle re-arm other clauses' guards (e.g.
if a future `step/2` clause is gated on `:pre_register`, it would
trigger again).

**Fix:** Phase-guard on `state.phase in [:awaiting_cap_ack, :sasl_pending]`.
Or: change `leave_cap_negotiation/2` to a no-op when `phase ==
:registered`.

### S6. `Parser.unescape/1` public function lacks UTF-8 precondition documentation; raises on bare `\\` followed by invalid UTF-8 start byte
**Module:** irc | **File:** `lib/grappa/irc/parser.ex:244-268`
**Category:** missing precondition documentation / boundary contract

The docstring says "Public so the doctests below cover the fall-through
arm" + "external consumers (e.g. a Phase 6 listener replaying tag
values)." But `do_unescape` clauses use `<<"\\", c::utf8, rest::binary>>`
and `<<c::utf8, rest::binary>>` — they assume the input is canonical
UTF-8. If a Phase 6 listener (or a test) passes a non-UTF-8 binary
that contains a `\\` followed by a continuation byte (or a lone byte
like `0xFF`), the function raises `FunctionClauseError` instead of
returning a degraded value.

The parser feeds `unescape` AFTER `to_utf8/1` so production callers
are safe — but the public boundary doesn't enforce or document this.

**Fix:** Either (a) add a `to_utf8` call at the entry point of
`unescape/1` (cheap, single-pass for valid UTF-8); or (b) document the
precondition explicitly: "Input MUST be valid UTF-8. Callers receiving
raw bytes must run `to_utf8/1` first." Option (a) is safer and matches
the parser's own boundary discipline.

### S7. `IRCServer.handle_info({:tcp_closed, _})` does not notify pending waiters
**Module:** irc | **File:** `test/support/irc_server.ex:193`
**Category:** test-helper UX gap

When the IRC client disconnects mid-test, `:tcp_closed` arrives and
sets `sock: nil`. Any pending `wait_for_line` waiter sits until its
deadline (default 1s, configurable up to 30s in some tests). The test
gets a `{:error, :timeout}` instead of the more diagnostic "client
disconnected before predicate matched."

Not a correctness bug — just slows test feedback when a session
crashes unexpectedly during a wait.

**Fix:** On `:tcp_closed`, walk `state.waiters` and reply
`{:error, :tcp_closed}` to each, then clear. Keeps the waiter
contract consistent with "predicate cannot match after disconnect."

### S8. `IRCServer.wait_for_line/3` has default arg violating CLAUDE.md "no default arguments"
**Module:** irc | **File:** `test/support/irc_server.ex:72`
**Category:** CLAUDE.md violation (test-helper context)

`def wait_for_line(server, predicate, timeout \\ 1_000)` uses the `\\`
default-arg syntax. CLAUDE.md: "No default arguments via `\\`, except
for genuine config defaults where the default is the correct production
behavior." Test helper, but the rule is universal. Test sites are
inconsistent — some pass an explicit timeout, some rely on the default.

**Fix:** Either remove the default and update call sites to pass
explicit timeouts (consistency wins), or document the carve-out for
test-helper defaults at the rule site.

## LOW

### S9. `Client.send_pong/2` accepts empty token — emits malformed `PONG :\r\n`
**Module:** irc | **File:** `lib/grappa/irc/client.ex:274-275`
**Category:** boundary validation gap

`send_pong` has no guard at all (justified by parser invariant for
CR/LF/NUL — see H12 closeout). But `send_pong(client, "")` happily
emits `PONG :\r\n`. RFC 2812 §3.7.3 requires PONG to carry a server
identifier. Most servers tolerate empty PONG but it's a malformed
emission. Not exploitable; cosmetic.

**Fix:** Add `byte_size(token) > 0` guard, or document that empty
token is intentional pass-through.

### S10. `Client.send_*` helpers do not log `{:error, :invalid_line}` rejections
**Module:** irc | **File:** `lib/grappa/irc/client.ex:168-234`
**Category:** observability gap

Every outbound helper (`send_privmsg/3`, `send_join/2`, `send_part/2`,
`send_topic/3`, `send_nick/2`, `send_quit/2`, `send_away/2`) returns
`{:error, :invalid_line}` silently when the safe-token guard rejects.
The caller (`Session.Server`) probably handles this, but operators
have no log trail of WHICH field rejected — just that the call
returned an error. A `Logger.warning("rejected outbound", verb:
:privmsg, target_ok: ..., body_ok: ...)` at the rejection site would
help diagnose "why did my /msg silently disappear."

**Fix:** Add a `Logger.warning` (or telemetry) on each rejection arm,
keyed on the verb + which field failed. Cheap, localized.

### S11. `IRCServer.start_link/1` cannot pass initial handler state
**Module:** irc | **File:** `test/support/irc_server.ex:57-59`
**Category:** test-helper API gap

`init/1` hardcodes `handler_state: %{}`. Tests that need stateful
handlers (e.g., a counter that responds differently on the 3rd PING)
must thread state through the handler closure or use process
dictionary. Not a bug; an API limitation.

**Fix:** Accept `start_link({handler, initial_state})` or
`start_link(handler, opts)` with an `:initial_handler_state` key.

---

## Cross-check vs. previous review

All previously filed IRC findings (M-irc-1, M-irc-2, M-irc-3, M-irc-4,
L-irc-1, L-irc-2, H12) are LANDED on main. Verified via `git log
--since='2026-04-30' -- lib/grappa/irc/ test/support/irc_server.ex`.
Phase 5-deferred items (TLS `verify_none` posture, reconnect/backoff
beyond the existing throttle, NickServ NOTICE machinery, CA chain
verification) are explicitly out of scope per `docs/todo.md` lines
151+.

The four findings new to this round (S1-S4 HIGH) all share a structural
theme: **AuthFSM `step/2` lacks phase guards**. The FSM was designed
to drive registration; once `:registered` is reached, four of the
clauses (`:authenticate +`, `{:numeric, 903|904|905}`, `{:numeric,
432|433}`) still fire and either stop the Session or leak credentials.
The architectural fix is uniform: every clause that emits SASL bytes
or returns `{:stop, _}` MUST guard on a registration-phase predicate
and fall through to the catch-all otherwise. The `:nickserv_identify`
carve-out at line 230 hints the original author noticed the post-
registration problem for one method but did not generalize.

---

# persistence/

# Persistence line-level review — 2026-05-08

**Scope:** `lib/grappa/scrollback*` (context + Message + Meta + Wire),
`lib/grappa/query_windows*` (context + Window + Wire), every file under
`priv/repo/migrations/`. Last persistence review 2026-05-03; this pass
covers the CP14/CP15 deltas (`add_dm_with_to_messages`, the new
`Grappa.QueryWindows.Wire`, `Scrollback.list_archive/3`,
`Scrollback.dm_peer/4`, the `:dm_with` column).

PROBLEMS ONLY. Pre-existing items already in `docs/todo.md` or already
filed in `docs/reviews/codebase/2026-05-03-codebase-review.md` are not
re-flagged.

---

## HIGH

### H1. `:dm_with` index lacks subject column — cross-subject scan + worse-than-channel-side perf

**Module:** persistence/ | **File:**
`priv/repo/migrations/20260507151920_add_dm_with_to_messages.exs:55`,
`lib/grappa/scrollback.ex:295-301`
**Category:** wrong index shape for the access pattern

CP14 B3 added `create index(:messages, [:network_id, :dm_with,
:server_time])` for the OR branch of `Scrollback.fetch/5`'s
`channel_or_dm_where/2`:

```elixir
where(query, [m], m.channel == ^channel or m.dm_with == ^channel)
```

The `subject_where/2` filter (`user_id == ?` or `visitor_id == ?`)
is applied separately and is the *primary* per-subject iso boundary
per `Scrollback`'s moduledoc. The channel side enjoys two composites
that lead with the subject column:

- `(user_id, network_id, channel, server_time)` (S22 messages_per_user_iso)
- `(visitor_id, network_id, channel, server_time)` (B5.4 M-pers-5)

The `dm_with` side has only `(network_id, dm_with, server_time)` — no
subject leading column. SQLite picks one index per `OR` arm; the
dm_with arm scans every row on `(network_id, dm_with)` matching the
peer **across every user/visitor on that network**, and post-filters
by subject. Two operational consequences:

1. **Perf asymmetry vs the channel side.** A peer that has been DM'd
   by N users surfaces N× the index pages the channel side walks
   for an equivalent query. Worse on busy peers (e.g. service
   bots) which are the cheapest case to optimize.
2. **Per-subject iso friction.** The iso boundary still HOLDS (the
   `subject_where` filter is still in the WHERE clause), but the index
   is doing cross-subject work before the application of the iso. On
   prod where `messages` will be the largest table by an order of
   magnitude, this turns a single-index-scan plan into an
   index-scan + row-fetch + subject-filter plan.

**Fix:** Replace the single index with two subject-leading composites
matching the channel-side shape:

```elixir
create index(:messages, [:user_id, :network_id, :dm_with, :server_time])
create index(:messages, [:visitor_id, :network_id, :dm_with, :server_time])
drop index(:messages, [:network_id, :dm_with, :server_time])
```

`EXPLAIN QUERY PLAN` on a real `Scrollback.fetch({:user, ...}, ..., peer,
nil, 100)` against a populated DB before+after to confirm both arms of
the OR pick the new composites. Migration is additive (no data shape
change).

---

## MEDIUM

### M1. `Scrollback.Meta` silently downgrades non-allowlisted atom keys to strings — closed-set discipline lost

**Module:** persistence/ | **File:**
`lib/grappa/scrollback/meta.ex:118-128`
**Category:** silent degradation / closed-set escape hatch

`normalize_key/1` is the load/cast/dump shared key-normalizer. For
atom inputs:

```elixir
defp normalize_key(k) when is_atom(k) do
  if k in @known_keys, do: k, else: Atom.to_string(k)
end
```

If a producer writes `meta: %{tagret: "x"}` (typo) or any field that
isn't in the 6-entry allowlist (`target | new_nick | modes | args |
numeric | severity`), the cast/dump path silently STRINGIFIES the
key. The moduledoc claims keys outside the allowlist "round-trip as
strings (defensive)" — but that's only useful if the *operator can
observe the drift*. Today: the changeset accepts the input, the row
inserts cleanly, the schema layer's `Ecto.Type` contract pretends it
fits `%{optional(:target | :new_nick | ...) => term()}`, and Dialyzer
has no way to see the lie because the type is enforced AT cast time
on a struct field whose type is the union, not the cast input.

The original closed-set discipline (CLAUDE.md "Atoms or `@type t ::
literal | literal` — never untyped strings for closed sets") is gone
the moment any producer writes a non-allowlisted atom key — they
get silent string keys + a misleading `Meta.t()` declaration.

CLAUDE.md's "Total consistency or nothing" applies: half-typed is
worse than untyped.

**Fix:** Either (a) crash at cast/dump on non-allowlisted atom keys —
`raise ArgumentError, "unknown meta key: #{inspect(k)}"` — so producers
fail loudly, OR (b) drop the allowlist altogether and document `meta`
as a free-form string-keyed map (the safe-by-construction shape, but
losing the atom-keyed Elixir-side ergonomics). Don't keep both
half-doors. (a) is safer because Phase 5+ is meant to light the
allowlist up — drift between producer + allowlist will surface later
as a mystery `kind: "kick", meta: %{"tagrt" => "alice"}` row that
nothing renders.

### M2. `Grappa.QueryWindows.windows_list_payload` typedoc is stale post-Wire extraction

**Module:** persistence/ | **File:** `lib/grappa/query_windows.ex:80-84`
**Category:** dead/stale type contract

The typedoc was written when `broadcast_windows_list/2` shipped raw
`%Window{}` structs (the BUG that CP15 B6 fixed). After the Wire
extraction, the broadcast payload is

```
%{kind: "query_windows_list", windows: %{integer() => [Wire.windows_entry()]}}
```

but the `@type windows_list_payload` still declares
`%{kind: String.t(), windows: %{integer() => [Window.t()]}}` — pointing
at the schema struct that the Wire module exists explicitly to NOT
emit over the wire. The type is also unreferenced by any `@spec`
(grep'd: zero call sites), so it's living documentation that
contradicts the actual contract Phase 6's IRCv3 listener / cic side
will read against.

Same shape as the next item.

**Fix:** Either delete the type (it's unreferenced) OR re-derive it
from `Wire.windows_map/0`:

```elixir
@type windows_list_payload :: %{kind: String.t(), windows: Wire.windows_map()}
```

and reference it from `broadcast_windows_list/2`'s `@spec`.

### M3. `GrappaWeb.GrappaChannel.query_windows_list_payload` typedoc duplicates M2's stale shape

**Module:** persistence/ (cross-cutting) | **File:**
`lib/grappa_web/channels/grappa_channel.ex:162-166`
**Category:** dead/stale type contract — wire-shape drift

Identical issue to M2 but on the Channel side: declares
`windows: %{integer() => [QueryWindows.Window.t()]}` despite the
channel pushing `Wire.render_grouped(...)` output, which is
`[Wire.windows_entry()]`. Two stale declarations of the same
shape — exactly the parallel-structure-drift class CLAUDE.md's
wire-module rule was added to prevent.

**Fix:** Reference `QueryWindows.Wire.windows_map/0` from the Channel
typedoc OR delete and let Wire be the single source of the type.
Ideally both M2 and M3 collapse to a single Wire-owned type referenced
by both.

### M4. Wire-shape inconsistency: `Scrollback.Wire` emits `kind:` as ATOM, `QueryWindows.Wire` (and every other event) emits `kind:` as STRING

**Module:** persistence/ | **Files:** `lib/grappa/scrollback/wire.ex:88`,
`lib/grappa/query_windows.ex:209`,
`lib/grappa_web/channels/grappa_channel.ex:671`
**Category:** wire-shape inconsistency / cross-context drift

`Scrollback.Wire.message_payload/1`:

```elixir
def message_payload(%Message{} = m) do
  %{kind: :message, message: to_json(m)}
end
```

declares `@type event :: %{kind: :message, message: t()}` — atom literal.

`QueryWindows.broadcast_windows_list/2` AND
`GrappaChannel.push_query_windows_list/2`:

```elixir
%{kind: "query_windows_list", windows: windows}
```

use a string. Same goes for `kind: "joined"`, `kind: "kicked"`,
`kind: "join_failed"` etc. emitted by `Session.Server` apply_effects
(per CP15 checkpoint).

Both ship the same way over Jason (atoms encode as JSON strings), so
cic doesn't see a difference. But on the *server side*:

- `match?(%{kind: :message}, payload)` works for Scrollback events,
  silently fails for every other event.
- A future internal subscriber that pattern-matches `kind:` as an
  atom for one event and a string for another will hit obscure
  ordering bugs.
- Phase 6's IRCv3 listener (different serializer, same domain
  events) loses the convention to lean on.

CLAUDE.md "Atoms or `@type t :: literal | literal` — never untyped
strings for closed sets" argues for atoms across the board. The
`kind` field of every wire event is exactly such a closed set.

**Fix:** Pick one and apply it to ALL Wire modules + all places that
emit `kind:` over PubSub/Channels. Atom is preferred per CLAUDE.md
(e.g. `kind: :query_windows_list`, `kind: :joined`); requires
extending Wire types accordingly. Per "Total consistency or nothing,"
do not migrate half — sweep every emitter in one shot.

### M5. Migration `add_dm_with_to_messages` pattern-fragility re: future check-constraint rebuilds

**Module:** persistence/ | **File:**
`priv/repo/migrations/20260507151920_add_dm_with_to_messages.exs`
+ `priv/repo/migrations/20260504020002_check_constraints_caps_auth_method_messages_kind.exs:316-347`
**Category:** migration coupling / latent breakage on future rebuild

The CHECK-constraints migration recreates `messages` with an explicit
column list in `recreate_messages_with_check/0`. CP14 B3 then adds
`dm_with` via plain ALTER. If a future migration needs to rebuild
`messages` (e.g. add another CHECK, change another FK), the author
will copy the existing `recreate_messages_with_check/0` template
which DOES NOT include `dm_with` — the column will silently disappear
on the rebuild because the `INSERT INTO ... SELECT` won't carry it
either.

This isn't a bug today. It's a footgun pinned for the next person
who edits a `messages` migration.

**Fix:** Add a comment block at the top of
`20260504020002_check_constraints_caps_auth_method_messages_kind.exs`
saying "any future table-recreate of `messages` must also include
every additive column landed AFTER this migration (`dm_with` as of
20260507151920, ...)". Better: a test that reads the live schema
post-migrate and asserts every column the schema module declares is
present in the DB. Catches this drift class for the whole codebase,
not just messages.

### M6. `QueryWindows.Window.changeset/2` missing `assoc_constraint`s — bad FK surfaces as raw DB error

**Module:** persistence/ | **File:**
`lib/grappa/query_windows/window.ex:48-54`
**Category:** Phoenix/Ecto convention deviation

The changeset casts `:user_id` and `:network_id` and validates
presence, but does NOT add `assoc_constraint(:user)` or
`assoc_constraint(:network)`. Compare `Scrollback.Message.changeset/2`
which adds both (lines 205-207). Bad FK input from a context caller
will hit the DB layer and raise `Ecto.ConstraintError` instead of
returning a clean `{:error, %Ecto.Changeset{}}` per the documented
contract `{:ok, Window.t()} | {:error, Ecto.Changeset.t()}` on
`open/4`.

The contract's exception path is therefore unreachable via the type
declared and reachable only via FunctionClauseError / ConstraintError
that callers can't pattern-match cleanly. Phoenix-layer
FallbackController error mapping won't render the FK violation as a
422 — it will 500.

**Fix:**

```elixir
|> assoc_constraint(:user)
|> assoc_constraint(:network)
```

Plus a test asserting that `open/4` with a non-existent `user_id`
returns `{:error, changeset}` with `errors[:user]` populated.

### M7. `Scrollback.list_archive/3` `target_kind` derivation tied to `dm_eligible?` / `nick_shaped?` predicates by convention only — three call sites, three private clones of the same sigil set

**Module:** persistence/ | **File:** `lib/grappa/scrollback.ex:157-162,
269-273, 303-308`
**Category:** duplicated predicate / drift risk

The sigil set `[?#, ?&, ?!, ?+]` appears THREE times in this file:

1. `nick_shaped?/1` (line 159) — used by `dm_peer/4` for outbound
   detection.
2. `target_kind/1` (line 270) — used by `list_archive/3` to derive
   `:channel` vs `:query`.
3. `dm_eligible?/1` (line 305) — used by `channel_or_dm_where/2` to
   decide whether to UNION the dm_with branch.

The three predicates are spec'd to mirror each other — the moduledoc
on `target_kind/1` says "Mirrors `dm_eligible?/1`'s sigil set so the
active/archive split + the DM-eligibility predicate stay
byte-aligned." But there is no compile-time enforcement that they
stay in sync; if Phase 6 needs to add `~` (a ConferenceRoom mode
sigil per RFC 2811), the author will edit one and forget the other
two — and `list_archive/3`'s "kind derivation" mirrors `dm_peer/4`'s
"is this a channel?" question, so the drift will manifest as
asymmetric archive entries (a `~chan` row marked `:query` while the
fetch path treats it as a channel).

CLAUDE.md "Implement once, reuse everywhere": the sigil set is one
domain fact that appears three times here, plus the same set under a
fourth predicate in
`priv/repo/migrations/20260507151920_add_dm_with_to_messages.exs:124-126`
as a SQL fragment — four sites total.

**Fix:** Hoist to `Grappa.IRC.Identifier.channel_sigil?/1` (or
similar) and call it from all three Scrollback predicates. The SQL
fragment in the migration can stay verbatim — that's a snapshot of
historical truth. New code should depend on the helper.

### M8. `Scrollback.persist_event/1` `@spec` declares `dm_with` as `String.t() | nil` but caller-side typespec contract is informal

**Module:** persistence/ | **File:** `lib/grappa/scrollback.ex:94-105`,
`lib/grappa/scrollback/message.ex:140`
**Category:** type-system underuse

`dm_with` is restricted in practice to (a) `nil` for non-PRIVMSG /
non-DM rows and (b) a nick-shaped string for DMs. The `@spec` on
`persist_event/1` and the `@type t` on `Message` both type it as
`String.t() | nil`, accepting any binary including channel-shaped
strings. Nothing prevents an EventRouter bug from putting `"#chan"`
into `dm_with` — the changeset doesn't `validate_change(:dm_with,
fn -> ... end)` to enforce nick-shape.

The caller convention is documented in `Scrollback.dm_peer/4`'s
moduledoc, but there's no boundary-side validation. A regression in
EventRouter's `build_persist/6` would silently corrupt the column
shape and pollute every subsequent `Scrollback.fetch/5` for the
"peer" until a manual scrub.

**Fix:** Add `validate_change(:dm_with, ...)` in `Message.changeset/2`
that asserts `is_nil(value) or Identifier.valid_nick?(value)`. Mirrors
the existing `validate_identifier(:channel, ...)` pattern (line 202).
Catches EventRouter regressions at insert time.

---

## LOW

### L1. `Grappa.Scrollback.Wire.to_json/1` field set is implicit — schema additions silently fall off the wire

**Module:** persistence/ | **File:** `lib/grappa/scrollback/wire.ex:57-68`
**Category:** maintainability / drift trap

The map literal in `to_json/1` enumerates 8 fields by hand. `Message`
recently added `dm_with` (CP14 B3) — wire intentionally omits it
(server-side normalization detail, cic doesn't need it on the wire).
Future schema additions face the same silent decision: omitting from
`to_json/1` is a passive choice, not an active "don't ship this"
declaration. A field that SHOULD be on the wire could be missed.

**Fix:** Add a comment in `to_json/1` listing every Message field
explicitly with `# wire: yes` or `# wire: no — <reason>` so the next
adder makes a deliberate call. Or, more rigorously, a unit test that
reflects on `Message.__schema__(:fields)` and asserts every field is
either in `Wire.to_json/1` output OR in an explicit `@wire_excluded`
list. Defer until the next field decision actually gets missed.

### L2. `Grappa.Scrollback.Message.@kinds` and `Meta.@known_keys` allowlists are coupled by convention, not contract

**Module:** persistence/ | **File:**
`lib/grappa/scrollback/message.ex:89-100`,
`lib/grappa/scrollback/meta.ex:84,93`
**Category:** parallel-structure drift

The per-kind shape table in `Meta`'s moduledoc (lines 56-64) maps
each `Message.kind()` to the meta keys it uses. The `@known_keys`
allowlist must include every key any kind references. There is no
compile-time check; adding a new `:kind` with new `meta` fields
requires extending two lists.

`Meta.known_keys/0` is exposed for "test-suite assertions" but
there's no analogous `Message.kind_meta_keys/1` returning the
expected key set per kind that a test could cross-reference.

**Fix:** Add a unit test that exercises the per-kind shape table by
constructing a `Message.changeset` for each `kind()` with the
documented meta keys and asserting it casts cleanly. Catches drift
when a new kind lands without its meta keys reaching the allowlist.

### L3. `Grappa.QueryWindows.fetch_existing/3` "unreachable" branch returns a freshly-built changeset that misleads callers

**Module:** persistence/ | **File:**
`lib/grappa/query_windows.ex:230-244`
**Category:** error-shape drift / unreachable-branch hygiene

The comment says "this path is effectively unreachable in production,"
yet the branch returns a `{:error, Ecto.Changeset.t()}` constructed
by re-running `Window.changeset/2` over the same valid attrs — that
changeset will have NO errors (it casts cleanly; the original error
was a *DB* race, not a validation failure). Callers pattern-matching
`{:error, %Ecto.Changeset{} = cs}` will see `cs.valid? = true` and
no errors, breaking their error-rendering contract.

If the path is truly unreachable, raise instead. If it's reachable
under any operational scenario (manual delete during the conflict
window, FK cascade fired between insert + re-select), return a
changeset with an actual error attached
(`add_error(cs, :base, "race lost — retry")`).

**Fix:** Replace with `raise "QueryWindows.open/4: race-lost re-select
returned nil — should be unreachable in normal operation"`. Crashing
the process is the correct response per CLAUDE.md "let it crash" —
this would only fire on FK corruption or a manual SQL delete during a
ms-wide window. Operator sees a stack trace; the request retries
cleanly. Don't fabricate a fake-valid changeset.

### L4. `add_visitor_id_to_messages.exs` raw-SQL CREATE TABLE doesn't include `dm_with` — symmetric with M5 but for the down-migration path

**Module:** persistence/ | **File:**
`priv/repo/migrations/20260502085339_add_visitor_id_to_messages.exs:73-95`
**Category:** rollback breakage

The `down/0` of this migration recreates the post-state table layout
(pre-CHECK-constraints, pre-dm_with). Rolling back from the CP14 B3
state past this migration (e.g. `mix ecto.rollback --step 5` for a
disaster recovery) would `INSERT INTO messages ... SELECT ...` from
`messages_new` which DOES carry `dm_with` and `visitor_id` rows;
`dm_with` would be silently dropped, `visitor_id` rows would
silently disappear. The migration's `down/0` predates both — it can
only know about the original world.

This is a fundamental property of additive Ecto migrations against
sqlite-via-table-recreate, but worth a comment block: "Down-migration
through this point assumes no later migration has added columns;
operators should `mix ecto.rollback --to <stamp>` rather than
`--step` past additive ALTER TABLE migrations to avoid silent
column loss." Doc-only mitigation; the structural problem is
accepted.

**Fix:** Add the documented warning to the moduledoc, OR mark the
down-migration with `raise "downward migration from CP14+ state is
not supported — see DESIGN_NOTES sqlite-rollback policy"`. Pick
the lighter intervention; this is operator-facing not user-facing.

### L5. `Window.target_nick` schema field has no max length / nick-shape validation

**Module:** persistence/ | **File:**
`lib/grappa/query_windows/window.ex:53`
**Category:** boundary validation gap

`validate_length(:target_nick, min: 1)` rejects empty strings but
not 10MB strings; not nick-shape (`Identifier.valid_nick?/1`).
`Grappa.QueryWindows.open/4`'s parameter receives a `String.t()`
from cic-side input via the channel handler — a hostile or
malformed input lands in the unique index expression
`lower(target_nick)` and gets stored. Same shape as M-pers-1 in
the 2026-05-03 review (client_id length cap), and same fix
pattern.

**Fix:** Add `validate_length(:target_nick, max: 64)` (RFC 2812
nick max is 9 but extensions go higher; 64 is a safe bouncer-side
cap) AND `validate_change(:target_nick, fn _, v -> if
Identifier.valid_nick?(v), do: [], else: [target_nick: "is not a
valid IRC nick"] end)`.

### L6. `messages.meta` column lacks an `Application.compile_env`-style assertion that producer-side allowlist matches DB content

**Module:** persistence/ | **File:**
`lib/grappa/scrollback/meta.ex` (whole module)
**Category:** untestable drift

The Meta type allowlist + the DB content evolve independently. A
production DB rebuilt from CHECK-constraint migration may carry rows
written under an older allowlist (e.g. with a `numeric` key that
didn't exist before some commit). The load path tolerates unknowns
silently. There's no boot-time / migration-time check that asserts
"every distinct key appearing in `messages.meta` blobs is currently
allowlisted."

Operationally low-impact (mix tasks could surface this), but it's
a cleanup parallel structure that needs housekeeping. Defer until
Phase 5+ presence-event producers actually start lighting the
allowlist up.

**Fix:** A `mix grappa.audit_meta` task (Phase 5) that scans
`messages.meta` JSON for keys + cross-references with
`Meta.known_keys/0`, emitting any drift. Not a code change here;
log for the Phase 5 ops cluster.

---

## Notes

- The Wire-module pattern has landed correctly — both
  `Grappa.Scrollback.Wire` and `Grappa.QueryWindows.Wire` are
  single-source for their respective contexts, both delegate from
  Channel + PubSub call sites, and both crash loudly on unloaded
  associations (Wire.to_json's `%Network{slug: _}` pattern). The
  CP15 B6 Jason-crash class is closed at the structural level.
- Migration sequencing for the table-recreate pattern (CHECK
  constraints + `defer_foreign_keys`) is well-documented in
  `20260504020002`'s moduledoc; the lessons are pinned in-tree
  (the post-mortem comment block from "First-deploy attempt failed
  in prod with `Exqlite.Error: FOREIGN KEY constraint failed`").
- `Scrollback.persist_event/1` correctly uses `Repo.insert/2` with
  a Changeset (CLAUDE.md compliance) and preloads `:network` so the
  Wire's `%Network{slug: _}` pattern doesn't crash. No raw
  `Repo.insert/2` violations in scope.
- `:dm_with` body backfill in the migration is correct (uses
  schema-free Ecto.Query so future schema renames don't break the
  migration) and the heuristic is documented.
- Charset rule: every text column uses `:string` or `:text`
  (sqlite TEXT) and the schema layer converts at the boundary.
  No charset-rule violations in scope.
- CTCP `\x01` preservation: `Message.body` is `:string` — no
  stripping is performed at the schema layer. Compliant with
  CLAUDE.md.
- Default args via `\\`: zero usages in scope.
- `Application.get_env` runtime reads: zero in scope.
- `Logger.metadata` keys: scope doesn't add new metadata keys.

---

# lifecycle/

# Lifecycle line-level review — 2026-05-08

**Scope:** `lib/grappa/{application,bootstrap,release,repo,session}.ex`
+ `lib/grappa/session/{server,event_router,numeric_router,backoff,
ghost_recovery,mode_chunker,ns_interceptor}.ex`.

**Method:** Read CLAUDE.md, DESIGN_NOTES, CP15 checkpoint, the
2026-05-03 review (whose lifecycle HIGH/MEDIUM findings are
re-checked here), `docs/reviewing.md`. Re-checked the prior round's
M-life-1..5 — all materially addressed (rescue ArgumentError on
ETS reads in Backoff; spawn_with_admission/6 unifies user + visitor;
tri-counter `skipped` distinct from `failed`; Backoff.reset on
spawn_with_admission). H6/H7 (`NetworkCircuit` race) live in
`lib/grappa/admission/` — out of scope for this lifecycle agent.

PROBLEMS-ONLY below. No CRITICAL.

---

## HIGH

### S1. `apply_effects([{:joined, ch} | _])` does not strip `state.in_flight_joins[ch]`

**Module:** lifecycle | **File:** `lib/grappa/session/server.ex:1712-1736`,
`lib/grappa/session/event_router.ex:202-251`
**Category:** state-machine drift / documented-invariant violation

Self-JOIN echo path: `EventRouter.route(:join, _)` emits `[{:persist,
:join, _}, {:joined, channel}]` when sender == state.nick (server.ex
clause `:join` at event_router.ex:243-248). `Session.Server.apply_effects`
arm for `:joined` (server.ex:1712-1736) writes `window_states[ch] =
:joined` and clears the three failure-mirror maps — but **never
deletes the corresponding `in_flight_joins[String.downcase(channel)]`
entry**. The CP15 B2 type doc (server.ex:188-205) explicitly states:
"entry is stripped on either resolution" (success-echo OR failure
numeric); EventRouter strips on failure (event_router.ex:698) but
nothing strips on success.

Real consequences:

  1. Stale entries linger up to 30s (the lazy TTL bound at
     server.ex:2030-2045). Bounded — won't leak unboundedly — but the
     in-flight predicate (e.g. for future "JOIN already pending,
     debounce" UX) sees ghosts.
  2. A race window: if upstream emits a 471/473 numeric within the
     30s TTL **after** a successful self-JOIN echo, EventRouter's
     `@join_failure_numerics` clause (event_router.ex:688-704)
     correlates against the still-present entry, emits
     `{:join_failed, ...}`, and the `:join_failed` apply_effects arm
     overwrites `window_states[ch]` from `:joined` back to `:failed`.
     A weird unsolicited mid-session 471 (rare but possible — bahamut
     emits 473 if you flap +i mid-session and a stale message
     re-arrives) would corrupt the window state machine.
  3. The CP15 B2 invariant ("entry is stripped on either
     resolution") is documented but not enforced — exactly the
     CLAUDE.md "directions over code" failure mode.

**Fix:** Extend the `:joined` apply_effects arm to also do
`in_flight_joins: Map.delete(state.in_flight_joins,
String.downcase(channel))`. Mirror the `:join_failed` arm in
EventRouter that already handles the failure side. Cover with a unit
test asserting in_flight_joins has no key after self-JOIN echo lands.

### S2. `handle_info({:EXIT, client_pid, reason}, %{client: client_pid})` records a backoff failure on `:shutdown` / `:normal` from the linked Client

**Module:** lifecycle | **File:** `lib/grappa/session/server.ex:976-989`
**Category:** OTP semantics — false-positive failure accounting

Clause ordering at server.ex:976-989:

```elixir
def handle_info({:EXIT, client_pid, reason}, %{client: client_pid} = state)
    when client_pid != nil do
  :ok = Backoff.record_failure(state.subject, state.network_id)
  {:stop, {:client_exit, reason}, %{state | client: nil}}
end

def handle_info({:EXIT, _, reason}, state)
    when reason == :shutdown or reason == :normal do
  {:stop, reason, state}
end
```

The first clause matches ANY EXIT from `state.client` regardless of
reason. The second clause's `:shutdown | :normal` filter only takes
effect for EXITs whose pid is NOT `state.client` — but any clean
shutdown of the linked Client would still be from `state.client`.

In practice today the Client crashes ungracefully (k-line, tcp_closed,
etc.) so the path is exercised correctly. But:

  1. Defensive shape — a future code path that calls
     `Client.stop(state.client)` from this Session for a clean
     teardown (e.g. T32 disconnect verb landing soon, per
     `project_t32_disconnect_verb` memory) would see the Client exit
     `:normal`, this clause records a spurious Backoff failure,
     poisoning the next reconnect.
  2. Symmetry — the `:shutdown | :normal` clause's existence is
     pointless until a non-`state.client` linked process exists.
     There's only one linked spawn (Client) per Session per the
     init/1 docstring, so the second clause is unreachable today.

**Fix:** Tighten the first clause's reason guard:
`when client_pid != nil and reason != :normal and reason != :shutdown`,
falling through to the second clause for clean Client exits. Or, more
defensively, classify reasons inline (record failure only on
`{:tcp_closed, _}`, `{:connect_failed, _}`, etc.; clean exits don't
poison Backoff).

### S3. `auto_away_debounce_fire` stale timer can prematurely set auto-away

**Module:** lifecycle | **File:** `lib/grappa/session/server.ex:946-968`
**Category:** timer-cancel race

`handle_info({:ws_all_disconnected, _}, state)` (server.ex:946-956)
schedules a 30s `:auto_away_debounce_fire` timer. Before scheduling,
it calls `Process.cancel_timer(state.auto_away_timer)` WITHOUT the
`async: true, info: true`-or-`:flush` option:

```elixir
_ =
  if is_reference(state.auto_away_timer) do
    Process.cancel_timer(state.auto_away_timer)
  end

timer = Process.send_after(self(), :auto_away_debounce_fire, @auto_away_debounce_ms)
```

`Process.cancel_timer/1` returns the ms remaining OR `false` if the
timer has already fired (message already in the mailbox). Without
`Process.cancel_timer(ref, async: false, info: false)` followed by a
selective receive flush — or simply checking the return value — the
stale `:auto_away_debounce_fire` may already be sitting in the
mailbox when this clause runs.

Replay: rapid two `:ws_all_disconnected` events ~30s apart, the first
fires the timer message into the mailbox, the second arrives BEFORE
the GenServer drains the first. The second cancels the (already
fired) timer (no-op), schedules a fresh one. The handler then
processes the OLD message first → `set_auto_away_internal` runs at
T=30s (instead of T=60s). User sees AWAY status ~30s sooner than the
debounce contract promises.

The handler at server.ex:961-968 nullifies `state.auto_away_timer`
when it fires; this clobbers the reference to the NEWLY-scheduled
timer. The new timer's eventual fire then runs `set_auto_away_internal`
again — idempotent on `:away_auto` (it just re-sends `AWAY` upstream
+ resets `away_started_at`), but the upstream sees TWO `AWAY` lines
and `away_started_at` jumps forward, breaking the away-window
boundary that `maybe_broadcast_mentions_bundle/1` (server.ex:2229-
2268) uses to aggregate mentions on unset. Mentions in the second
30s window are missed.

Same shape at server.ex:923 (`:ws_connected` cancel path) — but
that one only matters if a stale fire could arrive after the
:present transition; less harmful, but identical defensive issue.

**Fix:** Use `Process.cancel_timer(ref, info: true)` and pattern-match
the `false` (already-fired) return to drain the message via a
selective receive: `receive do :auto_away_debounce_fire -> :ok after
0 -> :ok end`. Single helper `cancel_and_drain/2` since the same
shape appears at server.ex:923, 951, 1454, 1474, 1960.

---

## MEDIUM

### S4. `Session.send_nick/3` does not validate nick syntax — only CRLF/NUL

**Module:** lifecycle | **File:** `lib/grappa/session.ex:353-362`,
`lib/grappa/session/server.ex:586`
**Category:** input-validation gap, contradicted by code comment

`Session.send_nick/3` gates on `Identifier.safe_line_token?(new_nick)`
only — that predicate (irc/identifier.ex:124-128) ONLY rejects `\r` /
`\n` / `\x00`. A nick with spaces, with `!`/`@`, with channel-prefix
chars, or empty will pass the gate.

server.ex:586 carries a comment claiming the opposite:

> labeled-response active: inject tag prefix. Nick validation is skipped
> here because the label prefix must wrap the full line; Client.send_line
> is the raw path. **The Session facade pre-validates the nick before this
> handler fires (Identifier.valid_nick? check in Session.send_nick/4).**

There IS no `Session.send_nick/4`, and `send_nick/3` does not call
`valid_nick?`. The comment is a load-bearing falsehood: a future
contributor reads it, trusts the facade has validated, ships a feature
that injects the unvalidated nick into a labeled-response `@label= ...
NICK <nick>\r\n` string. Whatever upstream-side parser quirks the IRCd
has on a malformed NICK become this bouncer's problem.

**Fix:** Add `Identifier.valid_nick?/1` check to `Session.send_nick/3`
returning `{:error, :invalid_nick}` on failure (extend the type).
Update the type signature + comment so the next reader doesn't
re-introduce the same gap.

### S5. `EventRouter.route` emits `:visitor_r_observed` from a USER session by structural design

**Module:** lifecycle | **File:** `lib/grappa/session/event_router.ex:389-401`,
`lib/grappa/session/server.ex:1933-1964`
**Category:** half-typed boundary — runtime check papered over a typing failure

EventRouter's user-MODE-on-self clause at event_router.ex:389-401:

```elixir
def route(%Message{command: :mode, params: [target, modes | _]}, state)
    when ... target == state.nick do
  effects =
    case {set_r_mode?(modes), Map.get(state, :pending_auth)} do
      {true, {pwd, _}} -> [{:visitor_r_observed, pwd}]
      _ -> []
    end
  {:cont, state, effects}
end
```

Pure router emits `:visitor_r_observed` whenever `:mode +r` arrives
and `pending_auth` is staged — irrespective of whether `state.subject`
is `{:user, _}` or `{:visitor, _}`. server.ex:1933-1956's
apply_effects arm then case-matches on the subject and logs
`Logger.warning("visitor_r_observed effect on user session — ignored")`
for the user case. So the type system says "this effect can fire for
either subject" and the runtime say "but if it does for user, we just
warn and drop."

Three problems:

  1. The effect type isn't actually polymorphic; it's specifically
     visitor-only. Naming + emission contract should match: emit only
     when subject is visitor.
  2. The "ignore + warn" path can only be exercised by an operator
     manually issuing IDENTIFY on a user session and the upstream
     setting +r. Today this would re-stage `pending_auth` for a user,
     fire the effect, log the warning, AND clear `pending_auth` (line
     1963) — but the captured password silently vanished. Operator
     thinks NickServ identification ran; bouncer dropped the side
     effect.
  3. Half-typed boundary. CLAUDE.md "Total consistency or nothing":
     the contract should be that `:visitor_r_observed` effects exist
     only for visitor sessions. Today the type admits otherwise +
     the runtime carries dead-but-warning code.

**Fix:** Move the subject discriminator INTO EventRouter — gate the
`:visitor_r_observed` emission on `match?({:visitor, _}, state.subject)`.
The user-side ignore arm in apply_effects becomes unreachable +
removable. If a user session needs to react to +r (e.g. operator-run
IDENTIFY confirmation telemetry), add a separate `:user_r_observed`
effect with explicit semantics — don't piggyback on the visitor
machinery.

### S6. `flush_lines` crashes the Session on Client.send_line `{:error, :invalid_line}`

**Module:** lifecycle | **File:** `lib/grappa/session/server.ex:1491-1502`
**Category:** assertive `:ok =` on a path that returns `{:ok, _} | {:error, _}`

`flush_lines/2` is the GhostRecovery-emitted-line dispatcher:

```elixir
defp flush_lines(state, lines) do
  Enum.reduce(lines, state, fn line, acc ->
    ...
    :ok = Client.send_line(acc.client, line)
    acc
  end)
end
```

`Client.send_line/2` returns `:ok | {:error, :invalid_line}` (per the
S29 C1 comment at server.ex:1388-1391). The `:ok = ...` match crashes
the Session on `{:error, _}`. GhostRecovery emits hardcoded shapes
(`"NICK #{try_nick}\r\n"`, `"PRIVMSG NickServ :GHOST #{orig} #{pwd}\r\n"`,
etc. — ghost_recovery.ex:80-110), so:

  - if `try_nick = orig <> "_"` happens to contain CRLF/NUL because
    `orig` did (NICK injection from upstream's 433 echo of an
    operator-typed bad nick) — crash.
  - if `pwd` contains a space that turns the GHOST line malformed —
    won't crash on the safe_line_token check (only CRLF/NUL), but
    multi-arg PRIVMSG-shaped wire is implementation-tolerant.

The single concrete crash path is operator-typed nick or visitor
nick from the DB containing CRLF/NUL. The DB write path already gates
this — but a nick with embedded backslash-`r` decoded to `\r` post-DB
read could surface. Defensive `:ok = ...` here is not "let it crash"
— it's "let an unrelated input bug crash a critical-path Session."

The right shape: log the error + return `acc` unchanged. Crash means
the linked Client's exit triggers the `{:EXIT, ...}` handler which
records a Backoff failure and respawns — for what is fundamentally a
caller-side input bug, not a connection problem.

**Fix:** Replace the `:ok = ...` with a case that warns + drops the
line (mirrors `Logger.warning("autojoin skipped: invalid channel
name", channel: inspect(channel))` at server.ex:1020 — same pattern,
applied to the GhostRecovery line). The acc accumulator stays
unchanged on failure.

### S7. `Bootstrap.start_link/1` underspecified — `Task.start_link` can return `{:error, _}`

**Module:** lifecycle | **File:** `lib/grappa/bootstrap.ex:175-176`
**Category:** Dialyzer-correctness / false-positive risk

`@spec start_link(term()) :: {:ok, pid()}` — but
`Task.start_link/3` returns `GenServer.on_start()` shape: `{:ok, pid}
| {:error, reason}`. The narrower spec is a lie that Dialyzer doesn't
catch because the body matches the spec in the success case.

Per CLAUDE.md "State the contract": the spec IS the contract.
Underspecifying hides failure paths. If `Task.start_link` ever
returned `{:error, ...}` (e.g. the supervisor's restart budget was
exhausted), the supervisor's `start_child` cascade would crash with a
`MatchError` — except that a Bootstrap as a `:transient` task
inherently cannot recover via `start_link/1` shape (the `Task` module
swallows it).

**Fix:** Tighten to `@spec start_link(term()) :: {:ok, pid()} |
{:error, term()}`. Or, since the production caller (the supervisor
child spec) ignores the return and Bootstrap-the-Task can't fail at
start_link time today, simplify the function body assertion:
`{:ok, pid} = Task.start_link(...)` makes the lie an explicit crash
shape rather than a quiet type mismatch.

### S8. `pending_password_from_opts/1` for `auth_method: :nickserv_identify` with `password: nil` falls through to nil — silent capability degradation

**Module:** lifecycle | **File:** `lib/grappa/session/server.ex:439-444`
**Category:** silent fallback / ambiguous contract

```elixir
defp pending_password_from_opts(%{auth_method: :nickserv_identify, password: pw})
     when is_binary(pw),
     do: pw

defp pending_password_from_opts(_), do: nil
```

If a `Networks.SessionPlan` resolves a credential with
`auth_method: :nickserv_identify` but `password: nil` (validation gap
upstream — a bind-network mix task that didn't enforce password
present for the NickServ method), the catch-all silently returns
`nil`. `Session.Server` boots, AuthFSM emits no IDENTIFY, no +r
observation fires, no scrollback row marks the failure. Operator
sees a happy session that silently lacks NickServ auth.

The clean shape: crash loud at SessionPlan.resolve time
(`{:error, :missing_nickserv_password}`) so Bootstrap routes it to
the `failed` counter and the operator gets a log line. If the
catch-all is meant to handle `:none | :sasl_plain | :server_pass`,
write THOSE clauses explicitly + leave the malformed-input case as a
function-clause crash.

**Fix:** Add an explicit clause `defp pending_password_from_opts(%{
auth_method: :nickserv_identify, password: nil}), do: raise
ArgumentError, "nickserv_identify requires password"`. Then the
SessionPlan resolver gets a hard signal at boot. CLAUDE.md "errors
are loud, not silent."

### S9. `Bootstrap.spawn_visitor/2`'s `Networks.get_network_by_slug` lookup duplicates a hard-fail invariant already enforced

**Module:** lifecycle | **File:** `lib/grappa/bootstrap.ex:274-318`
**Category:** dead defensive code / inconsistency with documented invariant

`spawn_visitor/2` calls `Networks.get_network_by_slug(plan.network_slug)`
and handles `{:error, reason}` by incrementing `failed` (line 297-
305). But `validate_visitor_networks!/1` at bootstrap.ex:394-416
runs BEFORE the spawn loop and HARD-RAISES on the same condition
(orphan visitor → unresolvable slug):

```elixir
defp validate_visitor_networks!(visitors) do
  orphans = visitors |> Enum.map(&...) |> Enum.reject(...)
  case orphans do
    [] -> :ok
    slugs -> raise RuntimeError, msg
  end
end
```

So the `{:error, :not_found}` branch in `spawn_visitor/2` is dead —
if it ever fired, the supervisor would have already crashed at
`run/0` line 195. CLAUDE.md "Don't duplicate state that already
exists — derive it." Same invariant, two enforcement sites that
disagree on remediation: validate_visitor_networks! REFUSES TO BOOT;
spawn_visitor/2 LOGS AND CONTINUES.

If the design intent is "loud at boot," remove the duplicate
defense. If the intent is "graceful degradation on per-row missing
network," remove the invariant raise + restore the count-to-failed
shape. CLAUDE.md "same problem, same solution" — pick one.

**Fix:** Drop the `Networks.get_network_by_slug` arm in
`spawn_visitor/2`; assert via pattern-match that the lookup succeeds
since `validate_visitor_networks!` ran first. Single enforcement,
one shape. (Keep the `VisitorSessionPlan.resolve` `{:error, _}` arm —
that one IS independent of network presence.)

### S10. `Application.bootstrap_child/0` reads `:start_bootstrap` at supervisor start — BUT the spec is `[] | [Grappa.Bootstrap]`, missing the actual return shape

**Module:** lifecycle | **File:** `lib/grappa/application.ex:119-126`
**Category:** spec drift / Dialyzer signal

```elixir
@spec bootstrap_child() :: [] | [Grappa.Bootstrap]
defp bootstrap_child do
  if Application.get_env(:grappa, :start_bootstrap, true) do
    [Grappa.Bootstrap]
  else
    []
  end
end
```

`[]` is `[]`, `[Grappa.Bootstrap]` is `[atom()]`. The list is then
appended to the `children` list and passed to `Supervisor.start_link/2`,
which expects `[child_spec()]` where `child_spec()` includes a bare
module atom. Spec is technically right but the return type
`[Grappa.Bootstrap]` is the LITERAL atom singleton type — Dialyzer
should accept this, but a future reader may misread "Grappa.Bootstrap"
as "the moduledoc type `Grappa.Bootstrap.t()`" (which doesn't
exist). Cosmetic, but the file already documents the moduledoc-vs-
type confusion class.

**Fix:** `@spec bootstrap_child() :: [Supervisor.child_spec()] |
[]` — or just `[Supervisor.child_spec()]` since `[]` is a valid
child-spec list. Conveys the actual contract.

### S11. `apply_effects([{:join_failed, ...}])` doesn't broadcast on `Scrollback.persist_event` failure path

**Module:** lifecycle | **File:** `lib/grappa/session/server.ex:1752-1812`
**Category:** asymmetric error handling — typed event still broadcasts on persist failure

The `:join_failed` arm:

```elixir
case Scrollback.persist_event(attrs) do
  {:ok, message} ->
    :ok = Grappa.PubSub.broadcast_event(..., Wire.message_payload(message))

  {:error, changeset} ->
    Logger.error("scrollback insert failed for join_failed", ...)
end

:ok =
  Grappa.PubSub.broadcast_event(..., %{
    kind: "join_failed", ...
  })
```

The broadcast of the typed `kind: "join_failed"` event (line 1791-
1802) is OUTSIDE the case — it fires regardless of whether the
scrollback persist succeeded. So on persist failure: cic gets the
typed event (window flips to `:failed`) but the corresponding
scrollback row is missing — the failure-reason notice the user would
expect to see in the channel scrollback never arrives.

The asymmetry mirrors the bug class CP15 B6 fixed for `:persist`
events (where the typed broadcast was missing). Here the typed
broadcast is correct; the omission is the scrollback-row
broadcast on success path inside the case. But the joint contract
(typed event + scrollback row) is broken on persist failure.

Two reasonable shapes:

  1. Synchronously fail-fast: persist failure → don't broadcast the
     typed event either. Window stays at whatever prior state; cic
     learns about the failure on the next snapshot push.
  2. Best-effort: type + log + broadcast typed event, accept the
     missing scrollback row.

The current implicit choice is (2) but it's not documented. The
moduledoc claim "without this push, the notice row exists in the DB
but cic only sees it on the NEXT loadInitialScrollback" (server.ex:
1769-1776) explicitly assumes the persist succeeds.

**Fix:** Decide explicitly. If (1): move the typed broadcast inside
the success arm of the persist case, mirror at server.ex:1843-1854
(`:kicked` arm — has no persist + only the typed broadcast, so no
asymmetry there). If (2): document the failure-mode in the apply_effects
moduledoc + add a telemetry counter
`[:grappa, :session, :join_failed, :scrollback_failed]` so persist
failures aren't invisible.

### S12. `set_explicit_away_internal/3` with a label bypasses `Client.send_away`'s safe_line check + does its own line build

**Module:** lifecycle | **File:** `lib/grappa/session/server.ex:2160-2170`,
`2212-2222`
**Category:** code duplication / bypass-the-helper

Two arms of the away helpers — the labeled and unlabeled paths —
duplicate line-build logic instead of having `Client.send_line`
take an optional label parameter:

```elixir
defp set_explicit_away_internal(state, reason, nil), do:
  ... :ok = Client.send_away(state.client, reason) ...

defp set_explicit_away_internal(state, reason, label) when is_binary(label) do
  :ok = Client.send_line(state.client, "@label=#{label} AWAY :#{reason}\r\n")
  ...
end
```

`Client.send_away/2` presumably gates on `safe_line_token?(reason)`
(per the per-helper invariant in `irc/client.ex` — though the file
isn't in this scope, the idiom is consistent across send_*). The
labeled path uses `Client.send_line` raw, which per
`identifier.ex:120-122` is intentionally NOT guarded. The reason has
been pre-validated by `Session.set_explicit_away/4` (`safe_line_token?`
at session.ex:402), so the validation is ostensibly already done —
but as S4 above shows, the comment at server.ex:586 makes the same
pre-validation claim and is wrong about the predicate being applied.
Trust the facade only when you've actually verified it, and even
then, why duplicate the line-build?

**Fix:** Add `Client.send_away/3` taking optional `label` (default
`nil` — but per CLAUDE.md "no defaults via `\\`" use two arities)
that builds the wire line in one place, gates on
`safe_line_token?(reason)`, and prepends `@label=` if provided.
Mirror at `unset_away_internal/2` (same shape, server.ex:2199-
2222).

---

## LOW

### S13. `Session.Server`'s `state` typespec uses `%{...}` literal but is named `t :: state()` — common confusion landmine

**Module:** lifecycle | **File:** `lib/grappa/session/server.ex:234-323`
**Category:** typespec readability

The `@type state :: %{...}` declaration spans ~90 lines listing every
field of GenServer state. CLAUDE.md "Process state stays small —
anything that must survive a crash goes in Ecto." This struct has
~25 fields and grew 4 in CP15 alone (`window_states`,
`window_failure_reasons`, `window_failure_numerics`,
`window_kicked_meta`). Each is documented well enough but the size
itself is a smell that the next review-cycle should consider
breaking out into a sub-struct (`WindowStates.t()` carrying the
quad-map + a `transition/3` verb). Not a bug today — just observation
for trajectory.

**Fix:** Defer until the next state addition would push the type
past ~30 fields, OR introduce a `Grappa.Session.WindowStates`
sub-context that owns the four CP15 maps + the `:joined / :failed /
:kicked / :parted / :parked` transition verbs. The Server delegates
state mutations through it. Reduces server.ex size + makes the
window-state machine independently testable.

### S14. `Backoff.compute_wait/1` jitter math admits integer overflow at `count` ~ 30+

**Module:** lifecycle | **File:** `lib/grappa/session/backoff.ex:226-234`
**Category:** numeric edge case (theoretical)

```elixir
raw = @base_ms * trunc(:math.pow(2, count - 1))
capped = min(raw, @cap_ms)
```

`:math.pow(2, count-1)` produces a float; at `count = 53` you exceed
`2^52` (float precision limit), at `count ~ 1024` you hit Inf and
`trunc/1` raises. `@cap_ms = 30 * 60 * 1000 = 1.8M`, so the cap kicks
in at `count = 9` (raw = 5_000 * 256 = 1.28M; count = 10 → raw =
2.56M → capped). Nothing reaches count = 53 in practice (the curve
caps at 30min wait; an hourly retry at the cap takes 53h to reach
count = 53 + the failure stream would have to be uninterrupted).

**Fix:** Pre-cap the count before pow: `effective_count =
min(count, ceil(log2(cap_ms / base_ms)) + 1)`. Or use
`Bitwise.bsl(@base_ms, count - 1)` (integer shift, exact, no float
imprecision), capped by `@cap_ms`.

### S15. `record_in_flight_join/2` lazy TTL sweep is O(N) every insert

**Module:** lifecycle | **File:** `lib/grappa/session/server.ex:2030-2045`
**Category:** complexity / scaling note

Every `JOIN` issued (cic-initiated OR autojoin loop) triggers an
`Enum.reject` over `state.in_flight_joins`. For an operator with
50+ autojoin channels, the autojoin reduce loop at server.ex:1014-
1023 calls `record_in_flight_join` 50 times — each call sweeps the
0..50-entry map. Total: O(N²) at boot.

50² = 2500 ops, ~negligible. 500² = 250_000, ~5ms. Bounded. Not a
real perf problem.

But the sweep is documented as "O(1)-amortized" (server.ex:2027) —
which is wrong; it's O(N) per insert, O(N²) for an autojoin batch.
Amortized accounting would require a clock-driven sweep (one
`Process.send_after` per insert, no per-insert scan) OR a `:gb_trees`
keyed by `at_ms`.

**Fix:** Drop the "O(1)-amortized" claim from the doc — it's
misleading. Either accept O(N) per insert (current shape, fine for
≤500 channels) and update the doc, or migrate to a sorted ETS table
keyed by `at_ms` for the sweep.

### S16. `Session.send_nick/4` — the `origin_window` variant — is unreachable from the public facade

**Module:** lifecycle | **File:** `lib/grappa/session/server.ex:576-594`
**Category:** dead code / asymmetric facade

server.ex:576-594 implements `handle_call({:send_nick, new_nick,
origin_window}, _, state)` for labeled-response routing; but
`session.ex` only exposes `send_nick/3`. The 4-arity facade variant
exists for `set_explicit_away` (session.ex:418-428) but not for
`send_nick`. Either the handler is dead code (no caller) or the
facade is missing a sibling.

If S5's channel-client-polish work is expected to wire it, fine —
but flag now to ensure it doesn't ship as orphan code if the wiring
gets descoped. Today an external caller cannot route NICK numerics
back to the originating window via the labeled-response path; only
the internal Session.Server-driven path that doesn't actually
exist.

**Fix:** Add `Session.send_nick/4(subject, network_id, new_nick,
origin_window)` mirroring `set_explicit_away/4`, OR remove the
3-arg `{:send_nick, _, _}` clause until the facade lands. CLAUDE.md
"Don't iterate through 10 wrong approaches" — half-wired feature
state IS the bug.

### S17. `Bootstrap.spawn_with_admission/6` always passes `client_id: nil` for both subject branches

**Module:** lifecycle | **File:** `lib/grappa/bootstrap.ex:246-251, 280-285`
**Category:** consistent today, latent gap for T31 per-client cap

T31 plan 2 (per `project_t31_admission_control` memory) added a
per-(client_id, network_id) cap to admission. Bootstrap legitimately
has no client_id (operator action, not a request from a browser).
Today the per-client cap is silently bypassed for boot-time spawns —
the per-network cap (`max_concurrent_sessions`) is the only gate
that fires.

The semantic is correct (boot-time isn't a client request) but the
contract is implicit: `Admission.check_capacity/1` with
`client_id: nil` skips the per-client check. If a future contributor
tightens admission to refuse `nil client_id` for stricter
production, Bootstrap silently fails for every row.

**Fix:** Either (a) document the `client_id: nil` semantic on
`Admission.check_capacity/1` as "boot-time / non-client subject",
OR (b) use a synthetic `client_id` for bootstrap (e.g. `"bootstrap"`)
that the per-client cap explicitly excludes — making the contract
visible at the call site. (Boundary edge — per the prior review's
H1 + H5 admission boundary findings — recommend (a) since it's
docs-only + bootstrap-the-task is the documented exception site.)

---

# web/

# Line-Level Review — `lib/grappa_web/` — 2026-05-08

**Scope:** every file under `lib/grappa_web/` (endpoint, router, channels,
controllers, JSON views, plugs, helpers). Tests skipped per dispatch
brief. Pre-existing items already filed in `docs/todo.md` and Phase-5
deferrals NOT re-flagged.

---

## HIGH

### W1. `MessagesController.create` accepts `"$server"` as a PRIVMSG target — synthetic pseudo-channel can be smuggled to upstream IRC

**Module:** web/ | **File:** `lib/grappa_web/controllers/messages_controller.ex:107-126`, `lib/grappa_web/validation.ex:47-54`
**Category:** boundary leak / wire-injection

`MessagesController.create/2` runs `validate_target_name(channel)`
before delegating to `Session.send_privmsg/4`. `validate_target_name/1`
explicitly returns `:ok` for the literal `"$server"` per the
moduledoc justification "the synthetic must be accepted here so
`loadInitialScrollback` REST fetch succeeds for the Server window in
cicchetto." That justification is correct for **GET** (fetch
scrollback for the synthetic Server window) — but the same validator
also gates **POST**.

A client `POST /networks/:slug/channels/$server/messages` body
`{"body": "x"}` therefore lands in `Session.send_privmsg(subject,
network_id, "$server", "x")`. `send_privmsg` runs
`Identifier.safe_line_token?("$server")` — true (no CRLF/NUL) — and
casts the IRC line `PRIVMSG $server :x` onto the upstream socket.
Most ircd will treat `$server` as a server-mask PRIVMSG (RFC 2812
§3.3.1: `$<servermask>`) requiring oper privileges, so the operator
will see a `481 :Permission Denied` numeric — but the bouncer also
**persists a scrollback row** for `target = "$server"` from the
single-source echo path (Session.Server's PRIVMSG persist arm runs
before the upstream rejection arrives). Net effect: any authenticated
user can pollute the synthetic Server window with arbitrary
operator-typed text, and the operator's own oper-class permissions
get unintentionally probed on every send.

The two surfaces have different domains: GET on `$server` reads a
synthetic in-DB-only window; POST on `$server` should not exist at
all (the Server window is server-emitted notices/MOTD, not
client-writable).

**Fix:** Split the validator. Keep `validate_target_name/1` for the
GET path. Add `validate_send_target/1` (or re-use
`validate_channel_name/1` plus a nick-shape arm without the
`"$server"` clause) for `MessagesController.create/2`. Add a
regression test that POSTs `{"body": "x"}` to
`/networks/:slug/channels/$server/messages` and asserts 400
`bad_request` plus a Session.Server mailbox audit asserting NO
upstream PRIVMSG was cast.

### W2. `query_windows_list_payload` typespec contradicts the wire-shape invariant CP15-B6 pinned

**Module:** web/ | **File:** `lib/grappa_web/channels/grappa_channel.ex:162-166`
**Category:** stale type / wire-shape drift

CP15 B6 explicitly fixed the Jason-encoder crash by routing
`broadcast_windows_list/2` and the channel-side push through
`Grappa.QueryWindows.Wire.render_grouped/1` (CLAUDE.md
"`Grappa.QueryWindows.Wire`" invariant; checkpoint B6 finding 2).
The runtime push at `grappa_channel.ex:670-671` correctly delegates:

```elixir
windows = user.id |> QueryWindows.list_for_user() |> QueryWindows.Wire.render_grouped()
push(socket, "event", %{kind: "query_windows_list", windows: windows})
```

But the `@typedoc`-level contract still declares the buggy pre-fix
shape:

```elixir
@type query_windows_list_payload :: %{
        kind: String.t(),
        windows: %{integer() => [QueryWindows.Window.t()]}
      }
```

`QueryWindows.Wire` declares `windows_map :: %{integer() =>
[windows_entry()]}` where `windows_entry` is a plain map, NOT
`%Window{}`. The channel @type therefore lies about the wire shape:
a future contributor reading the @type will see "raw struct fan-out
is the contract" and reintroduce the exact crash B6 closed. Type
contradicts code; the code is right. The @type is a landmine that
points at the pre-CP15-B6 invariant.

**Fix:** Replace the `[QueryWindows.Window.t()]` list element with
`QueryWindows.Wire.windows_entry()` (or alias the whole shape via
`QueryWindows.Wire.windows_map()` and drop the duplicated type).
Same edit makes the wire-shape rule "context owns wire-shape;
GrappaWeb consumes" mechanical.

---

## MEDIUM

### W3. `validate_captcha_token` only fires on the `login/2` entry; `visitor_login/3` re-reads the raw param

**Module:** web/ | **File:** `lib/grappa_web/controllers/auth_controller.ex:91-104, 265-274`
**Category:** validation-shape duplication / input-trust drift

`login/2` validates `captcha_token` shape (`is_binary` and
`byte_size <= 4096`) before classification (good). On the visitor
branch it then calls `visitor_login(conn, nick, password)` (note:
the validated value is not threaded through). `visitor_login/3`
re-reads `conn.params["captcha_token"]` raw and embeds it in the
input map for `Visitors.Login.login/2`.

For today's call graph the value is identical, so this is "a
re-read, not a re-trust." But the contract is fragile: any future
refactor that decides to **normalise** the token at validation time
(strip whitespace, lower-case, split provider prefix) will leave
`visitor_login` consuming the un-normalised raw value — a class of
bug that this exact "validate at boundary, then re-read raw at the
delegating call site" pattern attracts.

The simpler shape: `login/2` returns the validated value from
`validate_captcha_token`, threads it through to `visitor_login/4`,
and `visitor_login` consumes the parameter rather than re-reading
`conn.params`. Single source of truth for the value, mechanical
forward-compat with any future normalisation.

**Fix:** Change `validate_captcha_token/1` to return `{:ok, token |
nil}` instead of `:ok`; thread the result into `visitor_login`'s
arg list; drop the `conn.params["captcha_token"]` read in
`visitor_login`.

### W4. `MembersJSON` re-implements the shape `Session.list_members/3` already returns

**Module:** web/ | **File:** `lib/grappa_web/controllers/members_json.ex:12-19`
**Category:** dead transform / inconsistent wire-shape ownership

`Session.list_members/3` returns `[%{nick: String.t(), modes:
[String.t()]}]` (plain atom-keyed maps, JSON-encodable). `MembersJSON.index/1`
walks the list and re-builds each entry as a string-keyed map:

```elixir
%{"members" =>
    Enum.map(members, fn %{nick: nick, modes: modes} ->
      %{"nick" => nick, "modes" => modes}
    end)
}
```

Two shapes are now in flight for the same domain:

- **REST** wire (this view) — string keys.
- **PubSub `members_seeded`** wire (`grappa_channel.ex:744-752`) —
  atom keys, since `push/3`'s payload encoder stringifies on the way
  out.

cic consumes both in `lib/membersStore.ts`-equivalent paths. They
deserialise identically (JSON has no atom-vs-string distinction
post-encode), so this isn't a wire bug **today**. But it violates
"every door, one shape" — the REST view stringifies; the channel push
doesn't; the contract is ad hoc per surface.

The CP15 wire-module rule says contexts own the wire shape. There is
no `Grappa.Session.MembersWire` (or equivalent) — `list_members/3`
**is** the wire shape (plain map, ready to encode). The REST view
should be a one-liner pass-through:

```elixir
def index(%{members: members}), do: %{members: members}
```

…or even drop the view and use `json/2` directly from the controller.
The current per-view re-shape is dead transform that pretends to be a
boundary.

**Fix:** Collapse `MembersJSON.index/1` to a pass-through. If the
string-keyed output shape matters for a wire-test fixture, define
it ONCE in a `Session.MembersWire.encode/1` (atom-key map → atom-key
map identity today; a forward seam for any future field rename) and
both REST + Channel push delegate.

### W5. `GrappaChannel.handle_in("topic_set", ...)` doesn't validate `text` for CRLF/NUL — relies on Session boundary

**Module:** web/ | **File:** `lib/grappa_web/channels/grappa_channel.ex:437-456`
**Category:** missing boundary validation / input-shape

The REST analog (`ChannelsController.topic/2` →
`Session.send_topic/4`) relies on the Session boundary's
`Identifier.safe_line_token?/1` check inside `send_topic` to reject
CRLF/NUL in the topic body. That's fine for REST — the controller
returns `{:error, :invalid_line}` and the FallbackController emits
the `invalid_line` wire body.

The Channel handler does the same delegation but the error envelope is
one of the channel's local discriminator strings:

```elixir
{:error, :invalid_line} -> {:reply, {:error, %{reason: "invalid_line"}}, socket}
```

Functionally fine — but compare to `validate_channel_name/1`'s
explicit `:ok | {:error, :bad_request}` pre-flight in the REST path.
The Channel handler skips the analogous pre-flight (no
`is_binary(text)` shape check beyond the function-head guard, no
length cap). A 10MB string would land deep in `Session.send_topic/4`
before Session-boundary validation rejects it.

Not a security bug — `safe_line_token?` will reject CRLF/NUL — but
the surface lacks the symmetry the REST side has. Same shape as
M-web-3 in the 2026-05-03 review (which addressed
`captcha_token` size cap at the boundary): WS payloads from the
client deserve the same boundary discipline as REST params.

**Fix:** Add a `byte_size(text) <= @max_topic_bytes` (or the
RFC-2812 §3.2.4 "topic length subject to ISUPPORT TOPICLEN" cap —
read from `Session` if cached) guard at the channel-handler level so
oversize payloads are rejected without enqueuing a `call_session`.
Apply consistently across all WS handlers that take a free-text
field (currently only `topic_set` and the away `reason`).

### W6. `Endpoint.broadcast/3` "disconnect" is not topology-validated against `UserSocket.id/1`

**Module:** web/ | **File:** `lib/grappa_web/controllers/auth_controller.ex:185-211`, `lib/grappa_web/channels/user_socket.ex:79`
**Category:** topology coupling / wire string built by hand

`maybe_disconnect_socket/1` constructs the socket-id topic with a
hand-built string interpolation:

```elixir
defp maybe_disconnect_socket({:visitor, %Visitor{id: visitor_id}}),
  do: broadcast_disconnect("user_socket:visitor:#{visitor_id}")

defp maybe_disconnect_socket({:user, %Accounts.User{name: name}}),
  do: broadcast_disconnect("user_socket:#{name}")
```

`UserSocket.id/1` returns `"user_socket:#{socket.assigns.user_name}"`,
where `user_name` is `user.name` for users and `"visitor:" <>
visitor.id` for visitors. The two construction sites must stay in
lockstep: any change to `UserSocket.id/1`'s shape (e.g. switching to
opaque session-id keys, adding a topology-prefix) would silently
no-op the logout disconnect, leaving WS connections alive after
bearer revocation — exactly the H2 bug from 2026-05-03 reopened by
drift, with no test that pins the topology.

The same pattern bit B6 (the QueryWindows wire-shape Jason crash):
two sides building the same string and drifting. The CP15 wire-
module rule applies symmetrically here — there should be ONE place
that owns the `socket_id` shape and both `UserSocket.id/1` and
`AuthController.maybe_disconnect_socket/1` consume it.

**Fix:** Add a `GrappaWeb.UserSocket.socket_id_for/1` (or
`socket_id_for_user_name/1`) verb that takes the same `user_name`
shape `id/1` returns and produces the topic string. `id/1` calls it;
`maybe_disconnect_socket/1` calls it. Topology drift becomes a
compile-time impossibility. Add a regression test that `id/1`'s
output equals `socket_id_for/1` for both subject branches.

### W7. `ResolveNetwork`'s `resolve/2` user-branch loses the `:wrong_network` distinction

**Module:** web/ | **File:** `lib/grappa_web/plugs/resolve_network.ex:64-79`
**Category:** error-shape inconsistency between branches

The visitor branch returns `{:error, :wrong_network}` for a slug
mismatch, distinct from `{:error, :not_found}` for an unknown slug.
The user branch collapses both ("unknown slug" and "credential
missing for known slug") into `{:error, :not_found}`. The plug body
then maps any `{:error, _}` to a uniform 404 via `FallbackController`
— so the wire output is uniform either way, which is the **intended**
no-leak posture (S14 oracle close).

But the operator log line `Logger.info("network resolve rejected",
reason: reason)` carries `:wrong_network` for visitors and
`:not_found` for users on what is structurally the same condition
(authenticated subject asking about a network they don't own). Two
log shapes for the same event → operator search has to OR both atoms.

The visitor branch's distinct atom doesn't earn its keep: both wire-
collapse to 404 anyway, and the logical class (`subject ⊥ network`)
is the same. Either both branches should emit the distinct atom
(`:wrong_network` for slug-mismatch, `:not_found` for unknown slug —
operators get to distinguish "credential exists but wrong network"
from "no such network at all") OR both should collapse to
`:not_found` (single shape, fewer log atoms).

**Fix:** Make both branches emit the same vocabulary. Recommendation:
keep the distinction (`:not_found` for unknown slug at network table;
`:wrong_network` for "known network, no binding for this subject")
and lift it into the user branch by looking at the
`Credentials.get_credential/2` failure separately from the
`Networks.get_network_by_slug/1` failure.

---

## LOW

### W8. `MeController.show/2` pattern-matches `:current_subject` directly — no fall-through clause for unexpected shapes

**Module:** web/ | **File:** `lib/grappa_web/controllers/me_controller.ex:23-28`
**Category:** defensive completeness

`Plugs.Authn` always assigns either `{:user, _}` or `{:visitor, _}`,
so the `case` is exhaustive **today**. If a third subject kind ever
lands (e.g. an oper-class subject for the future admin surface), the
controller crashes with `CaseClauseError` and Phoenix surfaces a 500.
A nicer (and grep-greppable) shape: add a fall-through that returns
`{:error, :forbidden}` so the FallbackController emits the canonical
envelope.

Fold-target: the same shape repeats in `NickController.create/2`
(visitor-vs-user case) and `NetworksController.require_user_subject/1`
(which already has the right pattern). MeController should match
that style.

**Fix:** Add a fall-through `_ -> {:error, :forbidden}` (or
`:internal`) clause. Cosmetic; not a bug today.

### W9. `GrappaChannel`'s `members_seeded` and `window_state` snapshot pushes have no `@typedoc`

**Module:** web/ | **File:** `lib/grappa_web/channels/grappa_channel.ex:146-166, 744-782`
**Category:** doc/typespec coverage

The moduledoc declares three outbound event shapes
(`topic_changed_payload`, `channel_modes_changed_payload`,
`query_windows_list_payload`) and pins each as a `@typedoc` + `@type`.
CP15 B3 added two more (`members_seeded`, the `window_state_snapshot`
push) but did not extend the typedoc list. The wire shapes are
documented in `Grappa.Session.window_state_snapshot()` but the
channel-side contract isn't, so a contributor reading the channel
moduledoc gets an incomplete picture of "what does this module emit?"

**Fix:** Add `members_seeded_payload` and a re-export (`@type
window_state_snapshot_payload :: Grappa.Session.window_state_snapshot()`)
to the channel module's typedoc block; cite both in the moduledoc's
"outbound event shapes" section.

### W10. `Endpoint.@session_options` `signing_salt: "rotate-me"` placeholder still in tree

**Module:** web/ | **File:** `lib/grappa_web/endpoint.ex:25-30`
**Category:** Phase-5 placeholder (already noted as deferred in the 2026-05-03 review L-web-4)

Re-flagged ONLY to confirm the placeholder is still present and the
moduledoc rationale ("not signed by any code path today") is still
accurate (no controller calls `put_session/3` or `get_session/2` —
verified by `grep` in scope). Phase-5 hardening must lift the salt
to runtime config in lockstep with the first session-cookie wire-up.
No change requested today; this is a tracking flag, not a finding.

---

## Out of scope / not flagged

- The `Application.get_env`-runtime-read class (H1 in the 2026-05-03
  review) — `FallbackController` now reads via
  `Grappa.Admission.Config.config()` (`:persistent_term` boot
  snapshot) per the cleanup cluster; the runtime read is gone from
  this scope.
- `H2 logout WS disconnect` (2026-05-03) — implemented; verified at
  `auth_controller.ex:184-211`.
- Bearer-token-in-URL on `/socket/websocket` — already in `docs/todo.md`
  as a Phase-5 item; no NEW occurrence in scope.
- `Application.compile_env(:grappa, :visitor_network)` —
  `auth_controller.ex:58` — explicitly justified per CLAUDE.md
  ("compile-time only, runtime banned"), with the rationale block
  citing the rule. Not a finding.
- `RemoteIP` — closed L-web-2 cleanly; no findings.

---

# cicchetto/

# Cicchetto Line-Level Review — 2026-05-08

**Scope:** `cicchetto/src/**/*.{ts,tsx}` + cicchetto root configs +
`cicchetto/public/{manifest.json,sw.js,icon*}`. Compared against
server-side counterparts (`Grappa.{Accounts,Networks,Scrollback,
QueryWindows}.Wire`, `GrappaWeb.*JSON`, `GrappaWeb.GrappaChannel`).
Delta since 2026-05-03 codebase review = CP15 B1–B7 (event-driven
window state machine, three new signal maps in
`lib/windowState.ts`, archive surface, +cic follow-up bug fixes
landed 2026-05-07).

PROBLEMS ONLY.

## Severity summary

| Severity | Count |
|----------|------:|
| CRITICAL | 0 |
| HIGH | 3 |
| MEDIUM | 6 |
| LOW | 4 |

---

## HIGH

### H1. `awayStatus.ts` + `mentionsWindow.ts` identity-rotation cleanup never registers — `on(token,…)` never wrapped in `createEffect`

**Module:** cicchetto/ | **Files:**
`cicchetto/src/lib/awayStatus.ts:18`, `cicchetto/src/lib/mentionsWindow.ts:23`
**Category:** SolidJS reactivity bug / cross-tenant state leak

Both modules call `on(token, (t, prev) => { … setX({}) })` at the
top of their `createRoot` body but never pass the returned callback
to `createEffect`. `on()` is just a helper that produces a
re-run-aware callback; it is NOT a reactive computation by itself.
Without `createEffect(on(…))`, the body never registers as a
subscriber to `token()` and the cleanup arm NEVER fires.

Compare to the correct pattern propagated everywhere else
(`scrollback.ts:79–88`, `members.ts:40–46`, `selection.ts:60–69`,
`windowState.ts:57–65`, `mentions.ts:21–25`, `compose.ts:87–94`,
`readCursor.ts:127–134`):

```ts
createEffect(
  on(token, (t, prev) => {
    if (prev != null && t !== prev) setX({});
  }),
);
```

awayStatus.ts and mentionsWindow.ts are missing the outer
`createEffect(...)` wrapping. Module-level comments in BOTH files
explicitly claim "Identity-scoped: on logout / token rotation, all
[X] state is cleared" — the claim is false at runtime. After
logout / token rotation, `awayByNetwork()` and
`mentionsBundleBySlug()` retain the prior tenant's data; a second
user logging in on the same browser inherits it.

**Fix:** Wrap the `on(token, …)` call in `createEffect(...)`,
matching the propagated pattern. Add a regression test mirroring
`windowState.test.ts`'s "identity rotation (token change)"
describe block.

### H2. `subscribe.ts` token rotation installs duplicate channel-event handlers — every WS event fires twice (and N times after N rotations)

**Module:** cicchetto/ | **File:** `cicchetto/src/lib/subscribe.ts:124–133, 363–397`
**Category:** SolidJS reactivity / phoenix.js channel-handle re-use

Same root cause as the server-side BUG 6 documented in
`grappa_channel.ex` moduledoc (lines 12–27): "1 broadcast → 2
frames per message."

Sequence:
1. Cold-start login (token tokA): `joined` Set is empty; the
   channels-loop createEffect runs, calls `joinChannel(name, slug,
   ch.name)` for each channel (which delegates to
   `socket.channel(topic).join()`), and `installChannelHandler`
   calls `phx.on("event", handler)` once per channel. `joined.add(key)`
   prevents re-installs while the bearer is stable.
2. Token rotation (tokA → tokB): the on(token) cleanup arm at
   `subscribe.ts:127–133` calls `joined.clear()`. `socket.ts`'s own
   on(token) effect calls `socket.disconnect()` then
   `socket.connect()`.
3. socket.disconnect() does NOT clear phoenix.js's internal
   `socket.channels` registry — the Channel objects survive the
   underlying transport reconnect and auto-rejoin themselves.
4. The channels-loop createEffect re-runs (token signal triggered).
   For each channel, `joinChannel(...)` calls `getSocket().channel(topic)`
   which returns the SAME existing Channel object (phoenix.js
   topic-keyed lookup), then `installChannelHandler` calls
   `phx.on("event", handler)` AGAIN — a SECOND handler attached to
   the same channel.
5. Every subsequent `event` push fires BOTH handlers: scrollback
   dedupes by `id` so you don't see double rows, but
   `applyPresenceEvent` runs twice (members list mutated twice —
   visible on JOIN/PART/MODE), `bumpUnread`/`bumpMessageUnread`/
   `bumpEventUnread` increment twice, `bumpMention` doubles.
6. After N rotations: N+1 handlers per channel.

The same bug exists in the query-windows loop (line 454),
DM-listener loop (line 506), pending pre-subscribe loop (line 416),
and `$server` loop (line 535) — all four call
`installChannelHandler` after `joinChannel` without first calling
`phx.off("event")` and without holding a registry of installed
handler functions to skip duplicates.

**Fix:** Two parts.
1. In `joinChannel`/`joinUser` (`socket.ts`), expose a way to
   detach prior handlers — either return a fresh `phx.off("event")`
   call before re-installing, or maintain a per-topic
   "handler-installed" Set in subscribe.ts that survives
   `joined.clear()`.
2. Add a token-rotation regression test in
   `subscribe.test.ts` that asserts handler-call count after
   tokA→tokB→tokC and verifies presence/unread mutations fire
   exactly once per event.

### H3. Wire-shape drift: `Network.inserted_at` / `updated_at` typed `string` on cic but `DateTime.t()` on the server `network_with_nick_json` — visitor branch carries `nick?` field cic types as optional but server omits it entirely

**Module:** cicchetto/ | **File:**
`cicchetto/src/lib/api.ts:85–94, 358–363, 401–416`
**Category:** Wire-shape drift vs `Grappa.Networks.Wire` and
`GrappaWeb.NetworksJSON.index/1`

Three mismatches in `api.ts` `Network` and adjacent types:

1. **Optional `nick`**: cic types `nick?: string`. Server returns
   `network_with_nick_json` (`network_with_nick_to_json/2` REQUIRES
   non-empty nick — guard `is_binary(nick) and nick != ""`) for user
   subjects, OR plain `network_json` (no `nick` key) for visitors.
   Cic's `nick?` admits "key present, value undefined" which never
   happens — server omits the key entirely or sets it to a
   non-empty string. Tighter type: `nick: string` on the user
   branch, omit on visitor — discriminated union mirroring the
   server's `{:user, …} | {:visitor, …}` controller arg.

2. **`PATCH /networks/:slug` response wire shape**: cic
   `CredentialJson` (api.ts:403–416) types
   `connection_state_changed_at: string | null` but the wire emits
   the field via Jason (`Wire.credential_to_json/1` ->
   `connection_state_changed_at: c.connection_state_changed_at`)
   where `connection_state_changed_at` is `DateTime.t() | nil` —
   Jason serializes DateTime to ISO-8601 string, OK. **But the
   `connection_state` cic type is `"connected" | "parked" |
   "failed"`** — the server-side `Credential.connection_state()`
   typespec has the same three atoms. Cic's type DOES include
   `"failed"` correctly; however the comment at api.ts:392 says
   `:failed is server-set only and is rejected by the endpoint
   (400) — do not send it`. The TYPE for the request body is
   correctly narrowed (`CredentialConnectionState = "connected" |
   "parked"`); the response type correctly admits `"failed"`. ✓
   This one is fine — flagging here only because the comment risks
   being read as spec; verify the server validation actually
   rejects `"failed"` in PATCH body (controller test would catch).

3. **`ScrollbackMessage.network` is the slug, not the `id`**: cic
   types `network: string` (api.ts:135–144). `Wire.to_json/1`
   correctly emits the slug. ✓ fine.

**The actual drift hit**: `api.ts` `Network` type's `nick?:
string` should be split into
`{kind: "user", nick: string} | {kind: "visitor"}` — at minimum
the optional should be `nick: string | undefined` (with a runtime
narrowing helper) so a future server-side change that makes nick
required for ALL subjects fails type-check at the consumer.
Today the consumers (`subscribe.ts:387`, `subscribe.ts:514`,
etc.) defensively fall back to `displayNick(u)` when `net.nick`
is missing — covering up the visitor case AND any future
real-bug missing-nick. That fallback is BUG1's exact failure
mode (see `Grappa.Networks.Wire.network_with_nick_json` typedoc:
"Without per-network nick in the wire, cicchetto falls back to
`user.name`, which coincides with query-window targetNick when
the operator's account name matches a conversation partner's IRC
nick — causing the DM handler to subscribe to the wrong topic
and re-key messages incorrectly").

**Fix:** Restructure `Network` as a discriminated union
mirroring the server's index controller arg
`{:user, [{Network.t(), String.t()}]} | {:visitor, [Network.t()]}`,
e.g. by exposing two flat call paths: `listUserNetworks` returns
`UserNetwork[]` (nick required), `listVisitorNetworks` returns
`VisitorNetwork[]` (no nick). Or — simpler — add a runtime
narrowing helper `requireNick(net): string` that throws (loud
error) if the credential branch lost its nick, so visitor-vs-user
confusion surfaces as a crash rather than a silent
DM-misrouting bug.

---

## MEDIUM

### M1. `userTopic.ts` parses event payloads via raw `as string`/`as number` casts — no narrowing; malformed broadcast crashes downstream consumers as `undefined`

**Module:** cicchetto/ | **File:**
`cicchetto/src/lib/userTopic.ts:83–88, 111–112, 121–122`
**Category:** TypeScript `as`-cast bypassing `unknown` narrowing

The user-topic event handler trusts every `payload` field
unconditionally:

```ts
const networkSlug = payload.network as string;
const bundle = {
  network_slug: networkSlug,
  away_started_at: payload.away_started_at as string,
  away_ended_at: payload.away_ended_at as string,
  …
  messages: payload.messages as { … }[],
};
```

Server-side `maybe_broadcast_mentions_bundle` (CP15
`server.ex:2253–2264`) does emit the right shape today. But: a
future server-side typo (`away_starded_at`), a stale cic against
a newer server, or a hostile WS injection (the topic is
authenticated but channel framework still parses any JSON the
peer sends) all surface as `undefined as string` → `(undefined as
string).slice(0,8)` → `TypeError`. The ScrollbackPane / sidebar
unread paths handle it; this code crashes the user-topic
handler.

This module is also the hottest WS-receive path (channels_changed
heartbeat, query_windows_list updates, away_confirmed,
own_nick_changed all flow through). One bad payload silently
disables EVERY subsequent event-routing branch since the handler
function bails out at the cast site.

**Fix:** Same shape as `auth.ts:isValidSubject` and
`Login.tsx:isCaptchaInfo` — narrow `payload` from `unknown`,
reject malformed shapes with a `console.warn` + early return.
Lift each event payload into a type predicate; the handler
becomes a `switch (payload.kind)` over a typed discriminated
union. Mirror the pattern already used in `subscribe.ts`'s
`WireEvent`.

### M2. `subscribe.ts` channel-event union missing `mentions_bundle` and `away_confirmed` — those payloads silently drop on per-channel topics if server ever broadcasts them there

**Module:** cicchetto/ | **File:**
`cicchetto/src/lib/subscribe.ts:94–122`
**Category:** Wire union completeness

`WireEvent` enumerates 7 kinds (`message`, `topic_changed`,
`channel_modes_changed`, `members_seeded`, `joined`,
`join_failed`, `kicked`). Server-side `apply_effects` and
`maybe_broadcast_*` emit additional kinds (`channels_changed`,
`away_confirmed`, `own_nick_changed`, `query_windows_list`,
`mentions_bundle`) on the user-level topic — those legitimately
don't appear here since this handler is for per-channel topics.

But the handler is forward-compat-tolerant by design (no
`assertNever`); the comment at `subscribe.ts:283` says "if
(payload.kind !== "message") return;" — fine. The drift risk:
if a future server-side change accidentally broadcasts `away_confirmed`
or `mentions_bundle` on a per-channel topic (or vice-versa), no
warning surfaces. The user-topic handler in `userTopic.ts:72`
also doesn't enumerate `members_seeded` etc. — the two handlers
are silently de-coupled with no guard against cross-routing.

**Fix:** Extend `WireEvent` union explicitly to enumerate ALL
known kinds (with `// not expected on this topic` comments where
appropriate). Add a `default: console.warn` fall-through inside
`installChannelHandler` and the userTopic handler so unknown
kinds are visible during development without crashing prod.
Won't change runtime behavior; reduces drift risk.

### M3. `scrollback.mergeIntoScrollback` sorts by `server_time` only — same-millisecond messages reorder vs server-side `(server_time, id) DESC`

**Module:** cicchetto/ | **File:**
`cicchetto/src/lib/scrollback.ts:108–117`
**Category:** Sort tiebreaker drift vs server query

Server-side `Scrollback.list_recent/4` (lib/grappa/scrollback.ex:202)
orders rows `desc: m.server_time, desc: m.id`. Cic's merge step
sorts only on `server_time`:

```ts
const merged = [...existing, ...fresh].sort((a, b) => a.server_time - b.server_time);
```

A burst of N PRIVMSGs all stamped with the same epoch-ms (modern
hardware sends 5+ msgs/ms easily — IRC server 2812 §3.2 has no
per-message rate limit) renders in arbitrary cic order. Server-
side index ordering would have them in monotonic `id` (insertion)
order. WS arrival order respects insertion (since the bouncer
inserts then broadcasts), so the WS-only path is OK; this only
bites when a REST page lands a same-ms cluster.

User-visible symptom: replies appear before the messages they
reply to in pages loaded from REST. Subtle.

**Fix:** Add the `id` tiebreaker:
```ts
.sort((a, b) => a.server_time - b.server_time || a.id - b.id);
```

### M4. `Sidebar.pseudoChannelsForNetwork` uses non-branded composite-key parsing — fragile against `ChannelKey` shape change

**Module:** cicchetto/ | **File:**
`cicchetto/src/Sidebar.tsx:84–99`
**Category:** Encapsulation leak / brand bypass

The function iterates `Object.entries(windowStateByChannel())`
and parses each key string back into `(slug, name)` via
`prefix = "${slug} "; key.startsWith(prefix); key.slice(prefix.length)`.
This bypasses the `channelKey()` factory and assumes the
`${slug} ${name}` shape — exactly the layout
`channelKey.ts:21–25` documents but warns is brand-private:
"`channelKey` is just a string at runtime; only `channelKey(slug,
name)` builds one." Reaching into the encoded shape from a render
path means a future change to channelKey's representation (NUL
byte separator, hash prefix, etc.) silently breaks Sidebar
without a type error.

Same shape lives in `subscribe.ts:425–430` (the pending-channel
pre-subscribe loop) — also parses keys back to (slug,
channelName).

**Fix:** Either expose a `parseChannelKey(key): {slug, name}`
inverse on `lib/channelKey.ts` (acknowledging the round-trip is
part of the API), OR — cleaner — keep windowState keyed on the
brand AND a sibling `Map<ChannelKey, {slug, name}>` populated by
`setPending`/`setFailed`/etc. so iterators read the structured
form directly. Same fix applies to subscribe.ts.

### M5. `compose.ts` `/quit` handler uses `Promise.allSettled` then immediately `await logout()` — partial PATCH failures silently swallowed; user gets no feedback before logout

**Module:** cicchetto/ | **File:**
`cicchetto/src/lib/compose.ts:282–302`
**Category:** Error swallow on user-action verb

```ts
await Promise.allSettled(allNets.map((n) => patchNetwork(t, n.slug, parkBody)));
await logout();
```

`Promise.allSettled` returns rejected results which are then
discarded with no inspection. The comment justifies it ("partial
PATCH failures do NOT block the logout") — that's correct policy,
but failing silently means a network that auto-respawns on next
boot (PATCH failed → state stays `:connected` → Bootstrap
re-spawns at boot) is never surfaced to the user. The user
believes they parked everything; they didn't.

**Fix:** Inspect the settled results; if any rejected, fire a
non-blocking telemetry/log line OR (better) surface a one-line
banner before the unmount tear-down. The orchestrator memory
`feedback_compact_workflow` and the broader CLAUDE.md
"Investigation discipline / Never fabricate explanations" rule
applies symmetrically to client-side: silent failure is worse
than a loud one. Logout still proceeds — just leave a footprint.

### M6. `Login.tsx` createEffect race: ref callback fires AFTER `<Show>` renders the captcha container, but createEffect reads `widgetContainer` synchronously — early-returns on first run if Solid commits effects before refs

**Module:** cicchetto/ | **File:**
`cicchetto/src/Login.tsx:89–134`
**Category:** SolidJS reactivity ordering

```tsx
let widgetContainer: HTMLDivElement | undefined;
…
createEffect(() => {
  const c = captcha();
  if (c === null || widgetContainer === undefined) return;
  …mount…
});
…
<Show when={captcha()}>
  <div ref={(el) => { widgetContainer = el; }} class="captcha-container" />
</Show>
```

Solid's render commit order generally puts ref callbacks BEFORE
effect re-evaluation in the same tick — so this works in
practice. But the relationship is implicit and undocumented in
the file. If the captcha signal flips while the effect is
mid-evaluation (cleanup chain in flight from prior captcha,
new mount queued), `widgetContainer` could legitimately be
`undefined` at read time and the effect early-returns without
ever re-running for the new value (the captcha signal didn't
change a second time). The widget stays unmounted.

The unit tests mock `mountCaptchaWidget` so they don't catch
this; production captcha mount in the H3 case (CDN-blocked
re-render) plus the M-cic-5 fix's per-effect-run cleanup leaves
this dependency on Solid's commit order load-bearing.

**Fix:** Either (a) `createEffect(on(captcha, ...))` with
`defer: true` so the effect explicitly defers to after-mount,
plus a ref-effect that re-fires when the container element is
attached; OR (b) move the captcha widget mount into an `onMount`
attached to the container's `ref` callback directly — no
createEffect needed since the lifecycle is owned by the DOM
node's mount/unmount.

---

## LOW

### L1. `clientId.ts:100` defensive `?? 0` on `bytes[6]` — unreachable per `noUncheckedIndexedAccess` but reads as a real possibility

**Module:** cicchetto/ | **File:**
`cicchetto/src/lib/clientId.ts:100–101`
**Category:** Code-shape (also noted in 2026-05-03 review as M-cic-3 — still open)

Already documented; `Uint8Array(16)` cannot have `bytes[6] ===
undefined`. The `?? 0` falls back to a UUID with a corrupt v4
marker if the impossible ever happened. Use `bytes[6]!` with a
biome-ignore comment OR an `assert(bytes[6] !== undefined)`.

### L2. `mentionsWindow.ts:2` uses `import type { MentionsBundle } from "../MentionsWindow"` — store imports from component (dependency direction inversion)

**Module:** cicchetto/ | **File:**
`cicchetto/src/lib/mentionsWindow.ts:2`
**Category:** Dependency architecture

`lib/*` modules should be the source of truth for shapes;
components import FROM `lib/`, not the reverse. Here
`lib/mentionsWindow.ts` imports `MentionsBundle` type from
`../MentionsWindow.tsx` (the component). The CLAUDE.md
architecture rule: "components → `lib/*.ts` stores → `api.ts` +
`socket.ts`". Inverted here.

**Fix:** Move the `MentionsBundle` + `MentionsRow` types to
`lib/mentionsWindow.ts` (or a sibling `lib/mentionTypes.ts`);
`MentionsWindow.tsx` re-exports for ergonomics. Mirror of the
`memberTypes.ts`/`members.ts` split that already addressed the
modeApply ↔ members cycle.

### L3. `Login.tsx` form lacks `setSubmitting(true)` guard around captcha-callback re-login — user can spam the captcha solve and trigger N parallel login attempts

**Module:** cicchetto/ | **File:**
`cicchetto/src/Login.tsx:102–113`
**Category:** UX (also noted in 2026-05-03 review as L-cic-5 — still open per source inspection)

The captcha solve callback DOES set `setSubmitting(true)` at the
top, so this is half-fixed since the prior review. But there's no
guard against the user solving the captcha twice quickly (Cloudflare
Turnstile fires the callback once per solve; hCaptcha can
re-prompt on a partial failure). Would a re-fire while
`submitting()` is already true issue a second login? The
`setSubmitting` line is at function entry, not gated on the
prior state. Add `if (submitting()) return;` at line 103.

### L4. `subscribe.ts` DM-listener handler silently DROPs non-PRIVMSG/ACTION events on the own-nick topic — no `console.warn` or telemetry — invisible loss

**Module:** cicchetto/ | **File:**
`cicchetto/src/lib/subscribe.ts:355–359`
**Category:** Visibility / debugging

```ts
// NOTICE, mode, join, part, quit, kick, nick_change, topic, etc.
// on the own-nick topic → deferred to feature #4 (server-messages
// window). Drop silently for now; …
```

Documented intentional drop. But the server already routes most
service NOTICEs to `$server` (per the comment) — anything that
reaches the own-nick topic with these kinds is by definition an
event the routing didn't cover. No log, no metric, no developer
signal. Finding the next routing gap requires reading every prod
WS frame.

**Fix:** Replace the silent drop with `console.debug` (level-gated
so it doesn't spam ops) carrying `{kind, sender, channel}`. Or
emit a single `:dropped_dm_listener_event` telemetry tick. Cheap
visibility for a deferred feature.

---

## Notes / non-findings

- `tsconfig.json` strict + `noUncheckedIndexedAccess` +
  `noImplicitReturns` + `noFallthroughCasesInSwitch` ✓ all pinned.
- `vite-plugin-solid` is the plugin layer ✓ (no raw Babel preset).
- `manifest.json` / `sw.js` not in `public/` — generated by
  VitePWA per `vite.config.ts:37–91`. Manifest fields complete
  (name, short_name, start_url, display=standalone, icons
  192/512 with `purpose: "any maskable"`). Workbox SW
  `globPatterns` is shell-only; runtime handlers absent so REST
  + WS pass through to network ✓ matches documented intent.
- No `innerHTML` / `dangerouslySetInnerHTML` / `eval` /
  `new Function` anywhere in `cicchetto/src/**` ✓.
- `console.*` calls are error-level only; no full-request
  objects logged; no token leakage observed.
- `package.json` deps — `@solidjs/router`, `phoenix`, `solid-js`
  pinned at compatible versions; `bun.lock` not inspected (not in
  scope per dispatch — cross-module agent owns sync verify).
- a11y baseline: every interactive element is `<button type="button">`,
  `aria-label` present on icon-only buttons (TopicBar hamburger,
  Sidebar `×`, Settings ⚙), `<dialog role="dialog" aria-modal>`
  on modals, `<p role="alert">` on error banners, `<input>` paired
  with `<label for=>` in Login + SettingsDrawer. ✓.
- `index.html` has `lang="en"`, viewport meta, theme-color,
  Apple-specific PWA meta tags. ✓.
- 2026-05-03 review HIGH H3 + H4 (captcha widget mount swallow +
  `friendlyMessage` `captcha_required` arm) — both LANDED. ✓
  (verified via Login.tsx:32–39, Login.tsx:119–127).
- 2026-05-03 review M-cic-5 (captcha cleanup race) — LANDED ✓
  (verified via Login.tsx:99–133's per-effect-run `local` flag).
- 2026-05-03 review M-cic-6 (auth.ts module-load 401 handler) —
  LANDED ✓ (`bootstrapAuth()` extracted, called from main.tsx).
- CP15 invariant ("cic mirrors server window state — no client-
  side state machine"): the cic-side `setPending` in
  `compose.ts:210` (fired on `/join` before the upstream echo)
  IS a client-side optimistic STATE write. CP15 closeout
  documents this as deliberate UX feedback and the typed `joined`/
  `join_failed` event will overwrite it; not flagged as a bug,
  but it's the boundary of the invariant — any future "while
  pending, render X differently" branch expands the client-side
  state machine. Worth a CLAUDE.md-or-comment pin if cluster
  work extends pending semantics.

---

# cross-infra/

# Cross-module + infra review — 2026-05-08

Scope: `lib/**/*.ex` cross-cutting patterns, `test/**/*.exs` cross-cutting
patterns, `scripts/*.sh`, `Dockerfile`, `compose*.yaml`, `config/*.exs`,
`infra/nginx.conf`, `infra/snippets/*`, `.env.example`, `mix.exs`,
`mix.lock`, `.tool-versions`, `.gitignore`, `.dockerignore`. Reviewer
agent dispatched 2026-05-08; previous codebase review 2026-05-03. Full
deltas since: T31-cleanup cluster + cluster CP15 (event-driven windows).
PROBLEMS-ONLY.

Many of the 2026-05-03 findings were genuinely closed by T31-cleanup
(H1, H2, H6, H7, H12, M-arch-1, M-arch-3 etc.) — they are not re-flagged
here. New findings below.

---

## HIGH

### H1. `Networks.broadcast_state_change/4` event never reaches cicchetto — broadcasts via raw `Phoenix.PubSub.broadcast/3` with a tagged-tuple payload that the channel layer ignores

**Module:** cross-module (PubSub / web channels) | **Files:**
`/Users/mbarnaba/code/grappa/lib/grappa/networks.ex:431-463`,
`/Users/mbarnaba/code/grappa/lib/grappa_web/channels/grappa_channel.ex` (no
matching `handle_info` clause anywhere in 861 LOC)
**Category:** wire-shape drift / dead broadcast

`Networks.connect/1`, `Networks.disconnect/2`, `Networks.mark_failed/2`
all funnel through `broadcast_state_change/4`, which calls

```elixir
Phoenix.PubSub.broadcast(Grappa.PubSub, Topic.network(user_name, slug),
                         {:connection_state_changed, %{...}})
```

Three things conspire to silently drop this event before it reaches any
WS subscriber:

1. The payload is a tagged tuple, NOT a `%Phoenix.Socket.Broadcast{}`
   struct. `Phoenix.Channel`'s framework-installed fastlane subscriber
   only forwards the `%Broadcast{}` shape — tagged tuples do not match
   the fastlane and would have to be picked up by a channel
   `handle_info({:connection_state_changed, _}, _)` clause.
2. `GrappaChannel` does NOT define a matching `handle_info/2` (grep
   confirmed). The module's own moduledoc explicitly notes "Server-side
   broadcasters call `Grappa.PubSub.broadcast_event(topic, payload)`...
   we do NOT define `handle_info({:event, _}, _)` — there is no manual
   subscribe and the fastlane bypasses `handle_info/2` entirely."
3. `Grappa.PubSub`'s own moduledoc explicitly designates
   `Grappa.PubSub.broadcast_event/2` as "the single source of truth for
   emitting an `\"event\"`-typed payload to a `GrappaWeb.GrappaChannel`
   topic." The Networks module bypasses this verb.

The tests at
`/Users/mbarnaba/code/grappa/test/grappa/networks/connection_state_test.exs:85,113,129`
work only because they call `Phoenix.PubSub.subscribe/2` from the test
process — direct subscribers receive tagged tuples. That hides the
production gap. `cicchetto/src/lib/api.ts` reads `connection_state` only
as a static field on the REST `Network` response (grep confirmed); no
WS handler consumes the event. Net effect: T32 disconnect/connect
state transitions never push live to the browser — cicchetto only
learns the new state via REST refetch.

**Fix:** Convert `broadcast_state_change/4` to use
`Grappa.PubSub.broadcast_event/2` with a wire-shape map (extend
`Grappa.Networks.Wire` — the project's documented per-context wire
module pattern — to emit a `%{kind: :connection_state_changed,
network: ..., from: ..., to: ..., reason: ..., at: ISO8601}` map).
Add a `GrappaChannel` test that subscribes via the WS layer (not raw
`Phoenix.PubSub.subscribe`) and asserts the push arrives on the
network topic. Update existing
`test/grappa/networks/connection_state_test.exs` to assert via
`Phoenix.Socket.Broadcast` or the dedicated test helper — the current
tagged-tuple shape pins the bug.

Also: every other broadcaster in the codebase (Session.Server has 14
sites, QueryWindows has 1) uses `Grappa.PubSub.broadcast_event/2`.
Networks is the lone divergent context — exactly the pattern-drift
this review category flags.

---

### H2. `Grappa.WSPresence` introduces a sibling PubSub topic prefix (`grappa:ws_presence:...`) — violates CLAUDE.md "Don't introduce sibling prefixes" + bypasses `Grappa.PubSub.Topic`

**Module:** cross-module (PubSub) | **Files:**
`/Users/mbarnaba/code/grappa/lib/grappa/ws_presence.ex:286-299`,
`/Users/mbarnaba/code/grappa/lib/grappa/session/server.ex:419-425`
**Category:** topic-shape divergence / single-source-of-truth violation

CLAUDE.md "PubSub topic naming" rule: "Subtopics
`grappa:user:{user}`, `grappa:network:{net}`,
`grappa:network:{net}/channel:{chan}`. Don't introduce sibling
prefixes; future Phase 6 listener may need to share topics with the
REST surface."

`WSPresence.notify_sessions/2` builds the topic inline:

```elixir
"grappa:ws_presence:#{user_name}"
```

`Session.Server.init/1` subscribes with the same inline string:

```elixir
Phoenix.PubSub.subscribe(Grappa.PubSub, "grappa:ws_presence:#{opts.subject_label}")
```

Two problems compound:

1. `grappa:ws_presence:` is a sibling prefix to `grappa:user:` —
   contradicting the CLAUDE.md invariant. The Phase 6 IRCv3 listener
   will have to be aware of it.
2. Building the topic via inline string interpolation in two different
   files duplicates a contract that `Grappa.PubSub.Topic` exists
   precisely to single-source. The two strings drifting (typo,
   underscore-vs-dash, etc.) would silently break auto-away across the
   WSPresence/Session.Server boundary; the only signal would be "auto-
   away never fires" — exactly the `feedback_cicchetto_browser_smoke`
   class of jsdom-blind UX regression.

**Fix:** Either (a) reshape WSPresence to push notifications
out-of-band (direct `send/2` to the registry-looked-up Session.Server
pids, since `WSPresence` already resolves user_name → pid for its own
state-keeping — see the moduledoc's "fan-out problem avoided"
section), OR (b) extend `Grappa.PubSub.Topic` with a documented
`presence(user_name)` builder that BOTH sites use. Option (a) closes
the prefix-sibling violation entirely; option (b) just localises the
violation. (a) is the right call — auto-away is a per-Session.Server
concern, fan-out via PubSub is heavyweight when the registry already
has the recipient list.

---

### H3. `mode1_login` in `AuthController` does not pass `client_id` to `Accounts.create_session/3` — user logins skip per-(client, network) cap tracking

**Module:** web | **File:**
`/Users/mbarnaba/code/grappa/lib/grappa_web/controllers/auth_controller.ex:255-262`
**Category:** admission control gap / contract drift

The visitor branch (`visitor_login/3` line 272-273) correctly threads
`client_id: conn.assigns[:current_client_id]` into the
`Visitors.Login.login/2` input. The user branch is parallel:

```elixir
{:ok, session} =
  Accounts.create_session({:user, user.id}, format_ip(conn), user_agent(conn))
```

— and `Accounts.create_session/4` has `opts \\ []` with `:client_id`
support, but mode1_login passes nothing. Result: every user-login row
in `accounts_sessions` for an admin (mode-1) user has `client_id:
nil`. `Admission.check_capacity/1`'s
`count_subjects_for_client_on_network/2` filters by `s.client_id == ?`
so user-mode sessions are invisible to the per-(client, network) cap.

The `Admission` moduledoc states the cap "applies to flows with non-nil
client" but `Bootstrap` flows are documented as the only cap-bypass
case (cold-start has no client). Live admin login from a browser DOES
have a client_id (the `X-Grappa-Client-Id` header is extracted by
`Plugs.ClientId` for `:api` pipeline routes — `/auth/login` is in
`:api`); dropping it on the floor here means the operator-imposed
per-client cap silently doesn't apply to admin users.

**Fix:** `Accounts.create_session({:user, user.id}, format_ip(conn),
user_agent(conn), client_id: conn.assigns[:current_client_id])`.
Symmetric with the visitor branch. Add a regression test (an admin
login that omits the cap-check assertion is fine, but the call
signature should match the visitor path so a future contributor
doesn't drift it back).

---

## MEDIUM

### M1. `MembersController` + route still exists despite CP15 B5 "drop loadMembers REST path — members_seeded is sole source"

**Module:** web | **Files:**
`/Users/mbarnaba/code/grappa/lib/grappa_web/controllers/members_controller.ex`,
`/Users/mbarnaba/code/grappa/lib/grappa_web/router.ex:87`
**Category:** dead code / cluster claim drift

CP15 B5 commit `a69f375 cic(cp15-b5): drop loadMembers REST path —
members_seeded is sole source` removed the cic-side caller but the
server-side `GET /networks/:network_id/channels/:channel_id/members`
route + `MembersController` + `MembersJSON` are still wired. Per
CLAUDE.md "Total consistency or nothing" + "No backwards-compat
shims" (the cluster close summary in CP15 explicitly claims "0
backwards-compat shims"). One door per feature; this is two with one
silently inactive.

**Fix:** Either re-state the route as a documented operator-side
debugging surface (inline rationale in the controller moduledoc and
router comment) OR remove route + controller + JSON view + members
controller test. If the verb stays, add an integration assertion that
cic does NOT consume it (grep + biome lint forbid).

---

### M2. `Accounts.create_session/4` carries `opts \\ []` — CLAUDE.md "no default arguments via `\\`" violation; same shape on `Visitors.Login.login/2`

**Module:** cross-module | **Files:**
`/Users/mbarnaba/code/grappa/lib/grappa/accounts.ex:156`,
`/Users/mbarnaba/code/grappa/lib/grappa/visitors/login.ex:114`
**Category:** CLAUDE.md violation

CLAUDE.md "code-shape rules" — "**No default arguments via `\\`**,
except for genuine config defaults where the default is the correct
production behavior. Default arguments create silent degradation paths.
Every new function MUST require all parameters explicitly. When
touching existing code that uses defaults, REMOVE them."

Both functions take `opts \\ []`. Neither carries a "config default"
semantic — `opts` is a per-call request shape (client_id for one,
login_timeout_ms for the other). The H3 finding above is the exact
"silent degradation" the rule warns against: callers omit `opts`,
features silently degrade.

**Fix:** Make both `opts` parameters required. Three call sites for
`create_session` (auth_controller mode1, auth_controller visitor_login,
multiple in Visitors.Login + tests); five for `Login.login/2` (one prod
caller + tests). Bounded refactor.

---

### M3. `dirty_xref` cycle workaround in `Grappa.Admission` boundary — `Visitors.Visitor` referenced as a SQL join target with no formal dep, hides the Admission ↔ Visitors cycle

**Module:** architecture | **File:**
`/Users/mbarnaba/code/grappa/lib/grappa/admission.ex:40-43`
**Category:** boundary leak / cycle hidden

`Admission` deps `Accounts, Networks, RateLimit, Repo` and lists
`dirty_xrefs: [Grappa.Visitors.Visitor]` because `Visitors.Login`
calls `Admission.check_capacity/1` (Visitors → Admission), and
Admission needs the Visitor schema for SQL joins (Admission →
Visitors). The dirty_xref keeps Boundary quiet but the real
architectural question — does the `Admission`-counts-distinct-visitors
SQL join belong in `Admission` or in a `Visitors` query verb that
returns a count to `Admission`? — is unanswered. The L-arch-3 finding
in 2026-05-03 (`count_live_sessions/1` raw match-spec couples
Admission to Session's registry-key shape) is the same theme: Admission
keeps reaching into other contexts' internals.

**Fix:** Add `Grappa.Visitors.count_subjects_for_client_on_network/3`
(or a verb owning the entire client-cap subject count) — Admission
calls the verb; the SQL join lives in the owning context. Same
treatment as L-arch-3 for the Session registry shape. Cleans up two
boundary-violation theme entries simultaneously.

---

### M4. `application.ex:121` runtime `Application.get_env(:grappa, :start_bootstrap, true)` is the documented exception, but the `default: true` argument hides a misconfig — boot silently degrades to "no bootstrap" if a typo lands in config

**Module:** lifecycle | **File:**
`/Users/mbarnaba/code/grappa/lib/grappa/application.ex:121`
**Category:** silent degradation

`Application.get_env(:grappa, :start_bootstrap, true)` returns `true`
when the key is missing OR when the value is anything other than the
documented `true`/`false`. `config/test.exs:38` sets it `false`. A
contributor who fat-fingers `:start_boostrap` in `runtime.exs` (or
elsewhere) gets `true` (default fires) and Bootstrap runs in test —
the wrong state. Pattern is the inverse of the more common bug
(misconfig disables intended feature) but is just as silent.

**Fix:** `Application.fetch_env!(:grappa, :start_bootstrap)` — crash
loud at boot on any missing/invalid value. Pin the default in
`config/config.exs` (currently the value lives only in `test.exs`'s
`false`-override; dev/prod implicitly relying on the default-true is
documentation drift). Same shape as `default_max_per_client_per_network`
which already uses `Application.compile_env!/2` per the L-cross-4
finding fix.

---

### M5. `compose.prod.yaml` `cicchetto-build` oneshot defaults `HOME=/tmp` and `BUN_INSTALL_CACHE_DIR=/cache` but `compose.prod.yaml` does NOT set `tmpfs` UID — drift vs `scripts/bun.sh` which DOES set `uid=$(id -u)`

**Module:** infra | **Files:**
`/Users/mbarnaba/code/grappa/compose.prod.yaml:99-112`,
`/Users/mbarnaba/code/grappa/scripts/bun.sh:48-58`
**Category:** dev/prod divergence

`scripts/bun.sh:52` mounts `/tmp` with `uid=$(id -u),gid=$(id -g)` so
the dropped UID can write. `compose.prod.yaml:107-108` mounts `/tmp`
with `exec,uid=1000,gid=1000` — hardcoded 1000 (matches the
`CONTAINER_UID:-1000` default). On a host where the operator UID is
NOT 1000 (CI runner, alternate operator), the deploy step's
`cicchetto-build` would write to `/tmp` as the wrong UID. The
`scripts/bun.sh` side has the parameterised escape; the compose side
doesn't, even though both consume the same `oven/bun:1` image and
follow the same tmpfs-permissions pattern.

**Fix:** `tmpfs: ["/tmp:exec,uid=${CONTAINER_UID:-1000},gid=${CONTAINER_GID:-1000}"]`
in `compose.prod.yaml`. The `CONTAINER_UID`/`CONTAINER_GID` env
already propagate via `.env.example`. Mirror the existing variable
pattern instead of baking the literal.

---

### M6. `.env.example` lists `MIX_ENV=dev` but says "Override to :prod when running compose.prod.yaml" — but `compose.prod.yaml:44` sets `MIX_ENV: prod` directly, ignoring `.env`

**Module:** infra | **Files:**
`/Users/mbarnaba/code/grappa/.env.example:11-12`,
`/Users/mbarnaba/code/grappa/compose.prod.yaml:43-44`
**Category:** documentation drift / operator confusion

`.env.example` line 11-12: "Override to :prod when running
compose.prod.yaml." But `compose.prod.yaml` line 44 hard-codes `MIX_ENV:
prod` — the operator's `MIX_ENV` setting is silently ignored for prod,
which is correct behaviour but contradicts the `.env.example` doc.
Operators following the comment will set `MIX_ENV=prod` in `.env` and
believe it's load-bearing; they'll then be surprised when changing it
to test something does nothing.

**Fix:** Edit `.env.example` to clarify: "Used by `compose.yaml` (dev)
only; `compose.prod.yaml` hardcodes `MIX_ENV=prod` regardless." Or
remove the `MIX_ENV` env from `.env.example` entirely since the dev
path's `${MIX_ENV:-dev}` already defaults sensibly when the env is
unset.

---

### M7. Six `mix grappa.*` task moduledocs use `\\` line continuations in heredoc — Elixir heredoc does NOT interpret `\\` as a continuation; the literal `\\` ships in `mix help grappa.bind_network` output

**Module:** cross-module | **Files:**
`/Users/mbarnaba/code/grappa/lib/mix/tasks/grappa.bind_network.ex:12-17`,
`/Users/mbarnaba/code/grappa/lib/mix/tasks/grappa.set_network_caps.ex:10-12,35-37`,
`/Users/mbarnaba/code/grappa/lib/mix/tasks/grappa.add_server.ex:11-13`,
`/Users/mbarnaba/code/grappa/lib/mix/tasks/grappa.update_network_credential.ex:11-14`,
`/Users/mbarnaba/code/grappa/lib/mix/tasks/grappa.remove_server.ex:11`,
`/Users/mbarnaba/code/grappa/lib/mix/tasks/grappa.seed_scrollback.ex:15-16`
**Category:** docs / UX (operator-facing copy-paste shell)

The intent is clearly a shell continuation — operator copy-pastes the
moduledoc usage example. In `@moduledoc """..."""` heredoc, `\\`
renders as a literal `\` followed by another `\`, NOT as a backslash-
plus-newline. So `mix help grappa.bind_network` prints

```
scripts/mix.sh grappa.bind_network \\
  --user vjt --network azzurra \\
  ...
```

with a stray `\\` at every continuation. Operator pasting this into a
shell hits "command not found: \" or similar.

**Fix:** Change `\\` to `\` in the heredoc. Heredoc treats `\` at
end-of-line as a literal backslash followed by newline (which is what
the shell wants). Verify with `iex -S mix` then `IEx.Helpers.h
Mix.Tasks.Grappa.BindNetwork`.

---

### M8. `Dockerfile` `release` stage runs `mix deps.get --only prod && mix deps.compile` AFTER `COPY . .` in build stage — release builds get NO `--from-cache` benefit when only source changes, full prod-deps re-fetch + re-compile every time

**Module:** infra | **File:**
`/Users/mbarnaba/code/grappa/Dockerfile:67-79`
**Category:** build performance

The build stage line 50-58 correctly orders `COPY mix.exs mix.lock` →
`mix deps.get` → `COPY config/` → `mix deps.compile` → `COPY . .` so
incremental builds cache deps when only source changes. The release
stage extends `build` (`FROM build AS release`) and re-runs both
`mix deps.get --only prod` AND `mix deps.compile`. The `release`
extension doesn't get a separate `COPY mix.exs` cache layer — every
release build invalidates from the post-`COPY . .` layer, so deps.get
+ deps.compile run every time.

**Fix:** Either (a) accept the cost (release builds are infrequent —
only `scripts/deploy.sh`) and document it in the Dockerfile comment
to prevent a future contributor from "fixing" it incorrectly; or (b)
restructure: have a `deps_prod` stage that COPYs only mix.exs+mix.lock
+ config and runs `mix deps.get --only prod && mix deps.compile`,
then `release` extends `deps_prod`, COPYs source, and runs `mix
release --overwrite`. Option (b) cuts ~30s off every prod deploy
(measured wall time of the deps step). Neither is urgent — operator
deploys infrequently.

---

### M9. `Dockerfile` runtime stage installs `sqlite3` package — but the runtime release does NOT use the sqlite3 CLI, only the `ecto_sqlite3` NIF. Dead apt dep

**Module:** infra | **File:**
`/Users/mbarnaba/code/grappa/Dockerfile:88-92`
**Category:** image bloat / attack surface

`apt-get install ... sqlite3` adds the CLI binary + libs that the
release never invokes. `ecto_sqlite3` ships its own bundled NIF that
links against the C library; the CLI is operator-debug-only, and the
canonical operator path is `scripts/db.sh` which exec's into the
container — but that script targets the dev container (compose.yaml),
not the prod release, since `in_container` requires `mix` (line 164 of
`_lib.sh` probes for it). Result: prod has `sqlite3` installed and
`scripts/db.sh` against `GRAPPA_PROD=1` would route to oneshot anyway.

**Fix:** Drop `sqlite3` from the runtime apt-install line. If
operator-side debugging is desired, document a `bin/grappa eval` query
verb or a separate `scripts/prod-db.sh` that spawns a oneshot
ecto-driven shell. Roughly 20MB image saving + reduced attack surface.

---

### M10. `Bootstrap.spawn_with_admission` Logger key `error: inspect(reason)` ships an inspect-formatted string (not the raw atom) — log lines are harder to grep

**Module:** cross-module | **File:**
`/Users/mbarnaba/code/grappa/lib/grappa/bootstrap.ex:255,362,379` +
sibling sites in `lib/grappa_web/controllers/networks_controller.ex:218,241`
**Category:** logging convention drift

`config/config.exs` allowlists `:error` and `:reason` as Logger
metadata keys. `Bootstrap` emits `[error: inspect(reason)] ++ log_keys`
— the wrapped `inspect` adds `:` prefix and quotes for atom-shaped
reasons, so `:no_server` ships as `error=:no_server` in the formatted
output but `error="no_server"` if `reason` is already a string. Other
sites use `error: reason` directly (assuming the value is already
loggable). Two formatting conventions for the same key.

**Fix:** Pick one. The straightforward path: `reason: reason` (atom
or struct, formatted by Logger backend's default inspect); reserve
`:error` for `Exception.message/1`-style messages. Or: standardise on
`error: inspect(reason)` everywhere and document at the allowlist.
Currently both shapes coexist.

---

### M11. `compose.override.yaml` is committed (gitignored separately at `.gitignore:49`) but the file exists in the working tree at root — `ls` shows `compose.override.yaml` AND `compose.override.yaml.example`

**Module:** infra | **Files:**
`/Users/mbarnaba/code/grappa/compose.override.yaml` (75 bytes),
`/Users/mbarnaba/code/grappa/compose.prod.override.yaml` (132 bytes),
`.gitignore:49-50`
**Category:** working-tree drift / accidental commit risk

These files exist but are properly gitignored — git status shows
clean. Not a CRITICAL since they're untracked, but the
`compose.{,prod.}override.yaml` files at the repo root contain
operator-specific bindings (LAN IPs, hostnames). A future contributor
running `git add -A` (which CLAUDE.md says NEVER do, but Claude has
historically erred on this) would commit them. Defense-in-depth: a
pre-commit hook OR a `git update-index --skip-worktree`-style flag
would harden against the accidental commit.

**Fix:** Add a one-line comment at the top of each
`compose.{,prod.}override.yaml.example` reminding operators that the
real override is gitignored — already partly there but make it more
prominent. Optionally add a pre-commit hook in
`.git/hooks/pre-commit.sample` (not enforceable, but a pointer for
operators).

---

## LOW

### L1. `compose.yaml` dev healthcheck `start_period: 60s` — first-boot dev container's healthcheck may not pass for 60+ seconds even though Phoenix typically boots in <5s, masking real boot failures

**Module:** infra | **File:** `/Users/mbarnaba/code/grappa/compose.yaml:62`
**Category:** observability

60s is generous for the first cold boot (deps.compile + ecto.migrate)
but obscures faster-fail cases. Consider 30s with explicit "increase
this if cold-boot >30s" comment.

### L2. `infra/snippets/security-headers.conf` line 48 CSP is on a single ~270-char line — hard to diff, hard to review

**Module:** infra | **File:**
`/Users/mbarnaba/code/grappa/infra/snippets/security-headers.conf:48`
**Category:** maintainability

Wrap the `add_header Content-Security-Policy ...` value across multiple
lines using nginx's string concatenation syntax (consecutive double-
quoted strings are concatenated). Each directive on its own line
makes diffs reviewable.

### L3. `register-dns.sh` not listed in `CLAUDE.md`'s scripts roster — same gap as 2026-05-03 L-cross-3

**Module:** docs | **File:** `CLAUDE.md` "How to run scripts" section
**Category:** docs/feedback memory followup
Re-flagged: the previous review noted this; still open.

### L4. `scripts/integration.sh` cleanup trap delegates to `$TESTNET down` (which deletes named volumes) — operator-set `KEEP_STACK=1` only skips this; no escape hatch for "tear containers but keep volumes for inspection"

**Module:** infra | **File:**
`/Users/mbarnaba/code/grappa/scripts/integration.sh:32-39`
**Category:** debug ergonomics

A "soft tear" mode (containers down, volumes kept) would help diagnose
post-mortem state. Not urgent.

### L5. `compose.yaml`/`compose.prod.yaml` log driver `json-file` rotates at 5MB×3 (dev) / 10MB×5 (prod) — under sustained debug-level logging the prod 50MB ceiling is plausibly inadequate post-Phase-5 PromEx rollout

**Module:** infra | **Files:**
`/Users/mbarnaba/code/grappa/compose.yaml:65-69`,
`/Users/mbarnaba/code/grappa/compose.prod.yaml:71-75`
**Category:** Phase 5 hardening pre-flag
Not urgent today (prod stays at `:info`); flag for the Phase-5
PromEx/JSON-logger work.

### L6. `compose.prod.yaml:107-108` tmpfs UID/GID literally `1000` rather than `${CONTAINER_UID:-1000}` — folded into M5

### L7. `Endpoint.@session_options.signing_salt: "rotate-me"` placeholder still present — same as 2026-05-03 L-web-4 (Phase 5 hardening)

**Module:** web | **File:**
`/Users/mbarnaba/code/grappa/lib/grappa_web/endpoint.ex:28`
Re-flagged for tracking.

### L8. `mix.exs:131` ci.check alias still uses `cmd mix compile --warnings-as-errors` workaround for the Boundary compiler — comment is clear but the cmd-mix shell-out hides the real failure mode (Mix's archive-table corruption when `compile --warnings-as-errors` runs inline)

**Module:** mix | **File:** `/Users/mbarnaba/code/grappa/mix.exs:124-130`
**Category:** brittleness

Documented exception — moduledoc explains the WHY. Defer; only flag if
a fresh test contributor hits the workaround unexpectedly.

---

## Notes on previously-reviewed findings (NOT re-flagged)

These 2026-05-03 HIGH/MEDIUM items are CLOSED per code inspection:

* **H1 (Application.get_env runtime reads in Admission/Captcha/
  FallbackController)** — closed via `Grappa.Admission.Config` boot-time
  snapshot in `:persistent_term`.
* **H2 (User logout doesn't disconnect WebSocket)** — closed by
  `auth_controller.ex:184-211`'s `maybe_disconnect_socket/1` calling
  `GrappaWeb.Endpoint.broadcast/3` to the user_socket id-topic.
* **H5 (captcha_provider_wire/0 hard-coded list + missing Boundary
  dep)** — closed by `Captcha` behaviour adding `wire_name/0` callback;
  GrappaWeb deps now lists Admission.
* **H6 (NetworkCircuit cooldown-expire race)** — closed by H6
  observation-token guard in `network_circuit.ex:130,234-255`.
* **H7 (NetworkCircuit window-reset drops prior_circuit_state)** —
  closed by the new `handle_closed_failure/4` clause + the
  `[{_, _, _, :open, _}]` handler at line 196-211.
* **H8 (mix grappa.set_network_caps raises KeyError)** — closed
  (per CP14 close).
* **H9 (client_id index shape)** — addressed via composite + partial
  index follow-up.
* **H10 (Networks.update_network_caps cannot CLEAR a cap)** — addressed
  in T31-cleanup.
* **H11 (.env.example missing T31 captcha env vars)** — closed: the
  `.env.example` now has the T31 captcha block at line 51-67.
* **H12 (IRC send_pong NUL echo)** — closed via `Parser.strip_unsafe_bytes/1`
  replacing `strip_crlf/1` (parser.ex:347-348).
* **M-arch-1 (Captcha.{Turnstile,HCaptcha} duplication)** — closed via
  `SiteVerifyHttp` extraction.
* **M-arch-2 (NetworkCircuit + Backoff overlap)** — closed via
  `Grappa.RateLimit.JitteredCooldown` extraction.
* **M-arch-6 (CSP CI test)** — closed by `csp_provider_test.exs`.
* **M-cross-2 (Bypass.expect_once)** — switched to `Bypass.expect`
  in the new `site_verify_http_test.exs`.
* **M-cross-3 (Captcha.{Turnstile,HCaptcha} test duplication)** —
  closed via shared `AdmissionCaptchaTestHelper`.
* **M-irc-2 (IRCServer busy-poll)** — closed via the new waiter shape
  in `test/support/irc_server.ex`.

All other 2026-05-03 MEDIUM/LOW items either landed in T31-cleanup or
remain documented as Phase-5 deferrals; not re-flagged.

---

---

## Trajectory

### What did we build in the last ~14 sessions?

Counting from the prior codebase review (2026-05-03, post-CP12 closure):

- **CP12 S31-S44** (2026-05-04 → 2026-05-05) — channel-client-polish cluster.
  T32 disconnect/connect verbs server-side + cic-side (S31, parked-flow gate
  for CP15). Persistence migrations + Session.Server state shells (S32).
  Sidebar + ComposeBox redesign in irssi shape, slash commands, mIRC formatting
  parser merged here, server-window pseudo-channel surface, mentions+watchlist,
  live nick rotation, DM (query) windows polish + `/msg` `/query`. 21 features
  across 14 sessions, ~9 hotfix cycles caught at deploy-smoke.
- **CP13** (2026-05-07 morning) — server-window cluster: numeric replies routed
  to natural windows as durable scrollback rows; `numericInline` ephemeral
  signal store dropped from cic; mIRC text-formatting parser folded; priority-
  chain rewrite of EventRouter NOTICE handling. 12 commits, single session.
- **CP14** (2026-05-07 midday) — scrollback / DM bug pay-down. Initial scroll
  position when no fresh unreads (B1), scroll-up doesn't loadMore (B2), DM
  windows show only outbound (B3). Three bug buckets in one session.
- **CP15** (2026-05-07 PM → 2026-05-08 ~01:00) — event-driven windows cluster.
  Six behavioral buckets + docs sweep. Server-side typed events (joined,
  join_failed, parted, kicked, members_seeded), wire modules per context,
  archive surface, `windowStateByChannel` cic mirror, drop optimistic STATE,
  drop loadMembers REST verb, full e2e matrix. The architectural shift:
  cic stops originating window state, becomes mirror-only. Wire-module rule
  elevated to CLAUDE.md hard invariant. Project-story episode S40 narrates it.

**Theme:** the recent arc has been **product surface filled in
behind the architecture**. CP12 was feature-rush (irssi-shape UX, slash
commands, formatting). CP13-14 were bug pay-downs that surfaced from CP12's
feature density. CP15 was the architectural correction CP12+13+14 collectively
revealed: when client-side state is "what the client expects to be true," it
lies. The server owns the system state; the client mirrors. Wire conversion
is per-context, not implicit in PubSub.

**Coherent — not scattered.** Every cluster in the window served the IRC
bouncer mission directly; no infrastructure-yak-shaving sessions in this
window.

### Does recent work serve the core mission?

Core mission per CLAUDE.md: always-on IRC bouncer + REST/WS API + browser
PWA + downstream IRCv3 listener facade (Phase 6).

**Yes.** Every cluster shipped product surface or removed a class of bug
that prevented the product from being trusted. The Phase-6 listener facade
benefits structurally from CP15 — typed events + wire modules per context
mean the listener will translate from `Grappa.Scrollback.Wire.message_payload/1`
into a CHATHISTORY response, not from a raw `%Message{}` struct. CP15
**reduced** the Phase-6 work, not just by leaving it unblocked but by
factoring through the right shape.

The one drift to flag: **infrastructure debt is accumulating around the
discipline that's enforcing CP15's invariants**. Three cross-cutting themes
in the architecture review (wire-module gap in Session.Server / Visitors,
client-side-state-machine sneak via `compose.ts setPending`, Session.Server
god module size) all add up to "the rule shipped in docs faster than in
code." Not a yak-shave, just incomplete migration discipline that the
"Total consistency or nothing" rule was supposed to prevent.

### What's stalling?

Items in todo.md that have been there ≥2 weeks without progress:

- **Phase 5 hardening backlog** — 11+ items including TLS verify chain,
  HSM-keyed Vault, NickServ REGISTER proxy, multi-server failover, post-WELCOME
  +r umode check, nick-collision GHOST/RECOVER, signing_salt rotation, bearer
  token off WS query string. Some have been in the Phase 5 bucket since CP08.
  These are deliberately deferred to Phase 5 and the deferral is documented;
  this is a **planned stall**, not a forgotten one. Risk: the longer they sit,
  the more `verify: :verify_none` and `signing_salt: "rotate-me"` placeholders
  feel like permanent state rather than temporary expedients.

- **Wishlist (vjt 2026-05-03)** — addressed-messages-on-return + auto-away
  hints. **NOT stalled** — auto-away itself was completed in CP12 (debounce +
  pagehide-immediate + mentions-while-away window). The "addressed-messages
  highlight on return-from-away" wishlist line is the next half. Filed but
  not promoted to a cluster yet.

- **Image upload cluster** — `project_image_upload` memory: post-channel-polish,
  brainstorm UX before code. Hasn't been opened yet. Logically next-up after
  channel-client-polish closes (closed CP12), so it's queue-position not stall.

- **D-cluster test-suite flakes** (sqlite Database busy under `max_cases > 1`,
  SessionSupervisor.max_restarts exhaustion, `Grappa.AccountsTest:20` duplicate
  name flake) — documented since CP08, still live in the todo. **Genuinely
  stalled.** They are pre-existing infra issues, not recent regressions; the
  sized cluster to fix them has been deferred for a month. Not blocking
  anything currently shipped, but the test suite occasionally lies about
  green.

### Observation items due for evaluation

- **`Grappa.version/0`** — zero callers (since CP08+). Either wire into
  `/healthz` JSON or drop. Evaluation overdue — the function has been
  parked through 4 codebase reviews now. Recommend: drop in next housekeeping.

- **mix release size on Debian-slim runtime** — never measured. Low priority
  but trivially measurable; should be a 5-minute experiment before another
  session passes.

- **Phase 5 nginx perf nit** (`keepalive 32` without `proxy_set_header
  Connection ""` — dead weight). Real perf gap but only measurable under
  load; deferred deliberately. Valid park.

### Risk check — anything we're ignoring?

**Real risks surfaced by THIS review** (not previously documented):

1. **W1 — `MessagesController.create` accepts `$server` PRIVMSG target.**
   Operator-privilege probing surface. Shipped to prod. **Should fix this
   week.**
2. **Cross-infra H3 — `mode1_login` skips `client_id` for admin user logins**
   → admins bypass per-(client, network) cap tracking entirely. The T31
   admission-control campaign was specifically designed around this counter;
   the visitor branch threads it but the user branch silently doesn't.
   **Real T31 hole, deserves a one-bucket fix.**
3. **Cross-infra H1 — `Networks.broadcast_state_change/4` bypasses
   `broadcast_event/2` AND has no `handle_info/2` in `GrappaChannel`.**
   T32 disconnect/connect state never reaches cic over WS — cic relies on
   refetch. The wire path is broken; tests pass via direct PubSub subscribe.
   **Will bite the next time `/disconnect` ships and someone wants the
   sidebar to react in real-time.**
4. **IRC S2 — stray upstream `AUTHENTICATE +` post-registration elicits
   verbatim SASL credential reply.** With Phase-1 `verify: :verify_none`,
   a MITM can extract the SASL password at any time post-registration.
   Phase-5 TLS hardening will mitigate but doesn't excuse the FSM-level
   bug. **Should ship a phase guard on the AUTHENTICATE clause now.**
5. **Cicchetto H1 — `awayStatus.ts` + `mentionsWindow.ts` register
   `on(token, …)` callbacks NOT inside `createEffect(…)`.** Identity-rotation
   cleanup never registers; tenant data leaks across logout/rotation despite
   moduledoc claims. **Single-tenant prod today, but the pattern is wrong
   and the moduledoc lies — fix before multi-tenant scenarios surface in
   testing.**
6. **Cicchetto H2 — token rotation installs duplicate channel-event
   handlers.** Every WS event fires both; presence/unread/mention counters
   double; N rotations = N+1 handlers per channel. Single-rotation users
   (every login session) double-count silently.

**Risks we're knowingly carrying** (already in todo Phase 5 bucket — flag
to ensure they don't grow roots):

- TLS `verify: :verify_none` (mentioned 7+ places now)
- Bearer token in WS query string
- `signing_salt: "rotate-me"` placeholder
- Service-worker requires HTTPS context (iOS Safari fails SW silently)

The longer Phase 5 sits parked, the harder it becomes to unsplit dev/prod
TLS posture. The unified compose memory (`project_unified_compose`) is
adjacent and deserves co-scheduling.

### Recommendation

**Sequence the next ~3-4 sessions like this:**

1. **`cp15-followups + admission-fixes` cluster** (small, ~half session).
   Ship `cp15-b6-parked.spec.ts` (T32 is shipped, spec is mechanical).
   Tighten the `wait_for` sentinel on `cp15-b6-pending-to-failed-invite-only.spec.ts`.
   Fix Web W1 (`$server` PRIVMSG target validator), Cross-infra H3 (`mode1_login`
   client_id), Cross-infra H1 (Networks broadcast wire shape + GrappaChannel
   `handle_info`), Cross-infra H2 (`grappa:ws_presence:` topic prefix).
   These are real prod bugs surfaced by THIS review, not feature work — they
   fit the "bug fixes are exempt from review gate" rule and close the
   silent-admission-hole + the silent-WS-state-drop class.

2. **`wire-discipline-sweep` cluster** (~half-to-full session). Per Theme 1
   in the arch review: extract `Grappa.Session.Wire` + `Grappa.Visitors.Wire`,
   pin a `@type wire_event_kind` enum on the server, ship `WireUserEvent`
   discriminated union in cic's `api.ts`, fix the three stale typespecs
   (`QueryWindows.windows_list_payload`, `GrappaChannel.query_windows_list_payload`,
   `query_windows.ex` Window.t() leak). Closes 6+ HIGH findings across both
   reviews, plus several MEDIUMs. Pairs with Cross-infra H1 fix from cluster
   1 (same surface).

3. **`server-side-pending + auth-fsm-phase-guards` cluster** (~half session).
   Per Theme 2 + the IRC S1-S4 cluster: move `:pending` window-state origination
   to server (drop cic's `setPending`); add phase guards to `AuthFSM.step/2`
   on the four post-registration-crash clauses (432/433/AUTHENTICATE/904-905);
   fix `Message.sender_nick/1` `nil` exposure from M-irc-1's `nilify/1`.
   Closes Theme 2 + IRC S1-S4 + a couple lifecycle line items.

4. **Re-evaluate.** With Themes 1 + 2 closed and the most-acute bugs fixed,
   the remaining MEDIUM/LOW findings can be triaged into a hardening pass
   or rolled into the next product cluster (image upload, addressed-messages
   wishlist, or Phase 5 TLS). The `Session.Server.WindowState` extraction
   (Theme 3) is the natural next-after-that — it's mechanical once Wire
   modules are everywhere.

**Don't:**
- Open a Phase 5 cluster yet. The wire-discipline + cic mirror invariants
  need to settle before TLS verification posture shifts. One thing at a time.
- Open a fresh feature cluster (image upload, addressed-messages) ahead of
  cluster 1. The bugs surfaced here are real and ship to prod — pre-feature
  hygiene per "Fix pre-existing errors first" CLAUDE.md rule.
- Promote any of these to a multi-week campaign. Each cluster above is
  bite-sized; the compounding gain is in shipping all three within a week,
  not in one mega-cluster.

**Tone check** (per `docs/reviewing.md` §3): not yak-shaving, but the
discipline gap on the wire-module rule is a real pattern — the next time
a CP15-shaped invariant lands, it should ship in code at the same beat
it lands in CLAUDE.md, not 1-2 buckets later. The "Total consistency or
nothing" rule was specifically designed to prevent the half-migration that
this review surfaces. Use the cluster-1 + cluster-2 sequence to close that
gap and bank the lesson.
