---
date: 2026-04-26
session: S34 (CP09 S1)
type: codebase
baseline: 2026-04-26 S29 (post-Phase 2)
preceding_work: Cluster 1 (S31, A1+A4+A5+A7+A8+A18+A23+A26), Cluster 2 (S32, A2+A6+A10+A22), Cluster 3 (S33, A11+M12+A20+A30)
---

# Codebase review — post-Cluster-3, pre-Phase-3

Line-level pass per `.claude/skills/review/SKILL.md`. Complementary
to the architecture review (S31, concern-based) — that one mapped
structural debt; this one walks the code line by line for drift,
dead code, type lies, and rule violations.

5 parallel scope agents: `irc/`, `persistence/`, `lifecycle/`,
`web/`, `cross-module + infra`. Each read every file in scope +
`CLAUDE.md` + `CP09` + `DESIGN_NOTES.md` + the S29 baseline + the
S31 architecture review.

## Severity summary

| Scope | CRITICAL | HIGH | MEDIUM | LOW |
|-------|---------:|-----:|-------:|----:|
| irc/ | 0 | 1 | 1 | 8 |
| persistence/ | 0 | 0 | 0 | 7 |
| lifecycle/ | 0 | 0 | 0 | 4 |
| web/ | 0 | 0 | 0 | 8 |
| cross-module + infra | 0 | 0 | 3 | 9 |
| **after dedupe** | **0** | **1** | **4** | **~28** |

Net trend vs S29 baseline: 51 findings → ~33 findings, no new
CRITICAL, S29's CRITICAL closed (architecture review S31's A1
JSON-leak landed in Cluster 1), 1 HIGH carried unfixed (S29 M1
upgraded to HIGH), 5 MEDIUMs (4 carried, 1 new). The 3 cleanup
clusters demonstrably narrowed the surface; the residual findings
are mostly carryovers that escaped the cluster scope plus a few
new line-level drifts.

## Top findings — must address before Phase 3 ships

### F1. CAP LS continuation clause has no `:awaiting_cap_ls` phase guard (S29 M1 carryover, upgraded HIGH)
**File:** `lib/grappa/irc/client.ex:421-423`
**Severity:** HIGH
**Category:** logic-bug / unbounded-buffer
S29 M1 was claimed fixed in CP07 S27 but never landed. The
`[_, "LS", "*", chunk]` clause appends to `state.caps_buffer`
unconditionally — a buggy or hostile upstream emitting
`:server CAP nick LS * :junk` post-`:registered` grows the
in-process buffer until OOM or an eventual non-`*` LS arrival
clears it via `finalize_cap_ls`'s already-correct
`%{phase: :awaiting_cap_ls} = state` guard (which then does
nothing useful because phase has changed). ACK / NAK clauses
(lines 437, 446) correctly carry the guard; LS continuation does
not. Half-migrated per CLAUDE.md "Total consistency or nothing".
**Fix:** Add `%{phase: :awaiting_cap_ls} = state` guard to the
`[_, "LS", "*", chunk]` clause AND the finalizing
`[_, "LS", chunk]` clause. Catch-all on line 449 absorbs strays.
Pair with the `++` accumulator fix (S2 below in irc/) since both
clauses are touched.

### F2. Leading-dash nick regex still permissive (S29 L1 carryover, A8 mis-claimed fix)
**File:** `lib/grappa/irc/identifier.ex:26`
**Severity:** MEDIUM
**Category:** validator correctness / RFC 2812 §2.3.1 violation
A8 (Cluster 1) consolidated nick validation through `Identifier.valid_nick?/1`
but the regex itself still permits leading `-`. RFC 2812 is
unambiguous: dash is tail-only. `mix grappa.bind_network --nick -foo`
passes both Credential validate AND Identifier validate, but
upstream returns 432 ERR_ERRONEUSNICKNAME → `{:stop, {:nick_rejected, 432, "-foo"}}`
→ restart loop. The cluster fixed the wrong half: deduplicated
the source without correcting the rule. Operator can persist
unbootable credential.
**Fix:** Drop `\-` from the first-char class on line 26:
`~r/^[A-Za-z\[\]\\\`_^{|}][\w\[\]\\\`_^{|}\-]{0,30}$/`. Add a
property test: `valid_nick?(c <> rest)` for `c in nick_first_char_set()`
returns true; `valid_nick?("-" <> rest)` returns false.

### F3. `Bootstrap.spawn_one/2` mis-classifies `{:already_started, pid}` as `failed` (S29 H6 carryover)
**File:** `lib/grappa/bootstrap.ex:121-134`
**Severity:** MEDIUM
**Category:** counter semantics / operator log noise
**Surfaced by:** lifecycle S3 + cross-module S8 (deduped)
Bootstrap is `:transient`, so an unhandled crash inside
`spawn_all` triggers exactly one restart — and on that restart
every previously-spawned session is now `{:already_started, _}`
and gets bucketed as `failed`. Moduledoc makes the
`started`/`failed` counters operationally load-bearing
("Operator action: investigate the upstream or
`mix grappa.update_network_credential`"), so misclassified bucket
triggers misdirected operator action.
**Fix:** Add `{:error, {:already_started, _}}` clause to
`spawn_one/2`'s `else` that logs `:debug` and bumps `started`
(or a third bucket if first-boot vs restart distinction matters).
One extra clause; no architecture change.

### F4. `Networks.update_credential/3` and `add_server/2` `@spec` lies about raise/coerce paths (S29 M9 + M15 carryovers)
**File:** `lib/grappa/networks.ex:259-266` (update_credential), `:146-149, 239-251` (add_server, bind_credential)
**Severity:** MEDIUM (×2)
**Category:** type safety / signature accuracy
* `update_credential/3` calls `get_credential!/2` which raises
  `Ecto.NoResultsError` for unknown `(user, network)` — spec
  doesn't admit raise. Should be `update_credential!/3` (idiomatic
  `!` suffix) OR split into non-raising load-then-update.
* `add_server/2` + `bind_credential/3` pipe `attrs |> Map.new()`
  to coerce keyword input but spec declares `map()` only. Future
  REST controller piping `conn.params` (already a map) through a
  keyword intermediate triggers a Dialyzer mismatch. Either widen
  `map() | keyword()` or drop `Map.new/1` and require map-only
  with a guard.

## Carried-forward S29 LOW findings still standing

These survived Cluster 1+2+3 because they fell outside the
clusters' scope. None block Phase 3, but several are small enough
to fix opportunistically.

| ID | File | Description | S29 ref |
|----|------|-------------|---------|
| F5 | `lib/grappa/irc/parser.ex:208-211, 213-215` | `parse_prefix` returns `""` instead of `nil` for trailing `!` / `@` — two ways to spell "absent" | S29 L5 |
| F6 | `lib/grappa/irc/client.ex:512-516` | `parse_/1` trailing-underscore name; `caps_buffer ++` left-append O(n²) | S29 L3 + L18 |
| F7 | `lib/grappa/irc/client.ex:255-256` | `Logger.warning("phase 1 TLS posture")` fires per-init — log spam under reconnect storm | S29 L19 |
| F8 | `lib/grappa_web/endpoint.ex:9-16, 25-30, 46` | Dead `Plug.Session` plumbing + stale "no auth flow" moduledoc; `signing_salt: "rotate-me"` placeholder | S29 L12 |
| F9 | `lib/grappa_web/controllers/auth_controller.ex:36-37` | `login/2` 401s on empty-string credentials instead of 400 | S29 L13 |
| F10 | `lib/grappa_web/plugs/authn.ex:58-63` | 401 hand-rolls JSON literal, bypasses FallbackController convention; A7 wire-shape last-holdout | S29 partial M5 |
| F11 | `lib/grappa_web/controllers/me_json.ex` | `inserted_at: DateTime.t()` spec lies about `String.t()` post-Jason wire | S29 M18 |
| F12 | `priv/repo/migrations/20260425000000_init.exs:28-37` | Stale "last edit-in-place" comment contradicted by 5 subsequent migrations | S29 L7 |
| F13 | `lib/grappa/scrollback/message.ex:122` | `kind: kind() \| nil` contradicts `null: false` + `validate_required` | S29 M17 |
| F14 | `lib/grappa/scrollback.ex:118` | `persist_privmsg/5` does post-insert `Repo.preload` (extra round-trip every PRIVMSG) instead of stitching | new |
| F15 | `lib/grappa/scrollback/meta.ex:108-113` | `normalize_key/1` does O(N×M) `Enum.find` per key per row | new |
| F16 | `lib/grappa/scrollback/meta.ex:86,90` | `cast/load(_) → :error` swallows offending shape with no diagnostic | new |
| F17 | `compose.yaml:43-47` | Dev compose omits `GRAPPA_ENCRYPTION_KEY` despite `.env.example` documenting it | S29 M7 |
| F18 | `compose.prod.yaml:30-36` | Prod compose doesn't forward `LOG_LEVEL` or `POOL_SIZE` despite `runtime.exs` reading both | new (parallel to M7) |
| F19 | `scripts/deploy.sh:36-45, 49-55` | Migration loop 30s vs healthcheck 60s — asymmetric, no comment | S29 L21 |
| F20 | `grappa.toml` (host) + `CLAUDE.md` "Runtime Data" | `Grappa.Config` + TOML boot path ripped out in 2j; legacy file lingers; CLAUDE.md still describes it as live | new (post-2j drift) |
| F21 | `lib/grappa/scrollback/message.ex:131`, `lib/grappa/networks/credential.ex:62`, `lib/grappa/networks/server.ex:34` | `belongs_to :network, Network` lacks explicit `type:` at three sites | S29 H8 |
| F22 | `lib/grappa/irc/identifier.ex:47` | `@meta_sender_regex` permits control bytes inside `<...>` (no producer today, but validator is "if it passes me, it's safe") | new |
| F23 | `lib/grappa_web/channels/user_socket.ex:38-48` | Two SELECTs per WS connect for the same user (`authenticate/1` + `get_user!/1`) — should preload | new |
| F24 | `lib/grappa/session.ex:69` | Dead `require Logger` (no Logger calls in module) | new |
| F25 | `lib/grappa/session/server.ex:216-224` | `handle_cast({:send_join,...})` lacks the same `MatchError` insurance `handle_call({:send_privmsg,...})` documented | new |
| F26 | `lib/grappa/pubsub/topic.ex:40-61` | `user/1`, `network/2`, `channel/3` build helpers don't validate input shape — Phase 3 publishers may produce hostile topic strings | new |
| F27 | `lib/grappa_web/controllers/channels_controller.ex:46, 66` | `%{ok: true}` envelope hand-rolled; should be empty 202 body or routed through a Wire builder | new |
| F28 | `lib/grappa_web/controllers/{channels,messages}_controller.ex` | `validate_channel_name/1` duplicated verbatim across two controllers | new |
| F29 | `lib/grappa_web/plugs/authn.ex:28-49` | Nested `case` pyramid; ripe for `with` chain | new |
| F30 | `lib/grappa/irc/parser.ex:234-242` | `parse_params/2` doesn't enforce RFC 2812's 14-middle-param cap; doc says `*14` but code is unbounded | new |
| F31 | `lib/grappa/scrollback/wire.ex:48`, `lib/grappa_web/channels/grappa_channel.ex:51` | `Wire.event :: {:event, %{kind: :message, ...}}` — `kind` hardcoded; A25 trip-wire | A25 carryover |
| F32 | `lib/grappa/scrollback/meta.ex:55-65` | Per-kind `meta` shape table is doc-only, never enforced; A15 trip-wire | A15 carryover |
| F33 | `lib/grappa/irc/client.ex:101` | `Client.opts.host :: String.t() \| charlist()` — union admits charlist callers nobody has | new |
| F34 | `lib/grappa/irc/client.ex:176-177` | `send_line/2 :: iodata()` claim — every actual caller passes `String.t()` | new |

## Trajectory

### What we built recently

Phase 2 closed (S29 codebase review + 2j cluster review +
architecture review S31). Three pre-Phase-3 cleanup clusters
landed in lockstep on 2026-04-26:

* **Cluster 1 (S31, 8 commits):** wire-shape contract — A1
  CRITICAL JSON-leak closed via `Networks.Wire`, plus
  `Accounts.Wire`, REST snake_case envelope, identifier rule
  unification.
* **Cluster 2 (S32, 3 commits):** Networks↔Session cycle
  inversion. `Session.Server.init/1` is now ~25 LOC pure data
  consumer; deps shrunk 7→4. Reverse `Networks → Session` edge
  legalised. `Scrollback.has_messages_for_network?/1` replaces
  raw `messages` bypass. Networks↔Scrollback structural cycle
  broken via Boundary `dirty_xrefs` (real fix queued Phase 5+).
* **Cluster 3 (S33, 2 commits):** operator surface — `Boot` +
  `Output` helpers extracted; 6 mix tasks de-duplicated; bare
  `mix grappa` help-index added.

### Does it serve the core mission?

Yes. Mission per CLAUDE.md: always-on IRC bouncer + REST/WS
surface + downstream IRCv3 listener (Phase 6). All three clusters
served the mission directly:
- Cluster 1 made the wire shape (the contract `cicchetto` will
  consume + the contract Phase 6 listener will translate to
  IRCv3) honest and single-sourced.
- Cluster 2 made the Session boundary thin enough that Phase 6
  listener can spawn sessions through the same `start_session/3`
  shape Bootstrap uses.
- Cluster 3 made the operator surface scalable for Phase 5+
  (retention, eviction, rotation) without each new task
  copy-pasting boot ceremony.

### What's stalling

Nothing structurally. The codebase is in genuinely good shape
post-cleanup. Two threads are standing-but-unaddressed:

1. **`todo.md` is stale.** Claims "Post-Phase-2 hygiene cluster
   (carried from S29 + 2j review): M3, M5, H11, M2, M12" as
   pending — those all landed in Cluster 1+2+3. Needs update or
   delete.
2. **F1 (HIGH) + F3 (MEDIUM) are S29 carryovers that escaped 3
   clusters of cleanup.** The pattern — "claimed fixed, never
   landed" — is the kind of erosion CLAUDE.md "Total consistency
   or nothing" warns against. Worth a follow-up sweep before
   Phase 3 layers on top.

### Observation items due

- Channels test flake (`grappa_channel_test.exs:76`,
  `assert_receive %Phoenix.Socket.Message{}` ~1-in-5) — first
  flagged S17, survived Phase 2 + cleanup. Re-check during Phase
  3 cicchetto bootstrap (the WS surface gets exercised harder
  there).
- Scrollback `Database busy` flake under `max_cases:2`
  write-heavy parallelism (hit during S33 ci.check re-runs).
  Re-run was clean. Pre-existing under sqlite contention.

### Risk check

- **F1 is the only finding worth acting on before Phase 3.**
  Hostile/buggy upstream → unbounded buffer growth in long-lived
  sessions. The CAP LS phase guard is a 2-line fix (add the
  pattern guard); land it in a one-commit follow-up.
- **F2 / F3 are MEDIUM but "operator can persist unbootable
  credential" + "operator gets misdirected by failure counter"
  are the kind of footguns that will bite Phase 3 testing when
  cicchetto exercises the bind→connect path harder than the
  current single-network deploy.**
- F4 (×2 spec lies) are clean drift but not load-bearing for
  Phase 3.

### Direction recommendation

Land **F1** as a one-commit follow-up before starting Phase 3
cicchetto bootstrap — 5 minutes of work and closes the highest
severity finding. Then optionally bundle **F2 + F3 + F4** into a
"S29 carryover sweep" half-session commit (~10 findings, all
small, mechanical). Or defer the carryover sweep and fold those
findings naturally into Phase 3 work as cicchetto surfaces them.
The carryover sweep is the cleaner option — closing the S29
carryover ledger before starting Phase 3 means CP09 starts the
next cycle on a clean baseline.

After the carryover sweep, **start Phase 3 cicchetto repo
bootstrap.** Architecture review's pre-Phase-3 plan is fully
closed (12/12 findings in Clusters 1+2+3); the remaining 18 A*
findings are explicitly Phase 5+. Codebase review baseline is
clean enough to layer client work on top.

## Files reviewed (summary)

- `lib/grappa/irc/{parser, client, identifier, message}.ex` —
  irc agent
- `lib/grappa/scrollback{.ex, /message.ex, /meta.ex, /wire.ex}` +
  `priv/repo/migrations/*.exs` — persistence agent
- `lib/grappa/{application, bootstrap, release, repo, session, log,
  pubsub}.ex` + `lib/grappa/session/server.ex` + `lib/grappa/pubsub/topic.ex`
  — lifecycle agent
- `lib/grappa_web/**` — web agent
- All `lib/` for cross-pattern grep + `scripts/*.sh` + `Dockerfile` +
  `compose*.yaml` + `config/*.exs` + `.env.example` — cross-module +
  infra agent

Cross-referenced for every agent: `CLAUDE.md`, `CP09`, `DESIGN_NOTES.md`,
S29 codebase review, S31 architecture review, 2j cluster review.
