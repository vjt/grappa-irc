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
| 0 | `compose.ts` requireChannel | trivial cic | cic-only | rolls forward the carried-over P-0 fix; `/invite foo #chan` from $server |
| 1 | EventRouter fallthrough → structured :notice | medium | HOT | meta.raw shape; cic ScrollbackRow gains meta.raw branch |
| 2 | Inbound INVITE handler | small | HOT | typed `peer_invite` wire event on Topic.user/1; cic [Join] CTA |
| 3 | Bahamut numerics audit + matrix | medium | likely COLD | every numeric: dedicated handler OR delegated structured notice |
| 4 | Clickable URLs in scrollback | small | cic-only | linkify body; new tab; defer hover/image |
| 5 | Sobelow hardening (Phase 5 P-1) | small | HOT | `# sobelow_skip` audit + tighten prod gate |

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
- **Hot-vs-cold deploy**: bucket 3 may add struct fields → manual
  `--force-cold` per
  `feedback_deploy_sh_preflight_field_addition_gap`. Buckets 1/2/4/5
  + bucket 0 are HOT (or cic-only).

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

### Fix shape

Replace the fallthrough with a structured persist:

```elixir
def route(%Message{command: command} = msg, state) do
  sender = Message.sender_nick(msg) || Message.prefix(msg) || ""
  meta = %{
    raw: %{
      verb: command_to_verb_string(command),
      sender: sender,
      params: msg.params
    }
  }
  {state, eff} =
    build_persist(state, :notice, "$server", sender, nil, meta)
  {:cont, state, [eff]}
end
```

Where `command_to_verb_string/1`:

- `:atom` (parsed-known like `:privmsg`) → uppercased atom string
  ("PRIVMSG"). Unreached in practice — known verbs hit dedicated
  clauses above. Belt-and-braces fallback.
- `binary` (parser preserves unknown verbs as raw bytes-uppercased
  per IRC convention) → as-is.
- `{:numeric, n}` → unreachable (numerics never reach EventRouter
  fallthrough — they hit the numeric clauses or NumericRouter).
  Belt-and-braces: `"#{n}"`.

### `meta.raw` shape

```elixir
%{
  raw: %{
    verb: String.t(),       # uppercased command verb
    sender: String.t(),     # nick prefix or full prefix or ""
    params: [String.t()]    # raw parsed params, last = trailing
  }
}
```

Wire serialization is automatic — `Scrollback.Wire` already passes
`meta` through (`lib/grappa/scrollback/wire.ex:90`).

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

## Bucket 5 — Sobelow hardening (Phase 5 P-1)

### Scope

Walk all `# sobelow_skip` annotations in `lib/`. For each:

- **True positive** (real risk) — document the WHY in the skip
  comment + open a follow-up bucket entry to actually fix.
- **False positive** — promote to `# sobelow_reviewed` with
  one-line WHY.
- **Stale** (Sobelow has since stopped flagging) — remove the
  annotation entirely.

Tighten the prod gate in `mix.exs` / CI:

- Drop `--skip` flags where possible.
- Gate at LOW severity instead of MEDIUM.

### Files

- `lib/**/*.ex` — annotation edits per the audit.
- `mix.exs` (`ci.check` alias) — Sobelow flag tightening.
- `.github/workflows/ci.yml` (if Sobelow runs there separately).

### Deploy

HOT-eligible (no runtime impact — pure CI/static-analysis).

## Cluster close checklist

Per orchestrator brief, after bucket 5 green:

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
    `feedback_readme_currency`.
11. Worktree cleanup or park.
