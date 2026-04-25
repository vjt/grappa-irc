# Codebase Review — 2026-04-25

**Trigger:** First codebase-level review since project init. CP04 marked
the gate DUE; CP05 carried it forward post-Phase-1.5 architecture-fix
work. User's explicit framing: "let's fix properly all architecture
issues. then we do codebase level. i sm sure arch fixes will reduce
codebase ones." — this review tests that hypothesis.

**Method:** 5 parallel background agents, line-level scan, one per
scope:

| Agent | Scope |
|-------|-------|
| irc/ | `lib/grappa/irc/` (parser, client, message, identifier) |
| persistence/ | `lib/grappa/scrollback*` + `priv/repo/migrations/` |
| lifecycle/ | `lib/grappa/{application,bootstrap,config,release,repo,session,log,pubsub}*` |
| web/ | `lib/grappa_web/` (endpoint, router, controllers, channels) |
| cross-module + infra | Patterns across all `lib/` + `scripts/`, `Dockerfile`, `compose*.yaml`, `config/`, `.env.example`, `grappa.toml.example` |

Each agent read CLAUDE.md + CP05 + DESIGN_NOTES + every file in scope.
Reports were findings-only (no praise) per skill protocol.

---

## Headline

**Hypothesis vindicated.** 5 findings total — 1 HIGH, 3 MEDIUM, 1 LOW.
For comparison: the architecture review one session ago surfaced 24
findings (4 CRITICAL / 6 HIGH / 10 MEDIUM / 4 LOW). The four new domain
modules (`PubSub.Topic`, `Log`, `Scrollback.Wire`, `IRC.Identifier`)
plus the Session.Server cohesion pass collapsed most of what would have
been line-level findings into single-source helpers. The remaining
findings are localised, not structural.

The `lifecycle/` agent reported **zero findings** outright. The
`cross-module + infra` agent found one config-symmetry gap. The
`persistence/` agent flagged a moduledoc inaccuracy and an out-of-scope
test scope issue. The `irc/` agent flagged a missing catch-all. The
`web/` agent found the only HIGH — a single controller line that
crashes instead of routing through the FallbackController.

---

## Severity counts

| Severity | Count |
|----------|-------|
| CRITICAL | 0 |
| HIGH | 1 |
| MEDIUM | 3 |
| LOW | 1 |
| **Total** | **5** |

| Scope | Findings |
|-------|----------|
| irc/ | 1 (MEDIUM) |
| persistence/ | 1 (LOW) |
| lifecycle/ | 0 |
| web/ | 2 (HIGH + MEDIUM, same root cause) |
| cross-module + infra | 1 (MEDIUM) |

---

## Findings

### C1. Direct pattern match on Scrollback.persist_privmsg result

**File:** `lib/grappa_web/controllers/messages_controller.ex:79`
**Category:** Error handling
**Severity:** HIGH

`{:ok, message} = Scrollback.persist_privmsg(...)` raises `MatchError`
on `{:error, %Ecto.Changeset{}}`. Identifier validation
(`Identifier.valid_network_id?`, `Identifier.valid_channel?`) at the
schema boundary will return changeset errors for malformed URL params,
and the direct match crashes the request before the wired-up
`FallbackController` (line 29-33, equipped to handle changeset errors)
can route it. Violates CLAUDE.md "`FallbackController` for `{:error, X}`
returns. Don't `case` on results in every action."

**Fix:** Wrap in `with`:

```elixir
def create(conn, %{"network_id" => network, "channel_id" => channel, "body" => body})
    when is_binary(body) and body != "" do
  with {:ok, message} <- Scrollback.persist_privmsg(network, channel, "<local>", body) do
    broadcast_message(network, channel, message)
    conn |> put_status(:created) |> render(:show, message: message)
  end
end
```

### C2. `@spec create/2` omits changeset error return

**File:** `lib/grappa_web/controllers/messages_controller.ex:76`
**Category:** Type specification
**Severity:** MEDIUM

Spec declares `Plug.Conn.t() | {:error, :bad_request}` but
`Scrollback.persist_privmsg/4` can return `{:error, Ecto.Changeset.t()}`
when validators reject input. Currently masked by the C1 crash; fixing
C1 exposes it. Same commit should fix both.

**Fix:**

```elixir
@spec create(Plug.Conn.t(), map()) ::
        Plug.Conn.t() | {:error, :bad_request} | {:error, Ecto.Changeset.t()}
```

### C3. `IRC.Client.handle_info/2` has no catch-all

**File:** `lib/grappa/irc/client.ex:146-150`
**Category:** Robustness
**Severity:** MEDIUM

Four explicit clauses for `:tcp`, `:ssl`, `:tcp_closed`, `:ssl_closed`
— a stray monitor `:DOWN`, a peer-crash artifact, or any other unsolicited
message into the mailbox raises `FunctionClauseError`. Session.Server
already has the catch-all pattern; Client should match for symmetry +
to log unexpected mailbox traffic instead of cascading a crash through
the linked Session.

**Fix:**

```elixir
def handle_info(msg, state) do
  Logger.warning("unexpected message", message: inspect(msg))
  {:noreply, state}
end
```

### C4. `.env.example` missing variables read by `runtime.exs`

**File:** `.env.example`
**Category:** Configuration documentation
**Severity:** MEDIUM

`config/runtime.exs` reads four env vars not documented in
`.env.example`: `DATABASE_PATH`, `POOL_SIZE`, `GRAPPA_CONFIG`,
`LOG_LEVEL`. CLAUDE.md enforces `.env.example ↔ runtime.exs symmetry`.
Operator can't discover overrides without grepping the source.

**Fix:** Add the four with placeholders + comments noting per-env
defaults.

### C5. `Scrollback.Meta` moduledoc inaccurate re atom normalization

**File:** `lib/grappa/scrollback/meta.ex:25-26`
**Category:** Documentation
**Severity:** LOW

Moduledoc claims the code "re-atomizes any known key via
`String.to_existing_atom/1`". The actual implementation
(`normalize_key/1`, lines 98-108) uses an `Enum.find` lookup against
the allowlist — safer than `String.to_existing_atom/1` (which depends
on whether the atom has been seen before, a load-order dependency).
Fix the doc to match.

---

## Trajectory

### What did we build recently?

Last 12 commits on main: Phase 1 Task 8 walking-skeleton round-trip
(IRC parser → Client → Session.Server → Bootstrap), live deploy on Pi
(S12), `/review` skill, `/review architecture` (S13), Phase 1.5
architecture-fix worktree merging 20 of 24 findings (S14), and the CP04
→ CP05 rotation. **Phase 1 walking-skeleton is end-to-end live**:
bouncer connects to Azzurra as `vjt-grappa`, autojoins `#grappa`,
persists PRIVMSG to sqlite, broadcasts via PubSub through the canonical
`Wire.message_event/1` shape, REST + WS round-trip both green.

### Does it serve the core mission?

**Yes — directly.** Mission per CLAUDE.md: always-on IRC bouncer + REST
+ Phoenix Channels real-time push, with downstream IRCv3 listener
facade in Phase 6. Every Phase 1.5 module name (`PubSub.Topic`, `Log`,
`Scrollback.Wire`, `IRC.Identifier`) is groundwork the Phase 6 listener
will consume verbatim. The wire-shape unification has been
production-verified; that's the load-bearing invariant for "two
facades, one store." No drift.

### What's stalling?

- **Phase 1 Tasks 9 + 10** are the only Phase-1-scope items left.
  Task 9 = REST writes mapped to `IRC.Client` outbound. Task 10 =
  `use Boundary` annotations + `mix boundary.spec` in CI (subsumes
  architecture-review A11). Neither is blocked.
- **`scripts/_lib.sh` compose project-name conflict** has been deferred
  three sessions running. The workaround (stop prod before running
  gates from a worktree) is tolerable per-incident but accumulates as
  friction.

### Observation items due?

Phase 5 hardening pile (`signing_salt` → `runtime.exs`,
`verify: :verify_none` → real CA chain, async `IRC.Client.connect` via
`{:continue, _}`, `Session.terminate/2` cleanup with QUIT, scrollback
eviction policy, reconnect/backoff, PromEx exporter) are all parked.
None observation-overdue — the trigger for Phase 5 is "Phase 2 auth
landing first" per CP05.

### Risk check

Low. The 1 HIGH is a single controller line trivially fixable in a
small follow-up. The 3 MEDIUMs are isolated. The Phase 1.5 cohesion
work held under audit — `lifecycle/` agent reporting zero findings on
the largest single module (`Session.Server`) plus its supervision
neighbors validates that the extraction worked. The LOW is cosmetic.

### Direction recommendation

**Bundle C1+C2+C3+C4+C5 into a single small worktree** (~30 lines
across 4 files, all well-bounded), commit + ci.check + merge + deploy,
then move directly to **Phase 1 Task 9** (REST writes → IRC.Client
outbound). Task 10 (Boundary annotations) follows naturally as the
final Phase 1 closeout. After that, Phase 2 auth opens.

The user's hypothesis was correct: architecture-tier work compounds.
The cost of fixing 24 architecture findings was 14 commits over one
session; the dividend is a codebase that returned 5 findings on first
line-level audit, with no CRITICAL, no structural drift, and the
largest module reporting clean. The next codebase review is due in
~12 sessions or 2 weeks; on current trajectory it should be cheaper
still.

---

## Stats

- 5 findings (1 HIGH, 3 MEDIUM, 1 LOW)
- 5 agents, 5 scopes, all parallel, ~3 minutes wall-clock
- 0 findings on `lifecycle/` (largest module by LOC)
- 1 HIGH localised to a single controller line
- Hypothesis "arch fixes reduce codebase findings" — confirmed
  (24 → 5 across one cohesion pass)
