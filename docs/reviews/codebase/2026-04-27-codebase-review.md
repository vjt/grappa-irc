---
date: 2026-04-27
type: codebase
session: CP10
scope: full repo (server + cicchetto)
agents: 6 (irc/, persistence/, lifecycle/, web/, cicchetto/, cross-module+infra)
---

# Codebase review — 2026-04-27 (CP10)

First post-Phase-3 review run with the extended skill that covers
`cicchetto/` + cross-cutting compose/nginx/cicchetto-tooling concerns
(skill update landed CP09 S4). Review reset the 12-session/2-week
codebase-review cadence clock.

## Summary

| Scope             | CRIT | HIGH | MED | LOW | Total |
|-------------------|:----:|:----:|:---:|:---:|:-----:|
| irc/              |  0   |  1   |  2  |  7  |  10   |
| persistence/      |  0   |  0   |  1  |  5  |   6   |
| lifecycle/        |  0   |  0   |  6  |  4  |  10   |
| web/              |  0   |  0   |  1  |  8  |   9   |
| cicchetto/        |  0   |  3   |  5  |  7  |  15   |
| cross-module/infra|  0   |  0   |  2  |  3  |   5   |
| **Total**         |  0   |  4   | 17  | 34  | **55** |

(One dedupe applied: cross-module S3 ≡ lifecycle S3 — Bootstrap
`user: <UUID>` log-key drift; counted once under lifecycle.)

### Top of the stack — the four HIGH findings

1. **irc/ S1** — `IRC.Client.init/1` does blocking TCP+TLS+handshake
   synchronously with `:infinity` connect timeout. A single hung
   upstream serializes Bootstrap and freezes the supervisor.
2. **cicchetto/ S1** — Service Worker `CACHE = "cicchetto-shell-v1"`
   is hardcoded and never bumps. Combined with byte-identical `sw.js`
   across deploys, the SW never re-installs and the cached shell is
   pinned forever to the first-install Vite hash.
3. **cicchetto/ S2** — SW shell-cache references hashed `/assets/*`
   that are NOT cached. After any deploy that bumps asset hashes,
   the cached `/` references dead asset paths; offline users get a
   broken shell, online users get a CSP-mismatched dynamic load.
4. **cicchetto/ S3** — `MessageKind` union (`"privmsg" | "notice" |
   "action"`) is 3-of-10 narrower than the server's
   `Grappa.Scrollback.Message.kind()` enum. Phase 5+ presence-event
   capture will silently render JOIN/PART/etc. with PRIVMSG framing.

The first three are operator-impact; the SW pair is the showstopper
for the next time `cicchetto/dist` ships with bumped asset hashes.
The fourth is a Phase 5 land-mine that should land NOW because the
type is the contract.

---

## HIGH

### S1. `IRC.Client.init/1` performs blocking socket connect synchronously
**Module:** irc | **File:** `lib/grappa/irc/client.ex:254-283`
**Category:** OTP / supervision
`do_init/1` calls `:gen_tcp.connect/3` (no timeout — defaults to
`:infinity`) and `:ssl.connect/3` directly inside `init/1`, then
drives a synchronous handshake (PASS, CAP LS, NICK, USER) before
returning. CLAUDE.md OTP rule explicitly calls out "blocking work in
`init/1` without `{:continue, _}`." A flapping upstream freezes the
parent `Session.Server` start and cascades to the
`DynamicSupervisor`. The `:gen_tcp.connect/3` call has no `:timeout`
either — a black-holed packet deadlocks `init/1` forever, the parent
Session never returns from `start_session/3`, and `Bootstrap` hangs.
**Fix:** Return `{:ok, state, {:continue, :connect}}` from `init/1`,
move `do_connect` + `perform_initial_handshake` into
`handle_continue/2`. Add an explicit `:timeout` (e.g. 30_000ms) to
both `:gen_tcp.connect/3` and `:ssl.connect/3` calls.

### S2. SW cache version is hardcoded and never bumps on deploy
**Module:** cicchetto | **File:** `cicchetto/public/sw.js:8`
**Category:** PWA / cache invalidation
`CACHE = "cicchetto-shell-v1"` is a static literal. The activate
filter `keys.filter((k) => k !== CACHE).map((k) => caches.delete(k))`
only deletes caches whose name DIFFERS from current — since the name
never changes, the cache is never purged. Combined with `sw.js`
itself being byte-identical across deploys, the browser sees no SW
update, install never re-runs, and the cached `/` (index.html) stays
pinned to the Vite hash from first install. Operators get a
perma-stale shell after any deploy following any user's first visit.
**Fix:** Inject the build version into both `CACHE` and a comment
(Vite `define: { __APP_VERSION__: ... }` or build-manifest hash) so
the SW byte content changes per deploy. Or version the SW filename
(`/sw-<hash>.js`) and rotate the manifest/registration.

### S3. SW shell cache references hashed `/assets/*` but does not cache them
**Module:** cicchetto | **File:** `cicchetto/public/sw.js:9`
**Category:** PWA / cache correctness
`SHELL = ["/", "/index.html", "/manifest.json"]` caches the entry
HTML but Vite's build emits hashed `/assets/index-<hash>.js`
references inside that HTML. The fetch handler is cache-first only
against pre-cached entries, so asset GETs always hit network. After
a deploy bumps asset hashes, the cached `/` references the OLD
hashed paths; offline visits return cached shell + 404 on assets,
online visits fetch new assets that may not match the cached HTML's
CSP-nonce / module-integrity expectations.
**Fix:** Either pre-cache the asset manifest (vite-plugin-pwa /
Workbox precache injection), or remove `/` and `/index.html` from
SHELL and serve the shell network-first with a fallback so the
cached HTML can never reference dead asset hashes.

### S4. `MessageKind` union is narrower than server `Message.kind()`
**Module:** cicchetto | **File:** `cicchetto/src/lib/api.ts:51`
**Category:** wire-shape drift
Client declares `MessageKind = "privmsg" | "notice" | "action"`.
Server schema (`lib/grappa/scrollback/message.ex:87-98`) defines ten
kinds: `:privmsg | :notice | :action | :join | :part | :quit |
:nick_change | :mode | :topic | :kick`, all reachable via
`Wire.to_json/1` once Phase 5 presence-event capture begins emitting
them. CLAUDE.md "MessageKind is canonical case" + wire-shape
source-of-truth rule put this in scope. With the current narrow
type, `kind === "join"` payloads narrow to `never` in switches and
`ScrollbackLine`'s implicit fallback renders JOIN/PART/etc. with
PRIVMSG framing.
**Fix:** Mirror all ten kinds in `MessageKind`. Update
`ScrollbackLine` to handle the additional variants (or render an
explicit "unknown kind" fallthrough). See also S20 below — the
renderer needs an `assertNever` to keep the union and the switch in
lockstep.

---

## MEDIUM

### S5. `IRC.Client.send_pong/2` spec says `:ok | {:error, :invalid_line}`, caller crashes on `:invalid_line`
**Module:** irc | **File:** `lib/grappa/irc/client.ex:221-226` + `lib/grappa/session/server.ex:248`
**Category:** Untyped / contract drift
Caller `:ok = Client.send_pong(state.client, token)` will crash the
Session GenServer with `MatchError` on any malformed PING token (a
hostile/buggy upstream sending `PING :tok\r\nNICK pwn` would
disconnect every session). Either the contract is wrong (PONG token
came from upstream parser, which strips CR/LF, so `safe_line_token?`
is unreachable defense), or the caller is wrong.
**Fix:** Drop the guard from `send_pong/2` since the token
originated server-side from the parsed PING (parser already strips
CR/LF), reducing the spec to `:ok`; OR have the Session handle
`{:error, :invalid_line}` by logging + dropping. Pick one and align
contract + caller.

### S6. CAP LS continuation `state.caps_buffer` can be left non-empty on phase escape
**Module:** irc | **File:** `lib/grappa/irc/client.ex:433-441, 487-495`
**Category:** State machine / GenServer state
Lines 433-435 accumulate `caps_buffer` while phase is
`:awaiting_cap_ls`. `cap_unavailable/1` resets phase via
`maybe_send_cap_end/1` but never clears `caps_buffer`; the `001`
registered transition has the same gap. Today nothing re-enters
`:awaiting_cap_ls`, but Phase 5 reconnect-with-backoff will, and the
residue corrupts the next negotiation.
**Fix:** Clear `caps_buffer: []` in `maybe_send_cap_end/1` and on
the `001` registered transition. Make "leaving CAP negotiation" a
single function that owns both fields.

### S7. Public `Scrollback.insert/1` violates the moduledoc's "callers never `Repo.insert/2`" invariant
**Module:** persistence | **File:** `lib/grappa/scrollback.ex:83-88`
**Category:** leaky abstraction / API surface
The moduledoc declares: "Internal schema (`Grappa.Scrollback.Message`)
stays encapsulated; callers never `Repo.insert/2` directly." Yet
`insert/1` is exposed publicly with `@spec insert(map())` accepting
any map and is consumed only by tests (zero production callers — `lib/`
only uses `persist_privmsg/5`, `fetch/5`,
`has_messages_for_network?/1`). This is the same anti-pattern
CLAUDE.md flags: "Never weaken production code to make tests pass."
**Fix:** Move the test-only "insert any kind" path into a
`Grappa.ScrollbackFactory` (ExMachina is in the toolbox) or
`test/support/scrollback_helpers.ex` that calls `Message.changeset/2
|> Repo.insert()` directly, then drop `Scrollback.insert/1` from the
public surface.

### S8. `Release.ex` reads runtime config outside `application.ex`
**Module:** lifecycle | **File:** `lib/grappa/release.ex:49`
**Category:** Application.get_env discipline
`defp repos, do: Application.fetch_env!(@app, :ecto_repos)` violates
CLAUDE.md: "No `Application.get_env/2` outside `config/` and
`lib/grappa/application.ex` (the documented exception)." Release
tasks run pre-supervision, but the rule is absolute.
**Fix:** Either (a) extend the CLAUDE.md exception list to include
`lib/grappa/release.ex` with a one-line justification, OR (b) hardcode
`[Grappa.Repo]` (single shared Repo per `Grappa.Repo`'s moduledoc —
no per-user dynamic Repo, so iteration over `:ecto_repos` is dead
generality).

### S9. `Log.ex` moduledoc claims `network=<network_id>` but code emits `network=<network_slug>`
**Module:** lifecycle | **File:** `lib/grappa/log.ex:16`
**Category:** Stale pattern contradicting code
The moduledoc declares the canonical session context as `user=<user_name>
network=<network_id>`, but `Session.Server.init/1` calls
`Log.set_session_context(opts.user_name, opts.network_slug)` —
emitting `network=<network_slug>` (e.g. `azzurra`), not the integer
FK. An operator grepping logs by the doc's contract would search for
`network=42` and find nothing.
**Fix:** Update the moduledoc to `network=<network_slug>` (matching
reality) and rename the `session_context/2` parameter from `network`
to `network_slug`.

### S10. Bootstrap logs `user: <UUID>` while every other site uses `user: <user_name>`
**Module:** lifecycle | **File:** `lib/grappa/bootstrap.ex:126,140,144` (also flagged by cross-module agent)
**Category:** Logger metadata key abuse / semantic drift
Bootstrap logs `user: user_id, network: slug` where `user_id` is
`Ecto.UUID.t()`. Everywhere else (`Session.Server.init/1`, `Log`'s
documented contract) `:user` is the human-readable `user_name`. Two
producers writing different value types into the same allowlisted key
— operators correlating log lines by `user=` get a UUID from boot
logs and a name from session logs, can't grep across them. Per
CLAUDE.md "Total consistency or nothing — half-typed is worse than
untyped."
**Fix:** `Networks.list_credentials_for_all_users/0` already preloads
`:network`; preload `:user` too (or thread `user_name` into the
`Credential` pattern match in `spawn_one/2`) and emit `user: user.name`
matching the Server's contract. Same for the bootstrap-summary line.

### S11. `init_opts()` and `start_opts()` are parallel type definitions hand-mirrored
**Module:** lifecycle | **File:** `lib/grappa/session/server.ex:94-108` (vs `lib/grappa/session.ex:80-92`)
**Category:** Untyped/weakly-typed via duplication
`Server.init_opts()` is `Session.start_opts()` plus two ID keys, but
the two types are independent literal maps. Adding a field requires
editing both — and the moduledoc on `start_opts` already warns that
`session_plan/1`'s `build_plan/4` AND the Server state struct must
move in lockstep. CLAUDE.md design discipline (1) "Don't duplicate
state that already exists — derive it."
**Fix:** Have `Session.start_session/3` build a `%Server.InitArg{}`
struct from `start_opts` + ids, and have `Server.start_link/1` take
that struct — Dialyzer then enforces field-set drift at compile time.

### S12. `Session.Server.init/1` does blocking TCP/TLS connect (Session-side mirror of S1)
**Module:** lifecycle | **File:** `lib/grappa/session/server.ex:152-171`
**Category:** GenServer state misuse / blocking init
`init/1` calls `Client.start_link/1` which (per `lib/grappa/irc/client.ex:261`)
synchronously connects upstream. Bootstrap iterates sessions
sequentially via `Enum.reduce`, so each `DynamicSupervisor.start_child`
blocks on the upstream connect; a slow/hanging upstream serializes
boot for every other network and every other user, and the Bootstrap
Task itself blocks the supervisor's `init/1` cascade.
**Fix:** Move `Client.start_link/1` into `handle_continue(:connect,
state)` and return `{:ok, state, {:continue, :connect}}` from
`init/1`. Boot becomes O(1) per session; the Client crash-on-init
still propagates via the link, just async. Pairs with S1 — fix both
together.

### S13. `Session.Server` persists with stale `state.nick` after upstream NICK collision/forced change
**Module:** lifecycle | **File:** `lib/grappa/session/server.ex:186-213`
**Category:** GenServer state — source-of-truth drift
`state.nick` is captured at `init/1` and never updated. If upstream
rejects the requested nick (`433 ERR_NICKNAMEINUSE`) and the user
lands on a fallback — or if upstream issues a forced `NICK` change —
outbound PRIVMSGs persist a Scrollback row with `sender = state.nick`
(the dead nick), and the broadcast carries that stale sender. Inbound
PRIVMSGs from self over the loop look like they're from a different
user.
**Fix:** Track nick mutations in `handle_info` for `:nick` (own-nick
changes via `Message.sender_nick(msg) == state.nick`) and the
relevant numeric replies. Phase 5 reconnect work will reopen this
anyway; better to land the data path now since the Scrollback rows
are forever.

### S14. `MessagesController.index/2` skips per-user iso credential check (network-existence probing oracle)
**Module:** web | **File:** `lib/grappa_web/controllers/messages_controller.ex:58-73`
**Category:** consistency / per-user iso
`ChannelsController.index/2` (lines 41-48) deliberately calls
`Networks.get_credential(user, network)` after resolving the slug so
"network exists but you have no credential" returns `:not_found`,
indistinguishable from "wrong slug" — docstring is explicit:
"probing users cannot distinguish 'wrong slug' from 'someone else's
network.'" `MessagesController.index` does NOT apply this check; same
shape leak in `MessagesController.create/2` and `ChannelsController.{create,delete}/2`
where slug-lookup precedes any user-credential check, then surfaces
different 404 reasons (`:no_session`) versus 404 (`:not_found`).
**Fix:** Resolve `(current_user, network)` credential at the boundary
in all four actions before reaching downstream context calls; collapse
"no credential," "wrong slug," and "no session" to the same
`{:error, :not_found}`. Pull the resolve-and-authorize step into a
shared helper (controller plug or context function) so it cannot
drift again.

### S15. `ScrollbackLine` switch on `kind` is non-exhaustive
**Module:** cicchetto | **File:** `cicchetto/src/ScrollbackPane.tsx:38-66`
**Category:** TypeScript exhaustiveness
The component branches on `kind === "action"` and `kind === "notice"`
and treats everything else as PRIVMSG-shaped. Once the union widens
(S4) or any unexpected payload arrives, JOIN/QUIT/MODE rows render
with the angle-bracket nick framing of a chat message. There's no
`assertNever` or default arm to surface the gap at compile time.
**Fix:** Refactor to a switch that exhaustively maps each
`MessageKind`; end with `default: const _exhaustive: never =
props.msg.kind;` so adding a new kind to the union forces a compile
error here.

### S16. PubSub channel `payload` is consumed without runtime narrowing
**Module:** cicchetto | **File:** `cicchetto/src/lib/networks.ts:196-202`
**Category:** TypeScript / defensive parse
`phx.on("event", (payload: ChannelEvent) => ...)` — the
`(payload: ChannelEvent)` annotation is a load-bearing lie;
phoenix.js types the callback as `unknown`. A malformed broadcast
(server bug, future event kind, network mid-frame corruption) lets
`payload.kind` throw on null/undefined or pass an arbitrary
`payload.message` into the store. CLAUDE.md "Validate at the
boundary" applies.
**Fix:** Treat the parameter as `unknown`; narrow with explicit
guards (`payload && typeof payload === "object" && "kind" in payload
&& payload.kind === "message" && validShape(payload.message)`)
before appending; log+drop rather than crash on shape mismatch.

### S17. Module-level `joined` and `loadedChannels` Sets leak across token rotations
**Module:** cicchetto | **File:** `cicchetto/src/lib/networks.ts:79-80`
**Category:** state hygiene / multi-user re-login
`joined` and `loadedChannels` live at module scope, never cleared. A
logout-then-login flow with a different bearer (or the same user
re-logging in after the WS disconnected) will see the join effect
skip every previously-joined channel because `joined.has(key)` still
holds — so no `phx.on("event", ...)` handler is reattached after the
socket's per-connection channels are torn down on disconnect. Symptom:
after re-login, the sidebar populates but no live messages arrive.
**Fix:** Move both Sets inside `createRoot`'s closure and add a
`createEffect(on(token, (t, prev) => { if (prev && !t) {
joined.clear(); loadedChannels.clear(); }}))` to flush them on logout.

### S18. Socket params token rotation only takes effect on disconnect/reconnect
**Module:** cicchetto | **File:** `cicchetto/src/lib/socket.ts:39-49`
**Category:** auth state propagation
The createEffect calls `s.connect()` only when `!s.isConnected()`.
Socket's `params: () => ({ token: token() ?? "" })` is invoked by
phoenix.js at WS-handshake time, so a token rotation that goes from
non-null A → non-null B (without an intervening null) keeps the live
connection up with token A pinned. Phase 5 token-refresh or
admin-driven re-issue will silently route under the wrong identity.
**Fix:** Detect token transitions (non-null → different non-null) and
force `s.disconnect(); s.connect();` so the new bearer is on the next
handshake.

### S19. `appendToScrollback` assumes monotonic arrival; out-of-order events break ASC invariant
**Module:** cicchetto | **File:** `cicchetto/src/lib/networks.ts:117-124`
**Category:** correctness
`mergeIntoScrollback` documents scrollback is "stored ASCENDING by
server_time so render is natural top-to-bottom." `appendToScrollback`
simply does `[...existing, msg]` — no sort, no insert-by-time. A WS
event whose `server_time` is older than the current tail (clock skew
on a multi-server bouncer setup, mid-flight reorder via PubSub
redelivery, or an out-of-order `:join` interleaving a backfilled
`:privmsg`) gets appended to the tail and renders out of order.
**Fix:** Insert by `server_time` (binary-search insertion) or always
re-sort — same shape as `mergeIntoScrollback`.

### S20. `scripts/iex.sh` bypasses worktree-aware helpers and uses raw `docker compose exec`
**Module:** cross-module/infra | **File:** `scripts/iex.sh:13,15`
**Category:** infra / scripts consistency
`iex.sh` is the only script (other than `deploy.sh` which intentionally
pins to main) calling `docker compose ... exec grappa ...` directly
instead of going through `_lib.sh`. From a worktree, opens an IEx
loaded with main's modules while editing worktree code — silently
divergent. Bypasses the "container not running → die" guard.
**Fix:** Replace both branches with `in_container bin/grappa remote`
and `in_container iex -S mix` (matching `observer.sh` and `shell.sh`).
Document `--remsh` semantics if `in_container`'s die-from-worktree
behavior is undesirable for the prod remote-shell case.

### S21. `LOG_LEVEL` and `POOL_SIZE` advertised in `.env.example` never reach the prod container
**Module:** cross-module/infra | **File:** `compose.prod.yaml:38-45` ↔ `.env.example:36,43` ↔ `config/runtime.exs:13,63`
**Category:** infra / env-var coverage drift
`runtime.exs` reads `POOL_SIZE` (line 13) and `LOG_LEVEL` (line 63)
via `System.get_env`. `.env.example` documents both as operator-facing
knobs. But `compose.prod.yaml`'s `environment:` block lists only
`MIX_ENV`, `DATABASE_PATH`, `SECRET_KEY_BASE`, `PORT`,
`RELEASE_COOKIE`, `GRAPPA_ENCRYPTION_KEY`, `PHX_HOST`. Docker compose
loads `.env` only for variable substitution into the YAML, NOT for
container env propagation, and there's no `env_file: .env` directive.
Result: `LOG_LEVEL=debug` in `.env` is silently ignored at runtime.
**Fix:** Either add `env_file: .env` to the `grappa` service in
`compose.prod.yaml`, or explicitly pass these through:
```yaml
environment:
  LOG_LEVEL: ${LOG_LEVEL:-info}
  POOL_SIZE: ${POOL_SIZE:-10}
```

---

## LOW

### S22. Parser `do_unescape/2` truncates trailing backslash silently
**Module:** irc | **File:** `lib/grappa/irc/parser.ex:189`
A tag value ending in a literal `\` (no following char) loses
information. IRCv3 spec says drop unrecognized escapes but keep the
following char — undefined for trailing `\`.
**Fix:** Preserve the trailing `\` literally OR document the
truncation.

### S23. `parse_/1` placeholder name in `IRC.Client`
**Module:** irc | **File:** `lib/grappa/irc/client.ex:521-525`
Function name `parse_/1` is clearly a placeholder. Parses CAP
cap-list blobs.
**Fix:** Rename to `parse_cap_list/1`.

### S24. Per-connect TLS `verify_none` warning fires on every connect
**Module:** irc | **File:** `lib/grappa/irc/client.ex:255-257`
A 110-char Logger.warning string with no metadata, fires on every
reconnect (Phase 5 backoff loops will flood).
**Fix:** Move to `Bootstrap` so it fires once at app boot when any
TLS network is configured; or add `network:` metadata.

### S25. `:awaiting_cap_ls` LS-continuation `++` order comment is misleading
**Module:** irc | **File:** `lib/grappa/irc/client.ex:431-434`
Comment claims `++` complexity is asymmetric in a way it isn't. The
chosen operand order is correct but the explanation is muddy.
**Fix:** Rewrite the comment to "left-arg of `++` is copied; chunk
is bounded (~15 caps per IRCv3 line) while buffer grows with N
chunks."

### S26. `Session.send_*` line-token guards duplicate `Client.send_*` guards
**Module:** irc | **File:** `lib/grappa/irc/client.ex:184-226` + `lib/grappa/session.ex:177, 194, 209`
Two layers, two guards, same predicate (`Identifier.safe_line_token?`).
**Fix:** Pick one boundary. Client owns the wire — drop the
Session-side guards and let `{:error, :invalid_line}` propagate.

### S27. Parser numeric type allows `0` but RFC numerics are `001..999`
**Module:** irc | **File:** `lib/grappa/irc/message.ex:71` + `lib/grappa/irc/parser.ex:142`
`@type command` declares `{:numeric, 0..999}` and parser accepts
`"000"`. RFC 2812 numerics are `001..999`.
**Fix:** Tighten to `1..999` in both type and parser guard; fall
through to `{:unknown, "000"}` when all three digits are zero.

### S28. `Logger.metadata(Keyword.new(opts.logger_metadata))` defensive conversion
**Module:** irc | **File:** `lib/grappa/irc/client.ex:232`
`opts.logger_metadata` is typed `keyword()`; wrapping with
`Keyword.new/1` is dead defensive code.
**Fix:** Drop `Keyword.new/1`. If a caller violates the type, let it
crash.

### S29. `:reason` in `Scrollback.Meta.@known_keys` is dead — never assigned to any documented per-kind shape
**Module:** persistence | **File:** `lib/grappa/scrollback/meta.ex:69`
The allowlist is `~w[target new_nick modes args reason]a`, but the
moduledoc per-kind shape table places `:reason` nowhere — `:quit`
and `:kick` both explicitly state "body carries reason." No producer
writes it.
**Fix:** Either drop `:reason` from `@known_keys` and the spec, OR
update the moduledoc per-kind table to assign `:reason` to a kind
that actually carries it in meta.

### S30. `Wire.t().meta :: map()` and `Message.t().meta :: map()` discard the `Meta` allowlist
**Module:** persistence | **File:** `lib/grappa/scrollback/message.ex:125`, `lib/grappa/scrollback/wire.ex:45`
Both typespecs declare `meta: map()`. The whole point of
`Grappa.Scrollback.Meta`'s allowlist is closed-set atom keys.
Dialyzer will not catch a caller constructing `%{garbage: 1}`.
**Fix:** Define `@type Meta.t :: %{optional(:target | :new_nick |
:modes | :args | :reason) => term()}` in `Grappa.Scrollback.Meta`,
then reference it as `meta: Meta.t()` in both `Message.t()` and
`Wire.t()`.

### S31. `Message.changeset/2` second-clause `t() | %__MODULE__{}` is redundant
**Module:** persistence | **File:** `lib/grappa/scrollback/message.ex:158`
`t()` IS `%__MODULE__{...}`; the union is `%Message{} | %Message{}`.
**Fix:** Reduce to `@spec changeset(t(), map()) :: Ecto.Changeset.t()`.

### S32. `down/0` of per-user-iso migration leaves divergent FK semantic
**Module:** persistence | **File:** `priv/repo/migrations/20260426000003_messages_per_user_iso.exs:39-51`
The two FK-related migrations (`...0003` and `...0004`) are
wipe-and-rebuild stacked on top of each other. Both are pre-deploy
"init-window exception"; the cleaner shape is squash.
**Fix:** Squash `0003` and `0004` into a single migration that lands
`messages.network_id` as `references(:networks, on_delete: :restrict)`
from the start.

### S33. `init.exs` creates `messages` without `user_id` despite "last edit-in-place" doctrine
**Module:** persistence | **File:** `priv/repo/migrations/20260425000000_init.exs:38-63`
`init.exs` was edited in place to add `meta` and nullable `body`, but
still creates `messages` without `user_id` and with `network_id
:string` — the columns `0003` immediately rewrites. Either commit to
"in-place edits" (fold per-user-iso into `init.exs`, drop `0003`/`0004`),
or commit to additive-only (revert the in-place edit, treat `meta`/`body`
as additive ALTERs).
**Fix:** Pick one doctrine and apply it consistently.

### S34. Bootstrap moduledoc asserts incorrect `:transient` restart semantics
**Module:** lifecycle | **File:** `lib/grappa/bootstrap.ex:9-11`
Comment: "If `run/0` itself crashes, `:transient` brings it back
exactly once." OTP `:transient` restarts on every abnormal exit
subject to `max_restarts`/`max_seconds`.
**Fix:** Replace "exactly once" with "subject to the supervisor's
restart budget (default `max_restarts: 3` over 5s)."

### S35. `Session.send_join/3` and `send_part/3` cast errors are TOCTOU
**Module:** lifecycle | **File:** `lib/grappa/session.ex:190-214`
`whereis/2` then `cast` returns `:ok` even if the session died
between. The `:no_session` semantics are TOCTOU and the `:ok` path
lies under crash.
**Fix:** Switch to `GenServer.call` for join/part — already
operator-driven, latency irrelevant; the controller can return `200`
instead of `202`.

### S36. `Session.start_session/3` accepts any map and crashes deep in `init/1` on shape drift
**Module:** lifecycle | **File:** `lib/grappa/session.ex:105-113`
Guard is `is_map(opts)`; `@spec` declares `start_opts()` (closed-key
map type) but Dialyzer-only checks don't fire at runtime.
**Fix:** Pattern-match the required key set in the function head, or
destructure into a struct (see S11).

### S37. `DynamicSupervisor.terminate_child` return value discarded with `_ =`
**Module:** lifecycle | **File:** `lib/grappa/session.ex:151`
The third documented return — `{:error, :simple_one_for_one}` — is
silently swallowed.
**Fix:** Pattern-match explicitly: `case ... do :ok -> :ok;
{:error, :not_found} -> :ok end`.

### S38. `Topic.parse/1` accepts empty user_name in compound topic shapes
**Module:** web | **File:** `lib/grappa/pubsub/topic.ex:71-87`
`parse("grappa:user:" <> rest) when rest != ""` only checks tail
non-empty; `String.split` with `rest = "/network:foo/channel:bar"`
produces `["", ...]`, matching the clause with `name = ""`. Channel
authz catches it today, but it's a parser invariant violation.
**Fix:** Add `name != ""` to the two- and three-segment clauses; add
a regression test.

### S39. Controller `@spec`s omit `:invalid_line`
**Module:** web | **File:** `lib/grappa_web/controllers/messages_controller.ex:85-88`, `lib/grappa_web/controllers/channels_controller.ex:55-56,82-83`
`Session.send_*` are specced to return `{:error, :invalid_line}` and
the moduledoc explicitly mentions it; controller `@spec`s omit it.
**Fix:** Add `:invalid_line` to all three controller `@spec`
returns.

### S40. `MessagesController.index/2` does not validate `channel_id` URL segment
**Module:** web | **File:** `lib/grappa_web/controllers/messages_controller.ex:58-69`
`MessagesController.create/2` calls `validate_channel_name(channel)`
to reject malformed channel names; `index/2` skips this and feeds
the raw URL segment into `Scrollback.fetch/5`.
**Fix:** Add `:ok <- validate_channel_name(channel)` to the `index/2`
`with` chain; lift the helper into a shared plug/context function.

### S41. `validate_channel_name/1` duplicated across two controllers
**Module:** web | **File:** `lib/grappa_web/controllers/messages_controller.ex:111-113`, `lib/grappa_web/controllers/channels_controller.ex:96-98`
Identical `defp` in both files. CLAUDE.md "Implement once, reuse
everywhere."
**Fix:** Hoist into a single helper (small `GrappaWeb.Validation`
module or a plug).

### S42. `MeController` and `NetworksController` re-fetch the User after the plug already authenticated
**Module:** web | **File:** `lib/grappa_web/controllers/me_controller.ex:20`, `lib/grappa_web/controllers/networks_controller.ex:23`, `lib/grappa_web/controllers/channels_controller.ex:42`
`Plugs.Authn` calls `Accounts.authenticate(token)` which already
loads the `Session` row; three controllers immediately re-query the
user — one DB round-trip per authenticated request that the plug
could have done once.
**Fix:** Have `Plugs.Authn` load the user and assign `:current_user`
(struct) once. Controllers consume `conn.assigns.current_user`.

### S43. `AuthController` private helpers lack `@spec`
**Module:** web | **File:** `lib/grappa_web/controllers/auth_controller.ex:66-74`
`format_ip/1` and `user_agent/1` lack `@spec`. Both feed
`Accounts.create_session/3` which is specced
`(_, String.t() | nil, String.t() | nil)`.
**Fix:** Add `@spec format_ip(Plug.Conn.t()) :: String.t() | nil`
and `@spec user_agent(Plug.Conn.t()) :: String.t() | nil`.

### S44. `GrappaChannel.join/3` join-payload param underscore name
**Module:** web | **File:** `lib/grappa_web/channels/grappa_channel.ex:39`
`def join(topic, _, socket)` — `_` discards silently. Convention is
`_payload`.
**Fix:** Rename to `_payload`.

### S45. iOS PWA meta tags missing from `index.html`
**Module:** cicchetto | **File:** `cicchetto/index.html:3-10`
Manifest is wired correctly but iOS Safari ignores `manifest.json`
for standalone-mode chrome and splash. Missing
`apple-mobile-web-app-capable`, `apple-mobile-web-app-status-bar-style`,
`apple-touch-icon`.
**Fix:** Add the three tags. (Doesn't change Android/Chrome PWA.)

### S46. `createRoot` in `socket.ts` and `networks.ts` has no dispose, leaking under `vi.resetModules()`
**Module:** cicchetto | **File:** `cicchetto/src/lib/networks.ts:82` ; `cicchetto/src/lib/socket.ts:39`
Both modules wrap reactive setup in `createRoot(() => {...})`
without retaining dispose. Production-fine; under tests
`vi.resetModules()` orphans previous root.
**Fix:** Export a `__resetForTests` (or accept a disposer) so test
setup can dispose the previous root before re-import.

### S47. Login error mapping is substring-based against the wire token
**Module:** cicchetto | **File:** `cicchetto/src/Login.tsx:31-32`
`code.includes("invalid_credentials")` matches the substring inside
the `ApiError.message` shape. Any unrelated error code containing
the literal substring silently maps to "Invalid name or password."
**Fix:** `err instanceof ApiError && err.code === "invalid_credentials"`.

### S48. `phx.join()` discards the result; channel-level errors are silent
**Module:** cicchetto | **File:** `cicchetto/src/lib/socket.ts:53,58,67`
All three `joinX` helpers call `ch.join()` without
`.receive("error", ...)` or `.receive("timeout", ...)`. The server
callback can return `{:error, %{reason: "unknown topic"}}` or
`{:error, %{reason: "forbidden"}}`; client treats both as silent
no-ops.
**Fix:** Chain `.receive("error", err => console.error("channel
join failed", topic, err))` and at minimum `.receive("timeout", ...)`.
Surface a per-channel "live updates unavailable" indicator.

### S49. Dead exports `joinUser` / `joinNetwork`
**Module:** cicchetto | **File:** `cicchetto/src/lib/socket.ts:51-61`
Neither helper is called anywhere in `src/**` (only `joinChannel`
is). Tests pin them.
**Fix:** Drop the exports + tests until a real call site exists.

### S50. `Object.fromEntries` cast bypasses TS inference
**Module:** cicchetto | **File:** `cicchetto/src/lib/networks.ts:102`
`return Object.fromEntries(entries) as Record<string, ChannelEntry[]>;`
— TS's lib types infer this without the cast. CLAUDE.md "TS
strictness: `as` casts that bypass exhaustiveness."
**Fix:** Drop the cast.

### S51. `ScrollbackPane` test mocks `scrollbackByChannel` as a non-reactive plain function
**Module:** cicchetto | **File:** `cicchetto/src/__tests__/ScrollbackPane.test.tsx:17-26`
The mock is a plain function, not a Solid signal accessor. The
auto-scroll-on-new-message UX (load-bearing per the comment header)
is never exercised reactively. Test pins the mock, not the contract.
**Fix:** Replace the mock with a real Solid signal so tests can
update mid-render and assert auto-scroll fires.

### S52. `scripts/bun.sh` writes build output to `cicchetto/dist`, but prod deploys serve `runtime/cicchetto-dist`
**Module:** cross-module/infra | **File:** `scripts/bun.sh:42-52` ↔ `compose.prod.yaml:80-93`
A developer running `scripts/bun.sh run build` to "preview prod"
produces output at the wrong path; cannot verify the actual dist
nginx will serve without invoking the compose oneshot directly.
**Fix:** Add the `runtime/cicchetto-dist` mount when the command is
`run build`, OR document `bun.sh` as dev-only.

### S53. CLAUDE.md references `grappa.toml` runtime config that no longer exists
**Module:** cross-module/infra | **File:** `CLAUDE.md` (Runtime Data section, scripts header references)
Phase 2 sub-task 2j swapped TOML-driven boot to DB-backed credentials;
no `grappa.toml`, no `grappa.toml.example`, no `Grappa.Config` module
exists. CLAUDE.md is project authority — future Claude sessions read
stale references.
**Fix:** Update CLAUDE.md "Runtime Data > Config" + the
`Grappa.Application` Bootstrap blurb to describe DB-driven boot
(`mix grappa.create_user`, `mix grappa.bind_network`). Drop the
`grappa.toml` references.

### S54. `Application.put_env/3` mutates global runtime state from mix tasks
**Module:** cross-module/infra | **File:** `lib/mix/tasks/grappa/boot.ex:43`
`Boot.start_app_silent/0` calls
`Application.put_env(:grappa, :start_bootstrap, false)` which
`Grappa.Application.bootstrap_child/0` reads — exact "global
config-as-IPC" shape CLAUDE.md prohibits. Process-local in mix-task
BEAM, but the pattern propagates.
**Fix:** Either (a) accept the violation and add a CLAUDE.md
exemption for mix-task boot suppression, OR (b) refactor
`Grappa.Application.start/2` to accept `:bootstrap?` injected at
start-time.

### S55. `MessagesController.create/2` `@spec` omits `:invalid_line` (spec drift catalog)
**Module:** web | **File:** *(catalog entry — see S39)*
*(Already covered by S39; listed here for completeness so the spec
audit is one item.)*

---

## Trajectory

### What did we build in the last 10 sessions (CP07 → CP10)?

- **CP07–CP08 (Phase 2 cluster):** SASL bridge, NickServ
  IDENTIFY, Cloak-encrypted upstream creds, session tokens
  (Argon2 + sliding 7-day idle), per-user channel-layer authz,
  DB-driven Bootstrap (replaced `grappa.toml`-driven boot).
- **CP09 (Phase 3 walking skeleton):**
  - **S1:** codebase-review gate (line-level + arch).
  - **S2:** S29 carryover sweep (hygiene cluster).
  - **S3:** cicchetto walking skeleton — login + channel list +
    scrollback + send + iPhone PWA install + `http://grappa.bad.ass`
    deploy.
  - **S4:** `/review` skill extended for `cicchetto/` +
    cross-cutting concerns; review itself deferred to next session
    (this one).
- **CP10 (this session):** `/review codebase` first run with the
  extended skill — 6 parallel agents covering server +
  cicchetto + cross-module/infra. Result: this document.

Theme: **end-to-end product wiring**. Phase 2 made the bouncer
multi-tenant; Phase 3 put the bouncer in the operator's pocket.
Recent work is not scattered — it is the most coherent run of the
project to date, all converging on "the operator's iPhone shows
their IRC." CP09 S3's project-story episode S38 captures this
viscerally.

### Does recent work serve the core mission?

Yes, unambiguously. The mission is "always-on IRC bouncer + REST/WS
API + browser PWA + (eventual) downstream IRCv3 listener." Phase
2 delivered the multi-user surface; Phase 3 delivered the PWA. The
bouncer has been talking to Azzurra continuously through both; the
operator confirmed installable PWA on their phone. The IRCv3
listener (Phase 6) remains the long-tail goal but is forward-compatible
with everything built so far (per CLAUDE.md invariants — same
parser, same scrollback schema, same PubSub topic shape).

### What's stalling?

- **Channel test flake** (`grappa_channel_test.exs:76`,
  `assert_receive %Phoenix.Socket.Message{}` intermittent timeout).
  Carried since CP07 (S17). CP09 noted it "may resolve naturally
  during 2h/2i" — it did not. ~1-in-5 hit rate. Now blocking the
  ability to trust `mix ci.check` parallelism.
- **`phase2-auth` worktree at `/home/vjt/code/IRC/grappa-phase2`**
  still dead weight. Logged in todo since CP07. Two-line cleanup,
  perpetually deferred.
- **Post-Phase-2 hygiene cluster** (M3 nick-regex consolidation,
  M5 error-string-casing, H11 central User wire shape, M2 web→Repo
  dep cleanup, M12 `Application.put_env` 6× duplication). Carried
  since S29 (CP07). CP09 noted it could "ride naturally as Phase 3
  surfaces invocation" — Phase 3 did not surface them; they remain
  unaddressed. M12 in particular is now reinforced by this review's
  S54 (mix-task `Application.put_env` violation).
- **Phase 5 hardening cluster** (TLS verify_none, bearer in WS URL,
  reconnect/backoff, `terminate/2` clean QUIT, multi-server
  failover, NickServ NOTICE parsing, etc.). Not stalling — explicitly
  parked on Phase 5. But the cluster is large and this review just
  added four HIGH+MEDIUM items to it (S1+S12 blocking init, S2+S3
  SW cache busting, S18 socket token rotation).

### Observation items due

- **Codebase review gate:** triggered by this session. Clock reset
  to 2026-04-27 + 2 weeks (≈ 2026-05-11) OR 12 sessions, whichever
  first.
- **Channel test flake:** repeated "may resolve naturally" was
  wrong. Re-flag for explicit triage in Phase 4 or earlier — needs
  someone to actually instrument the join handshake instead of
  hoping a refactor sweeps it.
- **Architecture review:** not run alongside this codebase review.
  Should be queued — Phase 3 introduced the entire `cicchetto/`
  subsystem and the server↔client wire-shape contract; structural
  review of the cross-boundary concerns is overdue.

### Risk check

**Production-impact risks surfaced by this review:**

- **PWA cache busting is fundamentally broken** (S2 + S3). The
  next deploy that bumps Vite asset hashes — which any non-trivial
  cicchetto change does — will leave every operator's installed
  PWA pinned to the old shell, with the cached HTML referencing
  dead asset paths. The operator's "verified session persists app
  closure" experience is true today only because they have not
  visited a deploy that bumped hashes.
- **Blocking `init/1`** (S1 + S12). A single hung upstream (Azzurra
  under load, hostile DNS, transient ISP) blocks Bootstrap and
  every other session's start. Today the bouncer only connects to
  one upstream so the blast radius is bounded; the moment a second
  network is bound, this becomes load-bearing.
- **`MessageKind` narrower than server enum** (S4 + S15). Phase 5
  presence-event capture is in the backlog; the day it lands and
  emits a `:join` event over PubSub, the client renders it as a
  PRIVMSG silently. TS can't catch it because the union is wrong.

**Carried risks (not new, but persistent):**

- **TLS `verify: :verify_none`** for upstream IRC. Phase 5 hardening
  item. Risk well-understood, deferred deliberately.
- **Bearer in WS upgrade URL** (`?token=…`). Phoenix
  `:filter_parameters` + nginx `access_log off` redact at log
  layer; on-wire pre-redaction exposure remains. Phase 5 hardening
  (B2-bonus from CP09).
- **Service Worker over `http://`** — iOS Safari will silently fail
  SW registration on the prod URL until TLS lands. CP09 logged as
  C1; resolves with Phase 5 TLS rollout. Currently the operator's
  installed PWA may be running without a SW at all on iOS Safari,
  in which case S2/S3 are deferred to whenever TLS lands —
  but the bug is real either way.

### Recommendation

**Land the cicchetto SW pair (S2 + S3) before Phase 4 begins.**
Phase 4 is the irssi-shape UI redesign — by definition a stream of
asset-bumping cicchetto deploys. The SW cache-busting is broken
right now; the moment the operator opens their PWA after a Phase 4
deploy, they will see a stale shell with broken assets. This is a
2-line `CACHE` version-bump fix (or a vite-plugin-pwa swap-in if
you want to do it once and forever) and it MUST land before any
Phase 4 commit hits production.

After SW lands, the natural sequence is **(1) Phase 4 brainstorm**
(per CP10 pending-2; `superpowers:brainstorming` is mandatory before
creative work), then **(2) Phase 4 implementation**, with **(3) the
hygiene cluster + channel-test flake folded in opportunistically**
as Phase 4 surfaces relevant code paths. The blocking-init pair
(S1 + S12) and the `MessageKind` widen (S4 + S15) should be
addressed before Phase 5 hardening starts cycling, but neither is
prod-blocking today.

The stall pattern around the hygiene cluster is the real signal:
"ride it naturally" hasn't worked across two phases. Either give it
a dedicated mini-cluster (half-session, all five items together) or
explicitly close them as won't-fix. Perpetual carryover is just
shipping a stale todo.
