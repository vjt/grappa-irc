# No silent drops + inbound INVITE + clickable links + Sobelow (cluster)

**Status**: brainstorm — implementation NOT started.
**Branch**: `cluster/no-silent-drops`.
**Position**: post-`P-0 numeric-delegation` (CLOSED 2026-05-14, see
`project_p0_numeric_delegation_closed`). Cluster scope blessed by
vjt 2026-05-14 with FULL ORCHESTRATOR AUTOMATION.
**Origin evidence**: vjt's live smoke during P-0 close —
`:vjt!~vjt@host INVITE grappa :#sbiffo` lands on the upstream wire
and cic shows nothing. EventRouter's catch-all
`def route(%Message{} = _, state), do: {:cont, state, []}` (line
1489) is the silent-drop hole. Same disease class as CP28 / P-0
(structured numerics leaking as bare notices) but for whole IRC
verbs, not numerics.
**North star**: every byte the upstream sends becomes either a typed
event with a typed wire shape OR a structured `:notice` row with
`meta.raw = %{verb, sender, params}` — body always nil server-side
per `feedback_no_localized_strings_server_side`. cic owns
human-readable rendering.

## Cluster ordering

| Bucket | Surface | Risk | Deploy | Notes |
|---|---|---|---|---|
| 0 | `compose.ts` requireChannel | trivial cic | cic-only | LANDED — `/invite foo #chan` from $server |
| 1 | EventRouter fallthrough → structured :notice | medium | HOT | LANDED — meta.raw shape; cic ScrollbackRow renderRawEvent arm |
| 2 | Inbound INVITE handler | small | HOT | typed `peer_invite` row + clickable [Join] CTA |
| 3 | Bahamut numerics audit + matrix | small | none (audit only — see B3 SCOPE FINDING) | LANDED — every emitted numeric has known disposition; ADD-HANDLER cases (UMODEIS / banlist / WATCH) deferred to post-cluster polish |
| 4 | Clickable URLs in scrollback | small | cic-only | linkify body; new tab; defer hover/image |
| 5 | **Codebase review** (parallel agents per `/review`) | medium | none (review only) | reshape per vjt 2026-05-14 — was Sobelow; Sobelow moved to B6. Output prioritized findings (crit / high / important-med). |
| 6 | **Sobelow + review fold-in** | small-medium | HOT | Sobelow hardening (was B5) PLUS remediate any crit/high/important-med findings from B5 review. |

## Standing rules (cluster-wide, carried from P-0)

- **Wire-shape rule**: server emits typed booleans / integers / atoms
  / ISO timestamps; cic owns ALL human-readable strings. Per
  `feedback_no_localized_strings_server_side`. **Body stays nil**
  for any new `:notice` row that exists ONLY to surface raw upstream
  state — humans render from `meta.raw`.
- **Routing for ephemerals carrying their own `network` field**:
  `Topic.user/1` (peer_away, lusers_bundle, whois_bundle,
  whowas_bundle, invite_ack precedents — and now peer_invite).
- **Per-bucket discipline**: `scripts/check.sh` exit 0 +
  `scripts/bun.sh run check` + `scripts/bun.sh run test` +
  `scripts/integration.sh --grep <bucket-tag>` +
  `scripts/integration.sh` full regression sanity + commit + push +
  per-bucket deploy + browser smoke. Per `feedback_per_bucket_deploy`
  + `feedback_landed_claim_evidence`.
- **LANDED claim evidence**: literal `scripts/check.sh` exit-0 tail
  in commit message.
- **Hot-vs-cold deploy**: B3 SCOPE FINDING (2026-05-14) reduced
  bucket 3 to docs-only (no struct field added — the catch-all
  already attaches `meta.numeric/severity` for non-delegated
  numerics). All shipped buckets (0/1/2/4) HOT-eligible or
  cic-only. Bucket 5 review-only; bucket 6 depends on review
  findings.

## Bucket 0 — compose.ts requireChannel skip-when-supplied

### Origin

Memory `project_p0_numeric_delegation_closed` flagged uncommitted
edit on disk in `.worktrees/p0-numerics`. Audit found the worktree
clean — fix was never committed. This bucket re-derives + lands it.

### Disease

`requireChannel(verb)` returns `{ error: "/<verb> requires an active
channel window" }` when called from `$server` / `mentions` /
`query`. The `/invite <nick> [#chan]` case in `compose.ts:432` calls
`requireChannel("invite")` UNCONDITIONALLY then overrides with
`cmd.channel ?? chanOrErr` — but `requireChannel` already returned
the error before the override could apply. Net: `/invite foo
#it-opers` from `$server` silently errors with a swallowed inline
error.

### Fix shape

```typescript
case "invite": {
  // /invite <nick> [#chan] — channel defaults to active window.
  // P-0f follow-up: when the channel arg is supplied explicitly,
  // SKIP requireChannel — typing /invite foo #it-opers from
  // $server (or any non-channel window) was the common workflow
  // that pre-fix silently errored ("requires an active channel
  // window") because requireChannel was unconditionally evaluated.
  let chan: string;
  if (cmd.channel !== null) {
    chan = cmd.channel;
  } else {
    const chanOrErr = requireChannel("invite");
    if (typeof chanOrErr !== "string") return chanOrErr;
    chan = chanOrErr;
  }
  const networkId = networkIdBySlug(networkSlug);
  if (networkId === undefined) return { error: "/invite: network not found" };
  pushChannelInvite(networkId, chan, cmd.nick);
  result = { ok: true };
  break;
}
```

### Audit of other `requireChannel` call sites

`grep` shows 9 verbs call `requireChannel`: `op`, `deop`, `voice`,
`devoice`, `kick`, `ban`, `unban`, `banlist`, `invite`. Inspecting
the parser (`cicchetto/src/lib/slashCommands.ts`) reveals **only
`invite` carries an optional `channel: string | null` field** —
all others parse with verb-only args. Two further verbs (`umode`,
`mode`) already skip `requireChannel` per their inline comments
("target explicit in args").

Conclusion: bucket 0 is the single `invite` fix. No other call
site needs the skip-when-supplied pattern under today's parser.
If the parser ever grows optional-channel args for `/op` etc., the
same pattern applies.

### Files

- `cicchetto/src/lib/compose.ts` — invite case rewrite.
- `cicchetto/src/__tests__/compose.test.ts` (or sibling) — vitest:
  `/invite foo #chan` from a non-channel window submits the WS push
  with `chan = "#chan"`; bare `/invite foo` from `$server` returns
  the error.

### Deploy + smoke

cic-only (`scripts/deploy-cic.sh`). Browser smoke: `/invite vjt
#bofh` from `$server` — verify the Bahamut testnet receives the
INVITE.

## Bucket 1 — EventRouter fallthrough → structured :notice

### Disease

`lib/grappa/session/event_router.ex:1489`:

```elixir
def route(%Message{} = _, state), do: {:cont, state, []}
```

EVERY unhandled command verb (KILL, WALLOPS, GLOBOPS, ERROR,
CHGHOST, AUTHENTICATE, vendor `BANCHAN`, vendor `SVSPART`, …)
returns no effects → no scrollback row → silent drop.

NumericRouter handles the numeric catch-all separately
(`{:server, nil}` last resort — see `numeric_router.ex:351`), so
bucket 1 is purely the IRC-command-verb side. But verify nothing
in `Session.Server.handle_info` short-circuits before reaching
EventRouter for unknown commands.

### Body shape — DEVIATION from initial brief

Initial orchestrator brief said `body: nil` server-side per
`feedback_no_localized_strings_server_side`. **Drift**:
`Grappa.Scrollback.Message.changeset/2` rejects `body: nil` for
`:notice` (`@body_required_kinds = [:privmsg, :notice, :action,
:topic]` enforces `validate_required([:body])`).

Two valid resolutions:

1. **Add a new `:server_event` (or `:raw_event`) kind** that
   accepts nil body. Requires schema migration + DB CHECK
   constraint update + cold deploy. Semantically clean (unknown
   command-verb events ARE a distinct event class).
2. **Reuse `:notice` with body = trailing param**. Body is the
   upstream's verbatim wire text — NOT a localized server-side
   English template (the principle is "server doesn't manufacture
   localized strings"; faithfully storing what came over the wire
   is fine). meta.raw carries the structured fields for cic's
   pretty-render arms; body is the human-readable fallback. Same
   shape as `Session.Server`'s `numeric_router.ex:1545` catch-all
   that already does this for unstructured numerics.

**Going with (2)** — hot-deployable, consistent with NumericRouter
precedent, no migration + cold-deploy cost. cic's pretty-render
arms key off meta.raw.verb; body is the fallback used only when
no per-verb arm matches.

### Fix shape

Replace the fallthrough with a structured persist:

```elixir
def route(%Message{command: command, params: params} = msg, state) do
  sender = Message.sender_nick(msg)
  trailing = List.last(params) || ""
  meta = %{
    raw: %{
      "verb" => command_to_verb_string(command),
      "sender" => sender,
      "params" => params
    }
  }
  {state, eff} =
    build_persist(state, :notice, "$server", sender, trailing, meta)
  {:cont, state, [eff]}
end
```

Where `command_to_verb_string/1`:

- atom `:wallops` / `:invite` / `:kill` / `:authenticate` /
  `:error` → `String.upcase(Atom.to_string(atom))`.
- `{:unknown, "VERB"}` → `"VERB"` (parser already uppercases).
- `{:numeric, n}` → unreachable (numerics never reach EventRouter
  fallthrough — they go through Session.Server's numeric handler).
  Belt-and-braces: `Integer.to_string(n)`.

### `meta.raw` shape

```elixir
%{
  raw: %{
    "verb" => String.t(),       # uppercased command verb
    "sender" => String.t(),     # nick prefix or "*" sentinel
    "params" => [String.t()]    # raw parsed params, last = trailing
  }
}
```

Nested map uses STRING keys (Meta only allowlists the top-level
`:raw` atom; nested values are opaque-pass-through map). cic reads
JSON keys-as-strings.

`Scrollback.Meta.@known_keys` extended with `:raw`. `config/config.exs`
Logger metadata already has `:raw` (line 121) — `meta_test.exs`'s
A18 sync test passes.

### cic-side render

`cicchetto/src/lib/ScrollbackRow.tsx` (or wherever the `:notice`
arm lives — grep first) gains a `meta.raw` branch:

```tsx
if (row.kind === "notice" && row.meta?.raw) {
  const { verb, sender, params } = row.meta.raw;
  return prettyRenderForVerb(verb, sender, params)
      ?? <DefaultRawRow verb={verb} sender={sender} params={params} />;
}
```

`prettyRenderForVerb` grows incrementally — start with a small
table of common verbs:

- `KILL` — `<sender> killed <target> (<reason>)`
- `WALLOPS` — `[Wallops from <sender>]: <text>`
- `GLOBOPS` — `[Globops from <sender>]: <text>`
- `ERROR` — `Server error: <text>`
- `CHGHOST` — `<old_nick> changed host to <user>@<host>`
- `AUTHENTICATE` — should never reach scrollback (SASL handshake
  framing is internal). If it does: `[SASL: <…>]` as raw fallback.

`DefaultRawRow` renders `<sender> <VERB> <params joined with ' '>`
in muted styling.

### Files

- `lib/grappa/session/event_router.ex` — replace fallthrough +
  add `command_to_verb_string/1` private helper.
- `lib/grappa/scrollback/message.ex` — extend Meta.t typespec for
  the `raw` key (if Meta is a typed map; else no-op).
- `cicchetto/src/lib/ScrollbackRow.tsx` (or actual renderer) —
  meta.raw branch + per-verb pretty-render arms + DefaultRawRow.
- `cicchetto/src/lib/wireNarrow.ts` — extend ScrollbackMessage Meta
  type with optional `raw: { verb, sender, params }`.
- Tests:
  - `test/grappa/session/event_router_test.exs` — KILL, WALLOPS,
    sample vendor verb each emit `:persist` not `[]`. Assert
    `meta.raw` shape pinned + body nil + channel `$server`.
  - `cicchetto/src/__tests__/ScrollbackRow.test.tsx` — meta.raw
    render branch (default + per-verb). Vitest.
  - `test/grappa/integration/...` — feed a synthetic vendor verb
    (`:vjt FOO arg1 arg2 :trailing`) via `Grappa.IRCServer` test
    helper, assert it lands as `:notice` with meta.raw shape on
    `$server` scrollback.
  - Playwright e2e — minimal: `/quote KILL ...` impossible
    (operator can't issue arbitrary). Skip e2e for bucket 1
    proper; bucket 2's INVITE e2e covers the meta.raw render
    path indirectly.

### Deploy

HOT-eligible — no struct field added. Effect is one new
`build_persist` call site + cic bundle. Sequence:
`scripts/deploy.sh` → `scripts/deploy-cic.sh` → healthcheck →
exercise inbound vendor verb (Bahamut testnet's WALLOPS path is
easy: `/quote WALLOPS test` from operator after oper-up).

## Bucket 2 — Inbound INVITE handler

### Wire shape (Bahamut)

`channel.c:m_invite` in Bahamut emits to peers:

```
:vjt!~vjt@host INVITE grappa :#sbiffo
```

EventRouter currently silent-drops (no `:invite` command clause),
so bucket 1 would surface it as a `meta.raw` notice on `$server`.
This bucket gives it a richer typed surface so cic can render a
clickable [Join] row.

### Typed effect + wire event

```elixir
def route(%Message{command: :invite, params: [_target, channel | _]} = msg, state)
    when is_binary(channel) do
  from_nick = Message.sender_nick(msg) || Message.prefix(msg) || ""
  effect = {:peer_invite, from_nick, channel}
  {:cont, state, [effect]}
end
```

`apply_effects` arm (in `Session.Server`):

- Build wire payload `%{kind: "peer_invite", network: state.network.slug,
  from_nick: from_nick, channel: channel, server_time: <iso>}`.
- Broadcast on `Topic.user(state.subject)` — mirror of
  `peer_away` and `invite_ack` precedents (operator may not be in
  the channel they're being invited TO, so per-channel routing
  drops on the floor — see P-0f lesson in
  `project_p0_numeric_delegation_closed`).
- ALSO persist `:notice` row on `$server` so the invite shows up in
  scrollback history (not only as an ephemeral). meta.kind:
  `"peer_invite"` so cic can render the [Join] CTA from the row.

### cic surface

- `cicchetto/src/lib/userTopic.ts` — dispatch arm for
  `peer_invite` wire event.
- Store: append to a (small, ring-buffer) `peerInvites` signal —
  surfaced as a transient toast/banner above the active window?
  OR rely on the persisted `$server` scrollback row + only the
  scrollback row gets the [Join] CTA?
  **Lean**: persisted row is enough — clicking [Join] is the
  user action, transient banner is noise. Keep the wire event
  for future "ping on invite" UX, but the bucket 2 cic surface
  is the scrollback-row [Join] button.
- `ScrollbackRow.tsx` — `kind === "notice" && meta.kind ===
  "peer_invite"` branch → render `<sender> invited you to <chan>
  [Join]` with the [Join] button calling existing `/join` flow
  via the same path as `compose.ts` `case "join"`.

### Files

- `lib/grappa/session/event_router.ex` — `:invite` command clause.
- `lib/grappa/session/server.ex` — `apply_effects` arm for
  `{:peer_invite, ...}`.
- `lib/grappa/session/wire.ex` — `peer_invite` wire builder.
- `cicchetto/src/lib/userTopic.ts` — dispatch.
- `cicchetto/src/lib/ScrollbackRow.tsx` — meta.kind=peer_invite
  render branch with [Join] button.
- `cicchetto/src/lib/wireNarrow.ts` — PeerInvite type.
- Tests:
  - event_router_test — `:invite` clause emits `{:peer_invite,
    from_nick, channel}`.
  - apply_effects integration test — `:peer_invite` effect
    persists `:notice` row + broadcasts on user topic.
  - vitest — userTopic dispatch + ScrollbackRow render branch.
  - Playwright e2e (mandatory per `feedback_ux_e2e_mandatory`):
    operator joins testnet, peer connects + INVITES operator,
    cic shows row, click [Join], verify channel open + JOIN
    sent upstream.

### Deploy

HOT-eligible (no struct fields — INVITE is single-shot, no
multi-numeric burst accumulator needed). Sequence as bucket 1.

## Bucket 3 — Bahamut numerics audit + structured forwarding matrix

### Method

Walk `/tmp/bahamut/include/numeric.h`. For every numeric defined,
classify into one of:

1. **Already delegated** (in `@delegated_numerics` with a dedicated
   EventRouter handler) — verify the wire event is typed (no
   localized strings in body). Document.
2. **Already active** (in `@active_numerics`) — routes to
   `{:server, nil}` and persists as bare `:notice`. Acceptable for
   error-class numerics where the trailing IS the structured
   user-facing message (e.g. 421 ERR_UNKNOWNCOMMAND). Document
   the decision.
3. **Param-derived route** (channel-prefix scan / nick-shaped
   scan / fallback to `$server`) — persists as bare `:notice`
   with body=trailing. Same disease as P-0a's WHOIS leak. Each
   one needs a decision: is the trailing already structured
   enough that cic can render? (Many MOTD-class numerics ARE
   the localized text — `375 :- server.example.com Message of
   the Day -`. There's no further structure to extract.)
   For these, rely on bucket 1's meta.raw default surface? No —
   numerics already get a row, no fallthrough involved. They
   stay bare-notice unless a deliberate handler is added.
4. **Never emitted by Bahamut** — futureproof — no action.

### Output

A markdown table appended to this plan as bucket-3 deliverable:

| Code | RFC name | Bahamut emits? | Current treatment | Target treatment | Action |
|---|---|---|---|---|---|

Walking `numeric.h` is mechanical; the `Action` column is the bucket-
3 work (likely small set). Each `Action ≠ none` gets a sub-commit
within bucket 3 (or split into 3a / 3b / 3c if many).

### Constraint

Per cluster scope, **no localization server-side**. Any new typed
event MUST emit typed primitives. If a numeric's payload is purely
human-readable (e.g. `375 RPL_MOTDSTART`), DO NOT add a typed event
for it — accept the bare-notice + cic-render-as-text shape (cic can
recognize the numeric from `meta.numeric` and apply MOTD styling).

### Deploy classification

Depends. If any new accumulator added (e.g. WATCH-class numerics
need a pending bundle), state-shape changes → `--force-cold` per
`feedback_deploy_sh_preflight_field_addition_gap`. Document at
bucket close.

### Audit matrix (2026-05-14)

Sources: `/tmp/bahamut/include/numeric.h` + `/tmp/bahamut/src/s_err.c`
(authoritative wire format strings — `replies[]` table) +
`lib/grappa/session/numeric_router.ex` `@delegated_numerics` /
`@active_numerics` + `lib/grappa/session/event_router.ex` numeric
clauses.

**Summary.** `numeric.h` defines ~110 unique numerics in the 1-799
range (header has duplicate macro blocks for separate sections;
collapsed). `s_err.c` `replies[]` shows ~95 with non-NULL format
strings, i.e. the set Bahamut can actually emit. The rest are
RFC reservations not used by this ircd.

Status counts after the matrix:

* **Already delegated with dedicated EventRouter handler:** 39 numerics
  (LUSERS 251-255/265-266, WHOIS family 275/301/307-319/325-326/339/378,
  WHOWAS 314/369/406, WHO/NAMES 315/352/353/366, LIST 321-323, channel
  state 324/329/331-333, INVITE 341, LINKS 364-365, MOTD 372/375-376,
  JOIN-fail 403/405/471/473-475).
* **Already in `@active_numerics` (forced `$server`):** 7 numerics
  (305, 306, 421, 432, 433, 437, 461).
* **Param-derived → bare-notice with NO `meta.numeric` upgrade
  (gap):** every other emitted numeric currently flows through
  `scan_params` and lands as a plain `:notice` row WITHOUT
  `meta.numeric` / `meta.severity`. cic can't recognise / style /
  filter them. **Action: ADD-DELEGATION (move to
  `@delegated_numerics`)** so Server's catch-all numeric persistence
  attaches `meta.numeric` + `meta.severity` per the post-CP30 path.
  This is the bulk of the cluster's silent-drop class for numerics —
  ~50 codes affected, mostly errors + STATS/TRACE admin output.
* **Carry STRUCTURED fields cic could render typed (gap warranting
  ADD-HANDLER):** 5 candidates — see top of matrix:
  - `221 RPL_UMODEIS` — current user modes string (`+iwx`).
  - `367 RPL_BANLIST` + `368 RPL_ENDOFBANLIST` — banmask/setter/setat
    rows; `/mode #ch +b` UI currently leaks setter/timestamp text.
  - `600-605 RPL_LOGON/LOGOFF/WATCHOFF/NOWON/NOWOFF` (WATCH bundle) —
    nick/user/host/timestamp tuple per entry; relevant once `/watch`
    is wired (see channel-client-polish watchlist scope).
  - `728 RPL_RESTRICTLIST` + `729` — channel +z restrict mask list,
    same shape as ban list.
  - `302 RPL_USERHOST` / `303 RPL_ISON` — space-separated tuples;
    irc-framework already parses these; folding into a typed event
    avoids each cic feature reparsing.
* **Defined-only / never emitted by Bahamut:** numeric.h declares
  ~15 codes that `s_err.c` leaves NULL (340 SHUNNED outside `#ifdef
  SHUN`, 229 STATSWEBIRC outside `#ifdef WEBIRC`, 250 STATSCONN
  outside `#ifdef HIGHEST_CONNECTION`, 247-248 reserved-for-Undernet,
  280-281, 354, 416, 513). DOCUMENT-AS-IS — no action.

The matrix collapses identical-analysis families into one row to
keep the audit readable. Where a family has heterogeneous handling
(e.g. WHOIS legs already-delegated + 316 WHOISCHANOP defined-only),
each leg gets its own row.

| Code(s) | RFC / Bahamut name | Bahamut emits? | Current treatment | Carries structured fields? | Target treatment | Action |
|---|---|---|---|---|---|---|
| 001-005 | RPL_WELCOME / YOURHOST / CREATED / MYINFO / ISUPPORT | YES | param-derived → `$server` (bare notice) | NO (server-text + ISUPPORT tokens — ISUPPORT already parsed by client lib) | catch-all + meta.numeric for styling | ADD-DELEGATION |
| 200-209 | RPL_TRACE* family | YES (operators only — rarely seen) | param-derived → `$server` | NO (admin text) | catch-all + meta.numeric | ADD-DELEGATION (en-bloc) |
| 211-219 | RPL_STATS* (CLINE/NLINE/ILINE/KLINE/QLINE/YLINE/COMMANDS/ENDOFSTATS) | YES (operators only) | param-derived → `$server` | NO (admin tabular text) | catch-all + meta.numeric | ADD-DELEGATION (en-bloc) |
| 221 | RPL_UMODEIS | YES | param-derived → `$server` (bare notice; mode flags leak as text) | YES — `params[1]` = mode-string `+iwx` | dedicated handler folding into `state.own_modes` + `:user_modes_changed` wire event (already needed for `/umode` UI) | **ADD-HANDLER** |
| 222-228, 250 | RPL_STATS extras (BLINE/ELINE/FLINE/ZLINE/COUNT/GLINE/SPAM/STATSCONN) | YES (oper) | param-derived → `$server` | NO (admin text) | catch-all + meta.numeric | ADD-DELEGATION (en-bloc) |
| 229 | RPL_STATSWEBIRC | NO (`#ifdef WEBIRC`) | n/a | n/a | n/a | DOCUMENT-AS-IS |
| 234, 235 | RPL_SERVLIST / RPL_SERVLISTEND | YES (rare — services listing) | param-derived → `$server` | NO (text) | catch-all + meta.numeric | ADD-DELEGATION |
| 241-246, 249 | RPL_STATS extras (LLINE/UPTIME/OLINE/HLINE/SLINE/ULINE/DEBUG) | YES (oper) | param-derived → `$server` | NO (admin text) | catch-all + meta.numeric | ADD-DELEGATION (en-bloc) |
| 247-248 | reserved for Undernet | NO | n/a | n/a | n/a | DOCUMENT-AS-IS |
| 251-255, 265-266 | RPL_LUSERCLIENT/OP/UNKNOWN/CHANNELS/ME + LOCALUSERS/GLOBALUSERS | YES | **delegated (EventRouter `lusers_bundle`)** | YES — already typed | unchanged | NONE |
| 256-259 | RPL_ADMINME/LOC1/LOC2/EMAIL | YES (`/admin`) | param-derived → `$server` | NO (text — admin contact info) | catch-all + meta.numeric | ADD-DELEGATION |
| 261-263 | RPL_TRACELOG / RPL_ENDOFTRACE / RPL_LOAD2HI | YES (oper / load reject) | param-derived → `$server` | NO (text) | catch-all + meta.numeric | ADD-DELEGATION |
| 271, 272 | RPL_SILELIST / RPL_ENDOFSILELIST | YES (`/silence`) | param-derived → `$server` (each entry as bare row) | YES — `params[2]` = silenced mask | catch-all + meta.numeric (`/silence` not in cluster-polish scope; defer typed handler) | ADD-DELEGATION |
| 275 | RPL_USINGSSL | YES (WHOIS leg) | **delegated (EventRouter — folds into whois_pending.using_ssl bool)** | YES — typed | unchanged | NONE |
| 301 | RPL_AWAY | YES (WHOIS leg + standalone PRIVMSG-target reply) | **delegated (EventRouter — whois_pending OR `peer_away` typed event)** | YES — typed (P-0b) | unchanged | NONE |
| 302 | RPL_USERHOST | YES (`/userhost`) | param-derived → `$server` | YES — trailing carries `nick=+host` tuples | catch-all + meta.numeric (no in-cluster consumer; ircframework parses) | ADD-DELEGATION |
| 303 | RPL_ISON | YES (`/ison`) | param-derived → `$server` | YES — trailing = space-separated nick list | catch-all + meta.numeric (no consumer; watchlist uses 600-series) | ADD-DELEGATION |
| 305, 306 | RPL_UNAWAY / RPL_NOWAWAY | YES | **active-list → `$server`** | NO (ack) | unchanged | NONE |
| 307-310 | RPL_WHOISREGNICK/ADMIN/SADMIN/HELPER | YES (WHOIS legs) | **delegated (folded into whois_pending typed flags)** | YES — typed | unchanged | NONE |
| 311-313 | RPL_WHOISUSER/SERVER/OPERATOR | YES | **delegated (whois_pending → whois_bundle)** | YES — typed | unchanged | NONE |
| 314 | RPL_WHOWASUSER | YES | **delegated (whowas_pending → whowas_bundle, P-0c)** | YES — typed | unchanged | NONE |
| 315 | RPL_ENDOFWHO | YES | **delegated (closes WHO bundle)** | YES — typed | unchanged | NONE |
| 316 | RPL_WHOISCHANOP | NO (`s_err.c` slot is NULL — RFC1459 reserved, never emitted by Bahamut) | delegated (defensive — header lists it) | n/a | unchanged (defensive entry is fine) | DOCUMENT-AS-IS |
| 317 | RPL_WHOISIDLE | YES | **delegated (whois_pending.idle_secs / signon_unix)** | YES — typed | unchanged | NONE |
| 318 | RPL_ENDOFWHOIS | YES | **delegated (closes WHOIS bundle, emits `whois_bundle`)** | YES — typed | unchanged | NONE |
| 319 | RPL_WHOISCHANNELS | YES | **delegated (whois_pending.channels — prefix-stripped)** | YES — typed | unchanged | NONE |
| 321-323 | RPL_LISTSTART / RPL_LIST / RPL_LISTEND | YES (`/list`) | **delegated (list_pending → list_window typed rows)** | YES — typed | unchanged | NONE |
| 324 | RPL_CHANNELMODEIS | YES (post-JOIN MODE echo) | **delegated (`channel_modes_changed`)** | YES — typed | unchanged | NONE |
| 325, 326 | RPL_WHOISAGENT / RPL_WHOISMODES | YES (Azzurra extensions) | **delegated (whois_pending typed flags)** | YES — typed | unchanged | NONE |
| 329 | RPL_CREATIONTIME | YES (post-JOIN) | **delegated (`channel_created` typed unix-ts)** | YES — typed | unchanged | NONE |
| 331-333 | RPL_NOTOPIC / RPL_TOPIC / RPL_TOPICWHOTIME | YES | **delegated (`topic_changed` typed)** | YES — typed | unchanged | NONE |
| 334 | RPL_COMMANDSYNTAX | YES (some Azzurra cmds reject) | param-derived → `$server` | NO (text) | catch-all + meta.numeric | ADD-DELEGATION |
| 339 | RPL_WHOISJAVA | YES (Azzurra) | **delegated (whois_pending.is_java bool)** | YES — typed | unchanged | NONE |
| 340 | RPL_SHUNNED | NO (`#ifdef SHUN`, default off) | param-derived | n/a | n/a | DOCUMENT-AS-IS |
| 341 | RPL_INVITING | YES | **delegated (`invite_ack` typed, P-0e/P-0f)** | YES — typed | unchanged | NONE |
| 342 | RPL_SUMMONING | YES (vestigial — SUMMON disabled in 445) | param-derived → `$server` | NO (text) | catch-all + meta.numeric | ADD-DELEGATION |
| 351 | RPL_VERSION | YES (`/version`) | param-derived → `$server` | YES — `version`, `server`, `comments` distinct fields | catch-all + meta.numeric (typed handler optional — no in-cluster consumer) | ADD-DELEGATION |
| 352, 353, 366 | RPL_WHOREPLY / RPL_NAMREPLY / RPL_ENDOFNAMES | YES | **delegated (WHO bundle / NAMES seeding)** | YES — typed | unchanged | NONE |
| 361-363 | RPL_KILLDONE / RPL_CLOSING / RPL_CLOSEEND | YES (oper) | param-derived → `$server` | NO (admin text) | catch-all + meta.numeric | ADD-DELEGATION |
| 364, 365 | RPL_LINKS / RPL_ENDOFLINKS | YES (`/links`) | **delegated (links_pending bundle)** | YES — typed | unchanged | NONE |
| 367, 368 | RPL_BANLIST / RPL_ENDOFBANLIST | YES (`/mode #ch +b`) | param-derived → `{:channel, ch}` (each entry leaks setter+ts as text in body) | YES — `params[2]=mask`, `params[3]=setter`, `params[4]=set_at_unix` | dedicated handler accumulating `banlist_pending[ch]` → emit `:banlist` typed wire event with `[%{mask, setter, set_at}]` | **ADD-HANDLER** |
| 369 | RPL_ENDOFWHOWAS | YES | **delegated (closes whowas_bundle, P-0c)** | YES — typed | unchanged | NONE |
| 371, 373, 374 | RPL_INFO / RPL_INFOSTART / RPL_ENDOFINFO | YES (`/info`) | param-derived → `$server` | NO (multi-line server-text) | catch-all + meta.numeric | ADD-DELEGATION |
| 372, 375, 376 | RPL_MOTD / RPL_MOTDSTART / RPL_ENDOFMOTD | YES | **delegated** | NO (text) | unchanged | NONE |
| 378 | RPL_WHOISACTUALLY | YES (oper-visible) | **delegated (whois_pending.actually)** | YES — typed | unchanged | NONE |
| 381, 382, 384, 385 | RPL_YOUREOPER / REHASHING / MYPORTIS / NOTOPERANYMORE | YES (oper) | param-derived → `$server` | NO (text + port int — no in-cluster consumer) | catch-all + meta.numeric | ADD-DELEGATION (en-bloc) |
| 391 | RPL_TIME | YES (`/time`) | param-derived → `$server` | YES — `params[1]=server`, trailing=human ts | catch-all + meta.numeric (no consumer) | ADD-DELEGATION |
| 392-395 | RPL_USERSSTART / RPL_USERS / RPL_ENDOFUSERS / RPL_NOUSERS | NO (Bahamut `s_err.c` NULL — RFC reserved, no emit) | n/a | n/a | n/a | DOCUMENT-AS-IS |
| 401 | ERR_NOSUCHNICK | YES | param-derived → `{:query, nick}` if param looks nick-shaped | NO (text "No such nick/channel") | catch-all + meta.numeric (cic can render in-target window with severity:error) | ADD-DELEGATION |
| 402 | ERR_NOSUCHSERVER | YES | param-derived → `$server` | NO (text) | catch-all + meta.numeric | ADD-DELEGATION |
| 403 | ERR_NOSUCHCHANNEL | YES | **delegated (CP15 JOIN-fail bundle)** | YES — typed | unchanged | NONE |
| 404 | ERR_CANNOTSENDTOCHAN | YES | param-derived → `{:channel, ch}` | NO (text — but the FACT of failure is structured) | catch-all + meta.numeric (cic shows in-channel red row) | ADD-DELEGATION |
| 405 | ERR_TOOMANYCHANNELS | YES | **delegated (JOIN-fail bundle)** | YES — typed | unchanged | NONE |
| 406 | ERR_WASNOSUCHNICK | YES (WHOWAS-leg) | **delegated (whowas_bundle, P-0c)** | YES — typed | unchanged | NONE |
| 407, 408 | ERR_TOOMANYTARGETS / ERR_NOCOLORSONCHAN | YES | param-derived → `$server` / `{:channel, ch}` | NO (text) | catch-all + meta.numeric | ADD-DELEGATION |
| 409 | ERR_NOORIGIN | YES (PING-no-origin) | param-derived → `$server` | NO (text) | catch-all + meta.numeric | ADD-DELEGATION |
| 411-414 | ERR_NORECIPIENT / NOTEXTTOSEND / NOTOPLEVEL / WILDTOPLEVEL | YES | param-derived → `$server` | NO (text) | catch-all + meta.numeric | ADD-DELEGATION (en-bloc) |
| 421 | ERR_UNKNOWNCOMMAND | YES | **active-list → `$server`** | NO (text) | unchanged | NONE |
| 422-424 | ERR_NOMOTD / NOADMININFO / FILEERROR | YES | param-derived → `$server` | NO (text) | catch-all + meta.numeric | ADD-DELEGATION |
| 429 | ERR_TOOMANYAWAY | YES (away-flood) | param-derived → `$server` | NO (text) | catch-all + meta.numeric | ADD-DELEGATION |
| 431 | ERR_NONICKNAMEGIVEN | YES | param-derived → `$server` | NO (text) | catch-all + meta.numeric | ADD-DELEGATION |
| 432, 433 | ERR_ERRONEUSNICKNAME / ERR_NICKNAMEINUSE | YES | **active-list → `$server`** | NO (handled at /nick boundary) | unchanged | NONE |
| 435 | ERR_BANONCHAN | YES (nick-change-while-banned-on-channel) | param-derived → `{:channel, ch}` | YES (could fold into `nick_change_failed` typed) — but no in-cluster consumer | catch-all + meta.numeric | ADD-DELEGATION |
| 436 | ERR_NICKCOLLISION | YES (server-side — usually doesn't reach client) | param-derived → `$server` | NO (text) | catch-all + meta.numeric | ADD-DELEGATION |
| 437 | ERR_BANNICKCHANGE / UNAVAILRESOURCE | YES | **active-list → `$server`** | NO (handled at /nick) | unchanged | NONE |
| 438, 439 | ERR_NONICKCHANGE / ERR_TARGETTOOFAST | YES | param-derived → `$server` | NO (text) | catch-all + meta.numeric | ADD-DELEGATION |
| 440 | ERR_SERVICESDOWN | YES (NickServ/ChanServ unreachable) | param-derived → `$server` | NO (text) | catch-all + meta.numeric | ADD-DELEGATION |
| 441-447 | ERR_USERNOTINCHANNEL / NOTONCHANNEL / USERONCHANNEL / NOLOGIN / SUMMONDISABLED / USERSDISABLED / RESTRICTED | YES | param-derived (channel-shaped → `{:channel, ch}`; nick-shaped → `{:query, nick}`; else `$server`) | NO (text) | catch-all + meta.numeric | ADD-DELEGATION (en-bloc) |
| 451 | ERR_NOTREGISTERED | YES (boot-time) | param-derived → `$server` | NO (text) | catch-all + meta.numeric | ADD-DELEGATION |
| 461 | ERR_NEEDMOREPARAMS | YES | **active-list → `$server`** | NO (text — handled at command boundary) | unchanged | NONE |
| 462-468 | ERR_ALREADYREGISTRED / NOPERMFORHOST / PASSWDMISMATCH / YOUREBANNEDCREEP / YOUWILLBEBANNED / KEYSET / ONLYSERVERSCANCHANGE | YES | param-derived → `$server` (or `{:channel, ch}` for 467) | NO (text) | catch-all + meta.numeric | ADD-DELEGATION (en-bloc) |
| 471, 473, 474, 475 | ERR_CHANNELISFULL / INVITEONLYCHAN / BANNEDFROMCHAN / BADCHANNELKEY | YES | **delegated (CP15 JOIN-fail bundle)** | YES — typed | unchanged | NONE |
| 472 | ERR_UNKNOWNMODE | YES | param-derived → `$server` | NO (text + the unknown mode char) | catch-all + meta.numeric | ADD-DELEGATION |
| 476-479 | ERR_ONLYSSLCLIENTS / NEEDREGGEDNICK / BANLISTFULL / BADCHANNAME | YES | param-derived (mostly `{:channel, ch}`) | NO (text — but JOIN-fail-ish) | catch-all + meta.numeric (consider folding into CP15 JOIN-fail bundle in a future cluster — out of scope here) | ADD-DELEGATION |
| 481-489, 491 | oper / kick-services / kill-services / non-reg / ban-reason / msg-services family | YES | param-derived → `$server` or `{:channel, ch}` | NO (text) | catch-all + meta.numeric | ADD-DELEGATION (en-bloc) |
| 501, 502 | ERR_UMODEUNKNOWNFLAG / ERR_USERSDONTMATCH | YES | param-derived → `$server` | NO (text) | catch-all + meta.numeric | ADD-DELEGATION |
| 503 | ERR_GHOSTEDCLIENT (Bahamut: undelivered-msg) | YES | param-derived → `$server` | NO (text) | catch-all + meta.numeric | ADD-DELEGATION |
| 511 | ERR_SILELISTFULL | YES (`/silence` cap) | param-derived → `$server` | NO (text) | catch-all + meta.numeric | ADD-DELEGATION |
| 512 | ERR_TOOMANYWATCH | YES (`/watch` cap) | param-derived → `$server` | NO (text — but `/watch` work in channel-client-polish will want to surface this) | catch-all + meta.numeric (sufficient for cap-warning UI) | ADD-DELEGATION |
| 513 | reserved for Undernet | NO | n/a | n/a | n/a | DOCUMENT-AS-IS |
| 514 | ERR_TOOMANYDCC | YES | param-derived → `$server` | NO (text) | catch-all + meta.numeric | ADD-DELEGATION |
| 521-523 | ERR_LISTSYNTAX / WHOSYNTAX / WHOLIMEXCEED | YES | param-derived → `$server` | NO (text) | catch-all + meta.numeric | ADD-DELEGATION |
| 600-605 | RPL_LOGON / LOGOFF / WATCHOFF / NOWON / NOWOFF | YES (WATCH replies) | param-derived → `$server` (each entry leaks as bare text including unix-ts integer) | YES — `nick`, `user`, `host`, `unix_ts`, kind discriminator from numeric | dedicated handler emitting typed `:watch_event` `%{kind: :logon \| :logoff \| :now_on \| :now_off \| :watch_off, nick, user, host, ts}` (depended-on by channel-client-polish `/watch` work) | **ADD-HANDLER** |
| 603 | RPL_WATCHSTAT | YES | param-derived → `$server` | YES — `params[1]=local_count`, `params[2]=remote_count` (currently leaks as English text) | dedicated handler emitting `:watch_stats` `%{local, remote}` | **ADD-HANDLER** (companion to 600-605) |
| 606, 607 | RPL_WATCHLIST / RPL_ENDOFWATCHLIST | YES | param-derived → `$server` | YES — list of nicks | dedicated handler emitting `:watch_list` typed bundle (companion to 600-605 above) | **ADD-HANDLER** (en-bloc with 600-series) |
| 617-620 | RPL_DCCSTATUS / DCCLIST / ENDOFDCCLIST / DCCINFO | YES (DCCALLOW) | param-derived → `$server` | NO (text — DCC out of cluster scope) | catch-all + meta.numeric | ADD-DELEGATION |
| 630 | ERR_NOCTCPSTOCHAN | YES | param-derived → `{:channel, ch}` | NO (text) | catch-all + meta.numeric | ADD-DELEGATION |
| 728, 729 | RPL_RESTRICTLIST / RPL_ENDOFRESTRICTLIST | YES (`/mode #ch +z` list) | param-derived → `{:channel, ch}` (each entry leaks setter+ts as text) | YES — same shape as banlist (mask, setter, set_at) | catch-all + meta.numeric (typed handler depends on whether `/mode +z` UI is in-scope — defer; 367/368 banlist is the proven shape) | ADD-DELEGATION |

### Notes — bucket-3 SCOPE FINDING (2026-05-14)

**Mechanical scope: ZERO.** The audit's initial "ADD-DELEGATION"
recommendation is INVERTED relative to the current code shape.

In this codebase `@delegated_numerics` means "EventRouter clause
owns persistence; `Session.Server`'s numeric handler SKIPS the
catch-all persist for this code." Numerics NOT in
`@delegated_numerics` flow into the param-derived branch, which at
`server.ex:1530` already attaches `meta = %{numeric: code, severity:
NumericRouter.severity(code)}` to the persisted `:notice` row.

So a numeric like RPL_ADMINME (256) is already persisted on
`$server` with `meta.numeric=256, meta.severity=:ok` — exactly the
shape cic needs. Moving it INTO `@delegated_numerics` (without an
EventRouter clause) would route it through `delegate/2` →
EventRouter's command-verb numeric-skip clause (added in B2 to
prevent the double-write) → `[]` effects → SILENT DROP. The
opposite of what the matrix wanted.

**The catch-all path is the right shape for "carries no structured
fields beyond text + numeric code."** No code change needed for the
~50 "ADD-DELEGATION" candidates. They already work.

**What B3 actually closes:**

1. The full mechanical audit matrix above (this section) — proof
   that every emitted Bahamut numeric has a known disposition.
2. Documentation of the 5 `ADD-HANDLER` candidates for future
   buckets (UMODEIS, banlist 367/368, WATCH 600-607). Each pairs
   with a polish-cluster scope item that doesn't yet exist.
3. Verification of the catch-all → `meta.numeric/severity` shape
   for every non-delegated numeric (no code change needed; tested
   by existing `event_router_test` + `server_test` coverage).

**ADD-HANDLER deferred work (filed for future polish clusters):**

- **221 RPL_UMODEIS** — small, isolated; pairs with `/umode` UI
  polish. Estimated: 1 commit (state-shape change → cold-deploy).
- **367/368 RPL_BANLIST/RPL_ENDOFBANLIST** — pairs with `/banlist`
  polish (already on the channel-client-polish list). Estimated:
  2-3 commits.
- **600-607 WATCH bundle** (LOGON/LOGOFF/WATCHOFF/NOWON/NOWOFF +
  WATCHSTAT + WATCHLIST/ENDOFWATCHLIST) — pairs with watchlist
  polish (also on channel-client-polish). Largest payload, most-
  leaked text (unix-ts integers). Estimated: 4-5 commits.

These three together are a small ADD-HANDLER cluster (~1 day) that
should ship after the no-silent-drops cluster closes; they're NOT
in the no-silent-drops scope per CLAUDE.md "don't overengineer" +
P-0's explicit "wider audit is its own future cluster" precedent.

**Defined-only / `#ifdef`-gated** (DOCUMENT-AS-IS, no action):

- 229 RPL_STATSWEBIRC (`#ifdef WEBIRC`)
- 247-248, 513 (Undernet reservations)
- 250 RPL_STATSCONN (varies)
- 316 RPL_WHOISCHANOP (RFC1459 reserved, never emitted by Bahamut)
- 340 RPL_SHUNNED (`#ifdef SHUN`)
- 354, 416 (other-vendor reservations)
- 392-395 USERS family (Bahamut `s_err.c` NULL — disabled)

The defensive `@delegated_numerics` entries for these (e.g. 316)
are fine to keep — they cost nothing and document that the slot is
known-handled if Bahamut ever flips the gate.

### Conclusion

**B3 ships as plan + matrix update, NO code change.** The audit
proved the catch-all path is already the right shape. The
ADD-HANDLER work goes into the post-cluster polish queue (filed in
`project_post_p4_1_arc` memory at cluster close).

### B3 latent-bug finding (2026-05-14)

While verifying the audit's "ADD-DELEGATION" recommendations (and
discovering they're inverted — see SCOPE FINDING above), surfaced a
**pre-existing latent bug**:

- `@delegated_numerics` lists 321 RPL_LISTSTART, 322 RPL_LIST, 323
  RPL_LISTEND, 364 RPL_LINKS, 365 RPL_ENDOFLINKS as "delegated to
  EventRouter" (per `numeric_router.ex` doc comment line 19-20).
- EventRouter has NO clauses for these codes (only MOTD's guarded
  clause on `[375, 372, 376]` matches a similar shape).
- Pre-B2, EventRouter's command-verb catch-all returned `[]` for
  these — silent drop.
- Post-B2, the explicit numeric-skip clause returns `[]` for these
  — same silent drop, just routed through a different pattern.

**Why it doesn't surface in practice**: `/list` and `/links` are
operator-issued slash commands. cic's `/list` handler currently
returns the stub error
"server-side not yet implemented" (`compose.test.ts:1061`); the
operator never issues `/list` upstream, so the LIST numerics never
arrive. Same for `/links`. The latent silent-drop only fires if a
future feature wires `/list` upstream WITHOUT also adding the
EventRouter clauses to consume 321/322/323.

**Disposition**: file as a known-latent bug for the future polish
cluster that wires `/list` and `/links` UI. NOT in
no-silent-drops scope (the cluster's principle is "every
INBOUND-from-upstream byte is visible" — these numerics are never
inbound today). Either:

1. Remove 321-323 + 364-365 from `@delegated_numerics` so the
   catch-all path attaches `meta.numeric/severity` (defensive — even
   if the cic `/list` lands without EventRouter clauses, the rows
   appear on `$server`).
2. Add EventRouter clauses now (overengineering for a feature that
   doesn't exist yet).
3. Leave as-is + document (accept the latent bug as a "land both
   together" trip-wire for the future polish cluster).

**Going with (3)** — minimum surface, documented disposition.
The future `/list` UI cluster MUST land EventRouter clauses for
321/322/323 in the same commit as the cic surface, or the rows
silently drop. Pinned by this doc + a TODO in
`numeric_router.ex` (added in this commit).

## Bucket 4 — Clickable links in scrollback

### Scope

Every URL in PRIVMSG / NOTICE / ACTION body becomes
`<a href="..." target="_blank" rel="noopener noreferrer">`.
cic-side only — server stays string-based for body. Hover preview
+ inline image overlay are OUT OF SCOPE per vjt 2026-05-14
("open in new window for now"); image-upload cluster (parked) will
revisit.

### URL detection

Vendor a tiny pure-JS linkifier in `cicchetto/src/lib/linkify.ts`
— ~30 lines covering:

- `https?://...` (most common)
- `ftp://...`
- `www.<domain>` (bare-domain, prepend `https://` on click)

Avoid pulling `linkify-it` as a dep — it's >10kB minified for one
regex.

### Render

`ScrollbackRow.tsx` body renderer walks the body string with the
linkifier's tokenizer, emitting a `<For>` over `[{type: "text",
value: ...} | {type: "url", href: ..., display: ...}]` segments.

### Files

- `cicchetto/src/lib/linkify.ts` (new) — tokenizer + tests.
- `cicchetto/src/__tests__/linkify.test.ts` — vitest pinning the
  regex on positive (http/https/ftp/www-bare) and negative
  (`(parens)`, trailing-`.`/`,`/`)` exclusion, IDN punycode pass-
  through) cases.
- `cicchetto/src/lib/ScrollbackRow.tsx` — body renderer integrates
  linkify.
- Playwright e2e — post a message with `https://example.com` in
  `#bofh`, assert the `<a>` element with correct href + `target`
  + `rel` attrs.

### Deploy

cic-only (`scripts/deploy-cic.sh`). No server changes.

## Bucket 5 — Codebase review (parallel agents per `/review`)

### Reshape note (vjt 2026-05-14)

Original B5 was Sobelow hardening. Reshape moves Sobelow to B6 and
makes B5 a full codebase review using `docs/reviewing.md` /
`/review` skill — parallel agents covering code quality,
architecture, security, test discipline, etc.

### Output

Prioritized findings list:
- **CRIT** — must fix before B6 close (security, correctness, data
  loss)
- **HIGH** — should fix in B6 (architecture violations, hot bugs)
- **IMPORTANT-MED** — fold-in candidates for B6
- **LOW / NICE-TO-HAVE** — defer to a future review-fold cluster

### Files

- `docs/reviews/codebase/2026-05-14-no-silent-drops.md` — review
  output (findings + dispositions).

### Deploy

None — review is read-only. The remediation lands in B6.

## Bucket 6 — Sobelow + review fold-in

### Scope

Two surfaces in one bucket:

1. **Sobelow hardening** (the original B5 work). Walk all
   `# sobelow_skip` annotations in `lib/`. For each:
   - **True positive** (real risk) — document the WHY in the skip
     comment + open a follow-up bucket entry to actually fix.
   - **False positive** — promote to `# sobelow_reviewed` with
     one-line WHY.
   - **Stale** (Sobelow has since stopped flagging) — remove the
     annotation entirely.

   Tighten the prod gate in `mix.exs` / CI:
   - Drop `--skip` flags where possible.
   - Gate at LOW severity instead of MEDIUM.

2. **B5 review fold-in**. Remediate every B5 finding classified
   CRIT, HIGH, or IMPORTANT-MED. LOW / NICE-TO-HAVE deferred to
   their own future cluster (vjt 2026-05-14).

### Files

- `lib/**/*.ex` — Sobelow annotation edits + B5-finding remediations.
- `mix.exs` (`ci.check` alias) — Sobelow flag tightening.
- `.github/workflows/ci.yml` (if Sobelow runs there separately).
- Plus whatever surface B5 review flagged.

### Deploy

HOT-eligible if the fold-in doesn't introduce struct-field changes;
manual `--force-cold` if it does (per
`feedback_deploy_sh_preflight_field_addition_gap`).

## Cluster close checklist

Per orchestrator brief, after bucket 6 green:

1. `cd .worktrees/no-silent-drops && git fetch origin main && git rebase origin/main`.
2. Re-run all gates after rebase.
3. Brief vjt with cluster summary.
4. ff-merge to main.
5. Deploy at highest-watermark classification (likely cold if
   bucket 3 added struct fields).
6. Healthcheck + browser smoke per `feedback_per_bucket_deploy`.
7. `git push origin main` per `feedback_push_autonomy`.
8. Update memory `project_post_p4_1_arc` — mark cluster CLOSED;
   add `project_no_silent_drops_closed` archival memory.
9. CP31 checkpoint at `docs/checkpoints/2026-05-XX-cp31.md`.
10. DESIGN_NOTES + README + project-story.md updates per
    `feedback_readme_currency` (README already updated in-step at
    bucket 0/1; sweep for late-bucket additions).
11. Worktree cleanup or park.
