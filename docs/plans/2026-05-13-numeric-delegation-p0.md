# P-0 — Numeric delegation completion (WHOIS + AWAY + WHOWAS + LUSER + INVITING)

**Status**: brainstorm — implementation NOT started.
**Position**: pre-Phase-5 hardening. Closes the same disease class CP28
fixed for channel-state numerics (332/333/329) — Server's catch-all
persists every non-delegated numeric as a bare `:notice` row, leaking
unstructured upstream wire-text into scrollback when EventRouter could
fold it into a typed event instead.
**Origin evidence**: 2026-05-13 sonic /whois on Azzurra produced 3 raw
notice rows ("has identified for this nick", "is using a secure
connection (SSL)", "is a Services Agent") instead of folding into the
WHOIS bundle card.
**Source of truth**: `/tmp/bahamut/` (https://github.com/azzurra/bahamut
shallow clone) — `include/numeric.h` for codes, `src/s_err.c` for wire
formats, `src/s_user.c` (`m_whois`), `src/whowas.c`, `src/s_serv.c`
(`m_lusers`), `src/channel.c` (`m_invite`).

## Out-of-scope (deferred to a separate later cluster)

Per vjt 2026-05-13: only WHOIS-leg + standalone-AWAY + WHOWAS + LUSERS
+ INVITING in this bucket. The wider ~90-numeric audit (TRACE / STATS
/ MOTD / WATCH / SILE / DCC / ban-list / oper-info / error-suite) is
its own future cluster — DO NOT expand this one. CLAUDE.md "ask before
building" + memory `feedback_mega_cluster_lessons` apply.

## Disease shape (recap)

`Grappa.Session.Server.handle_info({:irc, %Message{command: {:numeric,
N}}}, state)` runs a two-pass:

1. EventRouter has dedicated `route/2` handlers for some N → fold into
   typed state + emit typed effect → broadcast typed wire event.
2. Catch-all path persists EVERY non-delegated numeric as a bare
   `:notice` row (sender = upstream server name, body = trailing
   param), routed via `Grappa.Session.NumericRouter.route/2`'s active /
   delegated / param-derived matrix.

`@delegated_numerics` in `numeric_router.ex` is the gate: numerics in
that set short-circuit the catch-all so the bare notice is NOT
written. Anything outside the set leaks the trailing param verbatim
(e.g. 333's `1776720934` Unix timestamp, 307's "has identified for
this nick" English string).

The fix per CP28 precedent: add the numeric to `@delegated_numerics`
+ add an EventRouter handler that folds into typed state and emits a
typed `apply_effects` clause that broadcasts a structured wire event
(NEVER a localized string per `feedback_no_localized_strings_server_side`).

## Domain 1 — WHOIS leg (P-0a, ~1 day, HOT-deployable)

### Bahamut emit order (m_whois — `src/s_user.c:2200-2373`)

1. **311 RPL_WHOISUSER** — always — `nick user host * :realname` —
   ✅ already folded.
2. **378 RPL_WHOISACTUALLY** (Azzurra) — oper-visible —
   `:is connecting from %s [%s]` (host + ip) — ❌ bare notice.
3. **326 RPL_WHOISMODES** (Azzurra) — IsAnOper — `:is using modes %s` —
   ❌ bare notice.
4. **319 RPL_WHOISCHANNELS** — channels visible — `:@#chan +#chan` —
   ✅ folded.
5. **312 RPL_WHOISSERVER** — always — `server :info` — ✅ folded.
6. **307 RPL_WHOISREGNICK** — IsRegNick — `:has identified for this
   nick` — ❌ bare notice (sonic-whois evidence line 1).
7. **301 RPL_AWAY** — user->away — `:away message` — ❌ bare notice.
   Dual-purpose — fold gated on `whois_pending[lower-nick]` presence;
   standalone-PRIVMSG case handled in Domain 2.
8. **275 RPL_USINGSSL** — IsUmodeS — `:is using a secure connection
   (SSL)` — ❌ bare notice (sonic-whois evidence line 2).
9. **313 RPL_WHOISOPERATOR** — IsAnOper or IsSAdmin — `:is %s` —
   ✅ folded.
10. **325 RPL_WHOISAGENT** (Azzurra) — IsUmodez — `:is a Services
    Agent` — ❌ bare notice (sonic-whois evidence line 3).
11. **310 RPL_WHOISHELPER** — IsUmodeh — `:is a Help Operator` —
    ❌ bare notice.
12. **317 RPL_WHOISIDLE** — MyConnect — ✅ folded.
13. **318 RPL_ENDOFWHOIS** — always — ✅ closes bundle.

Defined-but-not-emitted-by-`m_whois` (futureproof for other ircds /
services injection):

- **308 RPL_WHOISADMIN** — `:is an IRC Server Administrator`.
- **309 RPL_WHOISSADMIN** — `:is a Services Administrator`.
- **316 RPL_WHOISCHANOP** — RFC1459 compat, `NULL` in Bahamut today.
- **339 RPL_WHOISJAVA** (Azzurra) — `:is a Java User`.

### P-0a folds

| Num | Target arg | Fold into `whois_pending[target_lower]` |
|---|---|---|
| 275 | params[1] | `using_ssl: true` |
| 301 | params[1] | `away_message: String.t()` (gated — see below) |
| 307 | params[1] | `is_registered: true` |
| 308 | params[1] | `is_admin: true` |
| 309 | params[1] | `is_services_admin: true` |
| 310 | params[1] | `is_helper: true` |
| 316 | params[1] | `is_chanop: true` |
| 325 | params[1] | `is_agent: true` |
| 326 | params[1] | `umodes: String.t()` (trailing = mode string) |
| 339 | params[1] | `is_java: true` |
| 378 | params[1] | `actually_host: String.t(), actually_ip: String.t()` |

### 301 dual-purpose gate

301 fires both inside a WHOIS bundle AND standalone when you PRIVMSG
an away user. Same shape as the existing 311 fold gate:

```elixir
def route(%Message{command: {:numeric, 301}, params: [_, target | rest]}, state)
    when is_binary(target) do
  case Map.has_key?(state.whois_pending, normalize_nick(target)) do
    true ->
      msg = whois_trailing(rest)
      {:cont, whois_fold(state, target, %{away_message: msg}), []}
    false ->
      :delegated  # Domain 2 picks it up
  end
end
```

Domain 2 handles the standalone case (typed `peer_away` event on the
DM scrollback) — see below.

### Files touched (P-0a)

- `lib/grappa/session/numeric_router.ex` — extend `@delegated_numerics`
  with `[275, 301, 307, 308, 309, 310, 316, 325, 326, 339, 378]`.
- `lib/grappa/session/event_router.ex` — 11 new `route/2` clauses
  (folds) + extend `whois_pending[target]` accumulator type +
  `whois_bundle` effect carries the new keys.
- `lib/grappa/session/wire.ex` — extend `:whois_bundle` payload shape;
  ADD-ONLY (no breaking field renames). Server emits typed booleans /
  strings; cic owns localization per
  `feedback_no_localized_strings_server_side`.
- `cicchetto/src/.../whoisCard.tsx` (or wherever the card lives —
  grep first) — render new flags. cic builds the human strings.
- `cicchetto/src/wireNarrow.ts` — extend WhoisBundle payload type.
- Tests:
  - `test/grappa/session/event_router_test.exs` — one test per
    new numeric folding, one bundle integration test asserting all
    flags present.
  - `cicchetto/src/.../whoisCard.test.tsx` — render assertions.
- Optional Playwright: `/whois <known-services-agent-nick>` on the
  Bahamut testnet asserts the card shows "Services Agent" badge
  (cic-built string from `is_agent: true`).

### Deploy (P-0a)

HOT-eligible. `whois_pending` entries are arbitrary maps — no
struct field added. `wire.ex` payload extension ADD-ONLY → cic forward-
compat (old cic ignores new keys). New cic wants new server, so
sequence: `scripts/deploy.sh` → `scripts/deploy-cic.sh` →
healthcheck → live /whois verification.

## Domain 2 — Standalone AWAY (P-0b, ~half day, HOT-deployable)

### Numerics

- **301 RPL_AWAY** — fires on PRIVMSG to an away user (`server 301
  own_nick target_nick :away_msg`). Dual-purpose — Domain 1 handles
  the WHOIS-bundle case via the `whois_pending` gate; Domain 2 handles
  the standalone case.
- **305 RPL_UNAWAY** — confirms own /away off — ✅ already in
  `@active_numerics` (active-window route).
- **306 RPL_NOWAWAY** — confirms own /away on — ✅ already in
  `@active_numerics`.
- **429 ERR_TOOMANYAWAY** — flood protection — fold into active-
  window? CONSIDER LATER (defer to wider error-audit cluster).

### Standalone-301 design

When you /msg an away user, upstream sends:
```
:server 301 own_nick target_nick :I am away message
```

Currently leaks as a bare notice on the server-msgs window with body =
"I am away message". The structured target IS the DM window with
target_nick.

**Proposed**: typed `:peer_away` effect → wire event `peer_away`
broadcast on the DM window's per-channel topic, payload `%{peer:
target_nick, message: away_message_text}`. Cic dm-listener renders an
inline ephemeral row "(target_nick is away: <msg>)" — same shape as
the existing inline whois ephemeral.

OPEN: should the server SUPPRESS subsequent peer_away events for the
same target within a short window (most clients don't want a banner
on every PRIVMSG to the same away user)? Likely yes — cache last-seen
per (network, target_lower) and only re-emit if msg changed or
stale-by-N-seconds. Brainstorm before code.

### Files touched (P-0b)

- `lib/grappa/session/event_router.ex` — standalone-301 arm + per-
  network away_seen cache (or skip the cache, push to cic and let cic
  rate-limit display).
- `lib/grappa/session/wire.ex` — new `:peer_away` wire event.
- `cicchetto/src/.../dmPane.tsx` — render the ephemeral.
- Tests + Playwright (new ux behavior → e2e mandatory per
  `feedback_ux_e2e_mandatory`).

### Deploy (P-0b)

HOT-eligible if no struct field added (away_seen cache lives in
EventRouter local state if added; otherwise cic-only display state).

## Domain 3 — WHOWAS (P-0c, ~half day, HOT-deployable)

### Bahamut emit order (whowas.c:160-191)

1. **314 RPL_WHOWASUSER** — `nick user host * :realname` — multiple
   rows possible (history depth) — ❌ bare notice.
2. **312 RPL_WHOISSERVER** — `nick server :ctime(logoff_time)` — REUSE
   of 312 with logoff_time as the trailing — ✅ already folded but
   into WHOIS-pending; conflict if WHOIS + WHOWAS interleave (rare but
   possible).
3. **369 RPL_ENDOFWHOWAS** — `:End of WHOWAS` — ❌ bare notice.
4. **406 ERR_WASNOSUCHNICK** — `:There was no such nickname` — ❌ bare
   notice on 0-history result.

### Design

WHOWAS is structurally a multi-row reply with N entries terminated by
369. Same accumulator shape as WHO (cluster B `:who_pending`):

- Add `state.whowas_pending: %{target_lower => [%{user, host, realname,
  server, logoff_time}, ...]}`.
- 314 → append to list (if pending entry exists).
- 312 → CONFLICT GATE: if `whowas_pending[target_lower]` exists AND
  `whois_pending[target_lower]` does NOT, fold 312's trailing as
  `logoff_time` into the LAST whowas entry (most recent 314 row);
  else fall through to existing WHOIS fold.
- 369 → emit `:whowas_bundle` effect with the accumulated list, drop
  pending entry.
- 406 → emit `:whowas_not_found` effect for the target → typed wire
  event → cic surfaces.

Initial pending entry created when the operator issues `/whowas
<target> [count]` via `:send_whowas` server command (NEW — currently
no /whowas command at all in the codebase, grep first).

### Files touched (P-0c)

- `lib/grappa/session/numeric_router.ex` — `@delegated_numerics +=
  [314, 369, 406]`.
- `lib/grappa/session/event_router.ex` — 314/369/406 handlers + 312
  conflict-gate logic + `whowas_pending` map.
- `lib/grappa/session/server.ex` — new `:send_whowas` handler if
  `/whowas` slash-command is in scope (CHECK — may be deferred).
- `lib/grappa/session/wire.ex` — `:whowas_bundle` + `:whowas_not_found`
  events.
- cic — new WhowasCard or reuse WhoisCard with `kind: "whowas"`.
- `/whowas` slash command added to cic command palette.
- Tests + Playwright.

### Open before P-0c

1. Is `/whowas` even in scope? Channel-client-polish cluster spec
   memory `project_channel_client_polish` doesn't mention it — needs
   vjt confirmation. If NO, defer P-0c entirely (only handle if
   operator never issues /whowas, the numerics never arrive).
2. 312 conflict-gate: reasonable to assume WHOIS + WHOWAS for the
   same target are not interleaved (operator-driven; one at a time)?

## Domain 4 — LUSERS bundle (P-0d, ~half day, HOT-deployable)

### Bahamut emit order (s_serv.c:2266-2296)

ALL emitted on connection welcome (post-001) AND on operator-issued
`/lusers`:

1. **251 RPL_LUSERCLIENT** — `:There are %d users and %d invisible on
   %d servers` — ❌ bare notice (rendered today as raw text on
   server-msgs window).
2. **252 RPL_LUSEROP** — `%d :IRC Operators online` — ❌ bare notice.
3. **253 RPL_LUSERUNKNOWN** — `%d :unknown connection(s)` — ❌ bare
   notice. Optional (only if count > 0 in some Bahamut paths).
4. **254 RPL_LUSERCHANNELS** — `%d :channels formed` — ❌ bare notice.
5. **255 RPL_LUSERME** — `:I have %d clients and %d servers` — ❌
   bare notice.
6. **265 RPL_LOCALUSERS** — `:Current local users: %d Max: %d` — ❌
   bare notice.
7. **266 RPL_GLOBALUSERS** — `:Current global users: %d Max: %d` —
   ❌ bare notice.

### Design

LUSERS is a self-contained bundle with no terminator numeric. Sequence
is fixed in Bahamut (251 → 252 → 253? → 254 → 255 → 265 → 266). The
"end" is implicit (no further LUSER-class numeric within a short
window).

Two design options:

**(a) Per-numeric typed event** — emit 7 typed events (`:luser_client`,
`:luser_op`, ...) and let cic compose the LUSERS card from the latest
of each.

**(b) Single bundle** — accumulate in `state.lusers_pending` (start
on first 251, populated by all subsequent until the next non-LUSER
numeric arrives or a 100ms debounce expires), emit one
`:lusers_bundle` effect. Cic renders one card.

**Lean: (b)** — cleaner cic store (one network → one LUSERS snapshot,
overwritten on next /lusers); bundle shape mirrors WHO/WHOIS pattern;
no "card with 7 rows that may load progressively" UX problem.

Bundle payload:
```
%{
  total_users: integer(),
  invisible: integer(),
  servers: integer(),
  operators: integer(),
  unknown_connections: integer() | nil,
  channels_formed: integer(),
  local_clients: integer(),
  local_servers: integer(),
  current_local: integer(), max_local: integer(),
  current_global: integer(), max_global: integer()
}
```

### Files touched (P-0d)

- `lib/grappa/session/numeric_router.ex` — `@delegated_numerics +=
  [251, 252, 253, 254, 255, 265, 266]`.
- `lib/grappa/session/event_router.ex` — 7 fold handlers + bundle
  emit (debounce or implicit-end).
- `lib/grappa/session/wire.ex` — `:lusers_bundle` event.
- `cicchetto/src/.../luserCard.tsx` (NEW) + cic store +
  /lusers slash command if not present.
- Tests + Playwright (new UX → mandatory).

### Open before P-0d

1. Where do LUSERS render? Server-msgs window (existing) as a
   structured card, or new dedicated widget? Lean: server-msgs window
   card row, same place /links output goes.
2. Welcome-time LUSERS (auto-emitted on connect) — render or
   suppress? Most operators don't need the auto-emit visible;
   operator-issued /lusers should always show. Distinguish via
   labeled-response (cap is opportunistic; without it, fall back to
   "always render").
3. Bundle terminator strategy — implicit-end (any non-LUSER numeric
   closes the bundle) is simpler than debounce. Pick implicit-end?
4. Per-numeric integer parsing — 253 RPL_LUSERUNKNOWN may be omitted;
   handle as optional.

## Domain 5 — INVITING ack (P-0e, ~quarter day, HOT-deployable)

### Bahamut emit (channel.c:3006)

**341 RPL_INVITING** — `:server 341 own_nick target_nick channel` —
sent to the inviter as confirmation that the INVITE was relayed —
❌ bare notice today (raw text on active window).

### Design

When operator issues `/invite <nick> <channel>`, upstream replies with
341 confirming the invite was relayed. Currently leaks as bare notice
with body = "" (no trailing) and confusing meta.

Typed `:invite_ack` effect → wire event `invite_ack` payload `%{nick:
target_nick, channel: channel}` broadcast on the channel's per-channel
topic. Cic renders inline confirmation in the channel scrollback ("→
invited target_nick").

### Files touched (P-0e)

- `lib/grappa/session/numeric_router.ex` — `@delegated_numerics +=
  [341]`.
- `lib/grappa/session/event_router.ex` — 341 handler.
- `lib/grappa/session/wire.ex` — `:invite_ack` event.
- cic — extend channel scrollback render for the new event kind.
- Tests + Playwright (UX-touching, mandatory).

### Open before P-0e

1. Does `/invite` slash command exist? Per
   `project_channel_client_polish` channel-ops list yes (`/invite`
   listed). Verify wiring before adding.
2. Should INVITE-RECEIVED side (when SOMEONE invites YOU — `INVITE`
   command, not numeric) get the same treatment? Out-of-scope for
   numeric audit — but flag.

## Bucket order proposal

**Inside this cluster** (numeric-delegation):

1. **P-0a WHOIS** — most evidence (sonic-whois live), most folds, most
   structured fix. Ship first.
2. **P-0b standalone-AWAY** — small but UX-distinct. Ship after WHOIS
   so the 301 dual-purpose gate exists.
3. **P-0e INVITING** — smallest, single-numeric, low-risk. Ship third.
4. **P-0d LUSERS** — needs UX brainstorm + cic card design. Ship
   fourth.
5. **P-0c WHOWAS** — gated on whether /whowas slash command is in
   scope. Ship LAST or DROP if /whowas not blessed.

**Then opens Phase 5 hardening cluster** per
`/tmp/orchestrate-next.txt` (P-1 Sobelow → P-2 TLS → P-3 jitter →
P-4 PromEx → P-5 NickServ).

## Cluster-wide standing rules

- Per `feedback_no_localized_strings_server_side`: server emits typed
  booleans / integers / atoms / ISO timestamps; **cic owns all human-
  readable strings**. Never bake "is using a secure connection" into
  wire payloads.
- Per `feedback_landed_claim_evidence`: each P-0[a-e] LANDED requires
  literal `scripts/check.sh` exit-0 tail paste + literal CI run ID
  green-on-first-run.
- Per `feedback_per_bucket_deploy`: deploy + healthcheck + browser-
  smoke at each P-0[a-e] close.
- Per `feedback_ux_e2e_mandatory`: every cic-touching bucket ships
  with a Playwright e2e via `scripts/integration.sh`.
- Per `feedback_dialyzer_plt_staleness`: standalone
  `scripts/dialyzer.sh` before each LANDED claim.
- Per `feedback_deploy_sh_preflight_field_addition_gap`: any new
  field added to `state.{whois,whowas,lusers}_pending` is a Server
  state-shape change → `--force-cold` deploy.
- Per `feedback_recurring_e2e_not_flake`: same-triplet recurring
  failures are NEVER flakes; investigate before liquidating.

## Existing scrollback rows (historical)

Per CP28 precedent: do NOT clean up existing bare-notice rows from
275/301/307/325/etc. Cosmetic — cic continues rendering historical
rows as they were persisted. New WHOIS/AWAY/etc. invocations after
deploy will produce the structured cards.

## First-action checklist (next session)

1. `cd /Users/mbarnaba/code/grappa/.worktrees/phase-5` (worktree
   already exists at `cluster/phase-5-hardening` branch).
2. Re-baseline: `scripts/check.sh` exit-0 from the worktree.
3. Decide whether the numeric-delegation cluster wants its OWN branch
   (`cluster/numeric-delegation-p0`) or piggybacks on
   `cluster/phase-5-hardening`. Lean: SEPARATE branch — cleaner blame,
   doesn't block Phase 5 if a P-0 sub-bucket stalls.
4. Open P-0a (WHOIS): grep cic for existing WhoisCard + extend +
   wireNarrow. Server-side first (numeric_router + event_router +
   wire), then cic (store + component), then tests, then deploy.
5. Per-bucket deploy + verify with live /whois on Azzurra against
   a known IsRegNick + IsUmodez user before marking LANDED.

## Source-tree references (Bahamut)

- `/tmp/bahamut/include/numeric.h` — all 231 RPL_/ERR_ defines.
- `/tmp/bahamut/src/s_err.c` — wire format strings (the
  authoritative `":%s NNN %s ..."` templates).
- `/tmp/bahamut/src/s_user.c:2200-2373` — `m_whois` emit sequence.
- `/tmp/bahamut/src/whowas.c:160-191` — `m_whowas` emit sequence.
- `/tmp/bahamut/src/s_serv.c:2266-2296` — `m_lusers` emit sequence.
- `/tmp/bahamut/src/channel.c:3006` — `m_invite` 341 emit.

## Source-tree references (grappa, current state)

- `lib/grappa/session/numeric_router.ex:112-189` — `@active_numerics`
  + `@delegated_numerics`.
- `lib/grappa/session/event_router.ex:768-878` — existing WHOIS leg
  handlers (311/312/313/317/318/319) + `whois_pending` accumulator.
- `lib/grappa/session/event_router.ex:881-947` — 315/352 WHO leg as a
  shape reference for how WHOWAS bundle should look.
- `lib/grappa/session/server.ex:2008-2073` — `apply_effects`
  precedent for typed-event broadcast pattern.
- `lib/grappa/session/wire.ex` — wire shape definitions; ADD-ONLY
  for new events.
