# Grappa — Project Memory

## What This Is

An always-on IRC bouncer with a REST API + Phoenix Channels real-time event
push, plus a browser PWA (`cicchetto`, separate codebase) that looks like
irssi. One supervised OTP process per `(user, network)`; sqlite-backed
scrollback; Phase 6 adds a downstream IRCv3 listener facade.

See `README.md` for the spec and `docs/DESIGN_NOTES.md` for the
chronological decision log. Active implementation plans live under
`docs/plans/`. Operator + developer runbook (verbs, scripts, deploy
machinery, per-host overrides, runtime data, monitoring) lives in
**`docs/OPERATIONS.md`**.

## Architecture

Top-level supervision tree:

```
Grappa.Application
├── Grappa.Vault                       (Cloak — encrypts at-rest creds; before Repo)
├── Grappa.Repo                        (Ecto + sqlite)
├── Phoenix.PubSub                     (name: Grappa.PubSub)
├── Registry                           (name: Grappa.SessionRegistry)
├── Grappa.Session.Backoff             (ETS — per-(subject, network) failure counter)
├── Grappa.WSPresence                  (per-user WS pid tracking → auto-away signal)
├── Grappa.Admission.NetworkCircuit    (T31 ETS-backed per-network circuit breaker)
├── DynamicSupervisor                  (name: Grappa.SessionSupervisor)
│   └── Grappa.Session.Server          (one per (user, network), :transient)
├── GrappaWeb.Endpoint                 (Phoenix HTTP + WS)
├── Grappa.Visitors.Reaper             (60s sweep of expired visitors; after Endpoint)
└── Grappa.Bootstrap                   (reads DB credentials, spawns sessions; LAST)
```

Child order is load-bearing — see `lib/grappa/application.ex` for the
why-comment per child. Vault before Repo (Cloak schema callbacks);
Backoff/WSPresence/NetworkCircuit before SessionSupervisor (ETS
tables read directly from `Session.Server`'s start path); Bootstrap
LAST (depends on Registry + SessionSupervisor existing). `Grappa.SpawnOrchestrator`
is a top-level boundary module (admission → Backoff.reset → spawn
verb), NOT a supervised child — both Bootstrap and
`NetworksController.connect/2` call into it.

Key invariants — break only with deliberate cause + DESIGN_NOTES entry:
- **One IRC parser, on the server.** `Grappa.IRC.Parser` is the single
  source of truth for IRC framing. `cicchetto` (the web PWA) NEVER parses
  IRC; it consumes typed JSON events.
- **Scrollback is bouncer-owned.** sqlite via Ecto. Schema is
  `(network_id, channel, server_time DESC)`-indexed; a future
  `CHATHISTORY` listener facade (Phase 6) is a mechanical query
  translation, not a redesign.
- **Read state is server-owned, per (subject, network, channel).**
  Cursor = `last_read_message_id` (FK to `messages.id`). Removing
  server-side cursor is a breaking change. The write cadence (settle
  events), the cic in-pane divider freeze contract, and the Phase 6
  `+draft/read-marker` MARKREAD facade are mechanics, not invariants —
  see `docs/DESIGN_NOTES.md`.
- **`CAP LS` + SASL is the only required upstream IRCv3 feature.**
  Everything else (`server-time`, `batch`, `labeled-response`, etc.) is
  opportunistic. Never assume upstream-side `CHATHISTORY` exists.
- **Phoenix Channels is the streaming surface, not SSE.** Topics are
  user-rooted (per Phase 2 sub-task 2h, for cross-user authz at the
  routing layer):
  `grappa:user:{user_name}`,
  `grappa:user:{user_name}/network:{network_slug}`, and
  `grappa:user:{user_name}/network:{network_slug}/channel:{channel_name}`.
  Single source of truth: `Grappa.PubSub.Topic`. The `phoenix.js`
  client lib handles reconnect + replay. PubSub broadcast + Channel
  push payloads MUST be JSON-encodable — convert structs to wire
  shape via a context-owned `*.Wire` module (`Grappa.Scrollback.Wire`,
  `Grappa.QueryWindows.Wire`). Raw `%Schema{}` structs over PubSub
  crash Phoenix's `fastlane!/1` at the WS edge during fan-out;
  `Jason.Encoder` derive on schemas is NOT enough because the
  schema's wire shape rarely matches the storage shape. Wire
  conversion is per-context responsibility.
- **Window state model lives on the server.** `Grappa.Session.Server`
  owns `window_states %{channel => :pending | :joined | :failed |
  :kicked | :parked}` + sibling `window_failure_{reasons,numerics}`
  + `window_kicked_meta` maps. Transitions emit typed events on the
  per-channel topic (`kind: "joined" | "join_failed" | "kicked" |
  "members_seeded"`); cic's `lib/windowState.ts` mirrors via
  `lib/subscribe.ts` dispatch. cic NEVER originates state — no
  optimistic STATE assumptions, no parallel client-side state
  machine. Adding a new state (e.g. SASL-gated `:locked`) requires
  server changes; cic just mirrors. The cic-side
  `windowStateByChannel` store is the AUTHORITATIVE sidebar
  projection key — `channelsBySlug` feeds into it but is not the
  sole source. New states automatically inherit synthetic-row +
  greyed-class treatment as long as they land in
  `windowStateByChannel`.

## Tech Stack

- **Elixir 1.19 + Erlang/OTP 28** — pinned in `.tool-versions`.
- **Phoenix 1.8** + **Bandit** — HTTP server + WebSocket Channels.
- **Ecto 3 + ecto_sqlite3** — persistence.
- **Own IRC client** (`lib/grappa/irc/`) — binary pattern matching.
  `exirc` was rejected (stale on hex). The parser is reused for the
  Phase 6 IRCv3 listener facade.
- **Tooling:** Dialyxir + Credo (strict) + Sobelow + mix_audit + doctor +
  Boundary + ExUnit + StreamData + Mox + Bypass + ExMachina +
  excoveralls + observer_cli + recon.

Operator dispatcher (`bin/grappa`), developer scripts (`scripts/*.sh`),
hot vs cold deploy preflight, per-host compose overrides, runtime data
(DB / migrations / logs / config), monitoring — all in **`docs/OPERATIONS.md`**.

## Engineering Standards

These rules carry across all sessions. They override the temptation to
copy whatever pattern is closest in the codebase. **Read the directions,
not the surrounding code.**

### Foundation rules

- **Challenge the spec.** If domain knowledge contradicts the
  requirements, say so before building. A 30-second question costs
  nothing. Building the wrong thing costs hundreds of commits.
- **Directions over code.** This file + `docs/DESIGN_NOTES.md` +
  `docs/plans/*.md` are the authority. If existing code contradicts
  them, the code is wrong — flag it to vjt, don't copy the divergent
  pattern. Every session starts with zero memory; the codebase will
  tempt you to copy whatever pattern is closest. Resist. **This applies
  to plans and specs too.** When copying an existing pattern into a
  design, evaluate it against this file first. A bad return type doesn't
  become good by being in the spec — the spec inherited a bug.
- **Ask before building.** Before implementing anything substantial:
  (1) Does the infrastructure already provide this? (2) Is there a
  10x simpler approach? (3) Will this still exist in two weeks?
- **Design discipline.** Before proposing recovery mechanisms,
  tracking structures, or escalation ladders:
  (1) Don't duplicate state that already exists — derive it. Every
  parallel structure needs housekeeping that will drift.
  (2) Think about the general problem, not the specific incident
  that triggered the design. No tunnel vision.
  (3) Optimize for all general cases with room for edge cases.
  (4) Lightweight over heavyweight. If the mechanism is heavier
  than the problem, the mechanism IS the problem.
  (5) Think it through before proposing. Consider all dimensions
  (existing state, lifecycle, constraints, redundant work) THEN
  present. Don't make the human iterate half-baked proposals.
  (6) Reuse the verbs, not the nouns. When a second use case fits 80%
  of existing infrastructure, ask "what are the 20% that don't fit?"
  Those 20% are the domain boundary. Shared execution framework =
  good reuse. Shared data model with a type flag = boundary violation.

### Investigation discipline

- **Debug with data first**: read logs (`scripts/monitor.sh`), inspect
  runtime state (`scripts/observer.sh` or `:sys.get_state(pid)` in IEx),
  query the DB (`scripts/db.sh`) before changing code. NEVER guess.
  NEVER change code speculatively. Evidence first.
- **Never fabricate explanations.** If you don't know why something
  happened, say "I don't know, let me check" and read the code or
  logs. A confident wrong explanation is worse than admitting
  ignorance — it wastes time and erodes trust.
- **Debugging tools are infrastructure**: when you need to inspect
  system state, build an HTTP endpoint or `Phoenix.LiveDashboard`
  metric — not a throwaway IEx script. Endpoints are reusable, remotely
  accessible, tested, and survive across sessions.
- **One feature, one code path, every door.** New data = context
  function → controller → channel event. Same logic, three access
  methods. Channels are not a separate state model from REST; they
  push the same domain events.

### Code-shape rules

- **Read before writing.** Before editing any file, read its sibling
  modules and existing patterns. Grep for what you're about to build —
  it probably exists.
- **Implement once, reuse everywhere**: if two places need the same
  logic, refactor to share it. Never copy-paste with tweaks.
- **Use infrastructure, don't bypass it.** Going around the established
  path "just this once" loses observability (Logger metadata, telemetry,
  PubSub broadcasts). If the infrastructure doesn't support what you
  need, extend it.
- **No leaky abstractions**: each context owns its domain. Return
  domain types (`%Grappa.Scrollback.Message{}`, not `map()`). If the
  architecture doesn't support what you need, fix the architecture.
- **Consistency**: same problem, same solution. Plans must read this
  file FIRST — if a plan conflicts with a documented pattern, fix the
  plan.
- **Atoms or `@type t :: literal | literal` — never untyped strings**
  for closed sets. Message kinds (`:privmsg | :notice | :action`),
  network states, etc. all live as types or atoms-in-allowlist. Reject
  unknown values at the boundary.
- **Total consistency or nothing.** Half-typed is worse than untyped.
  Half-migrated creates two patterns — Claude copies whichever is
  closer. If migrating, migrate ALL instances. No exclusion lists, no
  "Phase 2 later." The codebase IS the instruction set — whatever
  patterns exist, Claude will propagate.
- **State the contract**: signature + failure mode in one sentence
  before implementing. "`@spec foo(integer()) :: {:ok, t()} |
  {:error, :not_found}`" — write the spec FIRST.
- **Fix root causes, not examples**: no band-aids. A bug report is one
  instance of a broader class — find the general rule.
- **Dialyzer warnings are design signals.** When Dialyzer flags a
  type mismatch, ask WHY — the constraint is probably correct, your
  approach is probably wrong.
- **No default arguments via `\\`**, except for genuine config defaults
  where the default is the correct production behavior. Default
  arguments create silent degradation paths. Every new function MUST
  require all parameters explicitly. When touching existing code that
  uses defaults, REMOVE them.
- **Recursive pattern match over `Enum.reduce_while/3` for
  collect-or-bail traversal.** When mapping a function across a list
  with success-extends-acc / error-returns-immediately semantics, write
  the three-clause recursive shape — it's tail-recursive, declarative,
  and avoids the `{:ok, acc}` wrapper + pipe-to-case afterthought:

  ```elixir
  defp traverse(list, fun), do: traverse(list, [], fun)
  defp traverse([], acc, _), do: {:ok, Enum.reverse(acc)}
  defp traverse([h | t], acc, fun) do
    case fun.(h) do
      {:ok, item} -> traverse(t, [item | acc], fun)
      {:error, _} = err -> err
    end
  end
  ```

  `Enum.reduce_while/3` is still right for genuine fold-with-early-exit
  (search-with-state, accumulate-until-threshold) where the accumulator
  carries computed state across iterations. For pure collect-or-bail,
  it's overkill.
- **IRC stays text only.** No inline rendering of media types in
  scrollback (images, videos, audio, link-unfurl previews). Media
  URLs in PRIVMSG bodies are clickable links via the existing
  `linkify` path; clicking opens the resource in a browser tab. Do
  not propose in-scrollback thumbnails / autoplay / preview cards /
  lightbox-on-arrival without an explicit cluster spec lifting this
  rule. The image-upload pattern ships a 📸-prefixed URL that is
  text on the wire and a clickable link in cic — that is the model.
- **Bite-sized commits**: one logical change. Messages explain WHY.
- **Log honesty**: when a fast path skips work, the log message must
  describe the state it OBSERVED, not the absence of work. Example:
  `bootstrap: no credentials bound — running web-only` lies when N
  credentials exist but all are `:parked` or `:failed`. The honest
  line reads `0 credentials in :connected state (N parked, M failed)
  — running web-only`. General rule: fast paths state what they
  observed, not what they did. If your fast path is "skip because
  input was empty," check WHY it was empty before logging the skip —
  the empty input is often a different bug surfacing at the wrong
  layer.
- **DB state and live state are separate sources of truth.** Every
  admin resource listing MUST combine both, and `live_state: null` is
  the honesty signal that something diverged — don't paper over
  with computed-from-DB fields.
  `Grappa.Networks.Credential.connection_state` is the DB-canonical
  state; `Grappa.Session.whereis/2` is the live-pid truth. They can
  disagree: a `:connected` credential whose `Session.Server` crashed
  mid-restart; a `:parked` credential whose pid is in respawn backoff;
  a row marked `:disconnected` whose process is in `terminate/2`.
  `AdminSessionsTab` surfaces BOTH columns and shows an explicit
  `null` when the live pid is gone — diagnostic value beats false
  uniformity. When adding a new admin listing, return both
  projections; never compute one from the other to "tidy up" the
  response shape.
- **No silent-swallow at boundaries.** Two failure modes share one
  root: (a) a controller helper that wraps an ok-or-error
  orchestrator and throws the error away while returning ok (e.g.
  DB row at `:connected`, no live Session.Server, REST writes 404
  silently); (b) a wide `try`/`catch` exit-clause in a long-lived
  process (e.g. `Session.Server.terminate/2`) that absorbs an
  exception class which "shouldn't happen" and so hides the next
  bug to fall into it. Both share the lesson: the operator (or CI)
  MUST see the failure. Fix at the boundary that raised (return
  `{:error, _}` and propagate via `with`/FallbackController); never
  widen the catch to swallow more. A safety net that catches an
  impossible exception silently absorbs the next class of bug.

### OTP patterns (Elixir-specific)

- **GenServer when** state must persist between calls AND callbacks
  must be serialized. Mailbox is the synchronization primitive.
- **Task when** there's a one-shot async unit of work. `Task.async` +
  `Task.await` for promise-shape. `Task.start_link` (linked) +
  `restart: :transient` for fire-and-forget under a supervisor.
- **Agent when** state is shared but doesn't need behaviour. Almost
  never the right call — prefer GenServer for explicit message
  contracts.
- **Registry for named processes**, NEVER `Application.put_env` for
  runtime state. `{:via, Registry, {Grappa.SessionRegistry, key}}`
  for unique-key lookup; `:duplicate` keys for pubsub-style fan-out.
- **DynamicSupervisor when** processes are spawned at runtime (one
  per user, one per channel, etc.). Plain `Supervisor` only for
  static children declared at boot.
- **Let it crash** is the rule for unexpected errors. `try/rescue`
  ONLY when you can recover meaningfully (network timeout retried,
  malformed input rejected at boundary). Otherwise let the
  supervisor restart with fresh state. Defensive programming hides
  bugs.
- **Crash boundary alignment**: a session GenServer crashing should
  reset only that session's state. Don't put cross-session state in
  the session GenServer. Don't put per-user state in
  `Phoenix.Endpoint`.
- **Restart strategy:**
  - `:permanent` for infrastructure (Repo, Endpoint, PubSub).
  - `:transient` for per-user sessions (restart on abnormal exit,
    don't restart on `:normal` shutdown).
  - `:temporary` for one-shot tasks (don't restart at all).
- **Process state stays small.** Anything that must survive a crash
  goes in Ecto, not GenServer state. GenServer state is "what I need
  to do my next message" — not the source of truth.
- **`Application.{put,get}_env/2`: boot-time only, runtime banned.**
  Allowed at boot-time configuration boundaries: `config/*.exs`,
  `lib/grappa/application.ex` start/2 (the documented exception), and
  inside mix-task helpers BEFORE `Application.ensure_all_started/1`.
  Banned at runtime — neither read nor written from any GenServer
  callback, controller, context function, plug body, or release task.
  Pass config via `start_link/1` opts; the supervisor reads env at
  boot and injects. Lets tests substitute values without runtime
  config tricks.

### Phoenix / Ecto patterns

- **Contexts at `lib/grappa/<context>.ex`.** Schemas live as
  `lib/grappa/<context>/<name>.ex`. Public API on the context module;
  schemas internal. Boundary library enforces.
- **Controllers thin, contexts thick.** Controller responsibilities:
  parse params, call context, render. Logic lives in the context.
- **`FallbackController` for `{:error, X}` returns.** Don't `case` on
  results in every action.
- **Ecto.Changeset for ALL user input.** Never `Repo.insert/2` with a
  raw map you didn't validate. Validate at the boundary.
- **Migrations are idempotent.** Use `create_if_not_exists` only when
  rebuilding from scratch is meaningful; otherwise plain `create` so a
  drift between migrations and schema is a loud error.
- **Sandbox per test (`async: true`).** Never share sandbox across
  tests. `use Grappa.DataCase, async: true`.
- **PubSub topic naming: `grappa:` prefix mandatory.** Topics are
  user-rooted: `grappa:user:{user_name}`,
  `grappa:user:{user_name}/network:{network_slug}`,
  `grappa:user:{user_name}/network:{network_slug}/channel:{channel_name}`.
  Single source of truth: `Grappa.PubSub.Topic`. Don't introduce
  sibling prefixes; future Phase 6 listener may need to share topics
  with the REST surface.
- **Phoenix Channels = the event push surface.** REST is for resources
  (channels, messages, networks). State changes broadcast over
  Channels via `Phoenix.PubSub.broadcast/3`. Don't poll REST for
  updates from a connected client.
- **Admin endpoints go through the `:admin_authn` pipeline.** When
  adding a `/admin/<resource>` route under
  `scope "/admin", GrappaWeb.Admin`, mount it on
  `pipe_through [:api, :authn, :admin_authn]`. The `:admin_authn` plug
  (`GrappaWeb.Admin.AuthPlug`) requires
  `current_subject = {:user, %User{is_admin: true}}` and 403s every
  other subject shape — don't bypass it with per-controller checks or
  skip-the-plug shortcuts. Distinct from the loopback `:admin`
  pipeline (which gates `/admin/reload` + `/admin/cic-bundle-changed`
  on `Plugs.LoopbackOnly`); same URL prefix, separate scopes. The
  nginx allowlist (`infra/nginx.conf` + e2e
  `cicchetto/e2e/nginx-test.conf`) must list the new resource — both
  the `:80` and `:443` server blocks — or the route 404s at the proxy
  before reaching Phoenix.

### Charset / wire-format rule

- **IRC is bytes; the web is UTF-8.** Convert at the boundary, not
  inside business logic. The Ecto schema stores `body :string` as
  Elixir-canonical UTF-8. The IRC parser handles incoming bytes;
  output to upstream is encoded back to bytes at `IRC.Client`.
- **CTCP control characters (`\x01`) are preserved as-is** in the
  scrollback `body`. Don't strip them — round-trip fidelity matters
  for `ACTION` and other CTCP verbs.
- **Never assume ASCII.** Nicknames, channel names, message bodies are
  all potentially UTF-8. Use `String.length/1` only when you mean
  graphemes; use `byte_size/1` for IRC framing limits.

### Testing Standards

**How to RUN tests is in `docs/TESTING.md`** — single canonical
runbook for `scripts/test.sh`, `scripts/check.sh`,
`scripts/bun.sh run test`, `scripts/integration.sh`, e2e
cascade-vs-flake triage, gotchas, and `--repeat-each` iso-rerun
discipline. Don't duplicate test-running commands here; this
section is RULES, that file is HOW.

- Assert outcomes, not call sequences. Ask: "If the implementation were
  wrong, would this test catch it?" If not, the test is a mirror.
- **Never assert buggy behavior.** A test that encodes a bug prevents
  anyone from finding the bug.
- **Mock at boundaries (Mox), real dependencies inside.** Sandbox the
  Repo. `Bypass` for HTTP stubs. The `Grappa.IRCServer` test helper is
  an in-process fake IRC server for session tests — use it, don't mock
  `:gen_tcp` directly.
- **Use production code in tests** — never hardcode strings or
  re-implement logic. If a test needs formatted output, call the
  production formatter.
- **Never weaken production code to make tests pass.** If a test needs
  special setup, fix the test — don't add optional parameters or
  bypass paths to production code.
- Mock data must be realistic — empty structs, missing required fields,
  and zero-length strings cause tests to pass while validating nothing.
- **Property tests via StreamData** for any function with non-trivial
  input shape (parser, pagination boundary, etc.).
- Zero warnings. `mix test --warnings-as-errors` is the only way.
- Test helpers mandatory; names = scenario + outcome.
  (`"GET /messages?before=cursor returns descending page"`).

### Architecture tests

- Use `Boundary` annotations — not string-matching.
- Don't test that `Foo` calls `Bar.baz/1` (implementation detail).
  Test that `Foo` exposes the right boundary contract.

## Session Protocol

### At Session Start

Use `/start` to run the full session-start protocol. It reads the
codebase-review gate, the active checkpoint, todo, and produces a
status report. Full protocol in `.claude/skills/start/SKILL.md`.

### Reviews

Codebase reviews are enforced every 12 sessions or 2 weeks. They cover
code quality, architecture, and trajectory. See
`docs/reviews/codebase/` for past reviews.

### When Asked "What's Next?"

Run `/start` — it checks everything including whether a codebase review
is due. Don't just look at todo.md.

### Development Cycle

0. **Worktree first.** Multiple sessions run concurrently. All code
   changes go in a worktree branch, never main directly. Docs-only
   changes (checkpoints, todo) may commit to main.
   **CRITICAL: `git checkout main` FIRST, then create the worktree.**
   If you're on a feature branch, the worktree branches from THAT
   branch, not main. **Branch from local main, NEVER origin/main.** Local
   main has unpushed commits. Branching from origin loses recent work.
   **Rebase before merge.** Before merging a worktree branch to main,
   rebase it onto main first: `git rebase main` from the worktree.
1. **Fix pre-existing errors first.** Before starting any work, run
   `scripts/check.sh`. If there are existing failures, fix them in the
   first commit. Zero errors is the baseline. NEVER dismiss errors as
   "pre-existing, not from my changes."
2. Design → Implement (TDD: failing test FIRST) → Test → Type check
   (Dialyzer) → **Format** → **Credo** → **Sobelow** → **Commit** →
   **Code review** → Fix → Commit → **Update docs** → **Merge** →
   **Deploy** → Health check → Update checkpoint.
   Code review is NEVER optional.
3. **Merge BEFORE deploy.** `scripts/deploy.sh` reads from
   `/srv/grappa` (main). Worktree code is NOT in the build context.
   Workflow: rebase worktree onto main → merge to main →
   `scripts/deploy.sh` (auto-detects hot-vs-cold; `--force-cold` if
   the heuristic mis-classifies) → verify health → push.
4. **Docs before deploy.** Update affected living docs (DESIGN_NOTES,
   patterns/*.md if introduced, todo).
5. Update checkpoint after each feature/fix. Flush before compaction.
6. Done items: remove from todo.md, record in checkpoint.
7. **Context pressure is YOUR problem.** Proactively suggest compact
   when context is heavy. Flush all work to checkpoint first.

### Commit Messages

- Use a HEREDOC via `git commit -m "$(cat <<'EOF'\n...\nEOF\n)"` to
  preserve line breaks. Never echo, never printf.
- One logical change per commit. Message explains WHY.
- Lead line: `<scope>: <imperative summary>` (≤72 chars). Body
  paragraphs explain the WHY, the alternatives considered, the
  tradeoffs accepted.

### What NOT To Do

- **Don't overengineer.** "add X" means add X, not X + Y + Z. If a
  change touches more than ~10 files unexpectedly, stop and confirm
  before continuing.
- **Don't iterate through 10 wrong approaches.** Stop, think, ask.
- **Don't propose split environments.** One Docker Compose stack. No
  systemd, no bare `mix run`, no `infra/dev` vs `infra/prod`.
- **NEVER run raw `docker compose`** — use `scripts/*.sh`. Always.
- **NEVER `mix` on the host** — the container is the runtime.
- **NEVER install hex packages on the host.** Add them to `mix.exs`,
  rebuild the image (`scripts/mix.sh deps.get`).
- **Don't touch the IRC parser without re-running parser tests.**
  Binary pattern matching breaks silently on edge cases.
- **Don't touch supervision tree ordering casually.** Ordering matters
  (PubSub before Endpoint, Repo before sessions). Document the WHY in a
  comment if you change it.
- **Read MORE than 30 lines of logs.** Default to 200+.
- **Document every change.** Update relevant docs in the same commit.
- **Project story lives on.** After significant sessions (new
  features, major refactors, production incidents, hard-won lessons),
  add an episode to `docs/project-story.md`.

## Security

- **Credentials via env vars only.** SECRET_KEY_BASE, RELEASE_COOKIE,
  SASL passwords. Never committed. Never logged.
- **NickServ + SASL passwords** are stored in the DB encrypted at rest
  via Cloak.Vault (AES-GCM, key from `CLOAK_KEY` env). Operator binds a
  network with `mix grappa.bind_network --auth ...`; the cleartext
  never hits a config file. Phase 5 hardening adds HSM-keyed Vault
  (yubico-hsm / TPM / KMS) for operators who want to escape "env on
  disk" key storage.
- **TLS verification on by default.** The Phase 1 `verify: :verify_none`
  is a temporary expedient — Phase 5 hardening adds proper CA chain
  verification. Document the change when it lands.
- **Sobelow is a CI gate** — Medium-or-above findings fail the build.
  Every Phoenix app gets it.
- **`mix deps.audit` + `mix hex.audit` are CI gates.** CVE-flagged
  deps fail the build immediately.

## Docs map

- **CLAUDE.md** (this file): rules, principles, invariants, session protocol.
- **`docs/OPERATIONS.md`**: operator + developer runbook (verbs,
  scripts, deploy, runtime data, monitoring).
- **`docs/TESTING.md`**: how-to-run-tests runbook (every gate, e2e
  triage, gotchas).
- **`docs/DESIGN_NOTES.md`**: chronological decision log.
- **`docs/plans/*.md`**: implementation plans, TDD steps, exit criteria.

If a rule belongs in the codebase as code, write the code. If a rule
belongs in conversation, write a memory. CLAUDE.md is for the rules
the human will want enforced six months from now without re-explaining.
