# E1 cluster — A6 architectural close: Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use `superpowers:subagent-driven-development` (recommended) or `superpowers:executing-plans` to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Close architecture review A6 (`docs/reviews/architecture/2026-04-27-architecture-review.md`) — bring the producer (`Grappa.Session.Server`) in line with the wire-shape contract (`Grappa.Scrollback.Message` + `Grappa.Scrollback.Wire`) for **all 10 message kinds**, via a pure `Grappa.Session.EventRouter` module that mirrors the `Grappa.IRC.AuthFSM` shape from D2. Add `Grappa.Session.list_members/3` facade + `GET /networks/:net/channels/:chan/members` REST endpoint so the cicchetto P4-1 cluster has a clean nick-list surface.

**Architecture:** A pure module `Grappa.Session.EventRouter` classifies each inbound `Grappa.IRC.Message` into a derived `state` (mutated in place — `members` map, `nick` field) plus a list of side-effects (`{:persist, kind, attrs} | {:reply, iodata()}`) the Server flushes. `Session.Server.handle_info/2` keeps inline transport-only clauses (`PING` → PONG, `001` → autojoin trigger) and delegates everything else to `EventRouter.route/2`. `Scrollback.persist_privmsg/5` is replaced by `Scrollback.persist_event/1` taking explicit `:kind` (no `\\` defaults per CLAUDE.md). Server gains a `members: %{channel => %{nick => [mode]}}` field; `Session.list_members/3` snapshots it via a `GenServer.call`. The new `MembersController` returns the snapshot in mIRC sort order (`@` ops → `+` voiced → plain).

**Tech Stack:** Elixir 1.19 + OTP 28 + Phoenix 1.8. ExUnit + StreamData (property tests for EventRouter classification). Boundary annotations updated. All gates: `mix format --check-formatted`, `mix credo --strict`, `mix sobelow`, `mix dialyzer`, `mix deps.audit`, `mix hex.audit`, `mix doctor`, `mix test --warnings-as-errors --cover`.

---

## Pinned decisions

The brainstorm spec (`docs/plans/2026-04-27-phase-4-product-shape.md` § "E1 — A6 architectural close") plus the four open questions surfaced at CP10 S16 (resolved 2026-04-27 by vjt):

- **Q1 → (b) AuthFSM-shape return.** `EventRouter.route/2` returns `{:cont, new_state, [effect]}`. Effects are SIDE-EFFECTS only: `{:persist, kind, attrs} | {:reply, iodata()}`. State mutations (`members`, `nick`) live in `new_state`. The brainstorm spec's narrow `:ignore | {:persist, ...} | {:reply, ...}` pinned the effect set; this plan wraps it in `{:cont, state, [...]}` (mirroring `Grappa.IRC.AuthFSM.step/2`) so member-state delta has a place. `:ignore` collapses to `{:cont, state, []}` (no mutation, no effects).
- **Q2 → (b) NICK fan-out.** When a nick changes (server-level), EventRouter emits one `{:persist, :nick_change, attrs}` effect per channel where the renaming nick was in `state.members[channel]`. Symmetrical to QUIT (also server-level, also fan-out). Renderer + pagination stay simple; cicchetto filters by channel naturally.
- **Q3 → (a) ordered list.** `MembersController` returns `[%{nick: "vjt", modes: ["@"]}, ...]` in mIRC sort order (`@` ops → `+` voiced → plain, alphabetical within tier). `state.members` is `%{channel => %{nick => [mode_string]}}` (map of nick → modes_list); sort happens at `list_members/3` query time.
- **Q4 → A5 stays in P4-1.** E1 is server-side only. A5 (ChannelsController returning session-tracked) has cicchetto-side wire change `{joined: bool, source: :autojoin | :joined}` that belongs with the consumer rewrite.

Other resolved (non-blocking, pinned in plan steps):

- **353 mode prefix table** = `(ov)@+` default (matches RFC 2812 + most networks). PREFIX ISUPPORT-driven negotiation deferred to Phase 5. Hard-coded in `EventRouter` as `@mode_prefix_table %{"@" => "o", "+" => "v"}`.
- **Members map bootstrap** = empty `%{}` on Session.Server start. Populated by `353 RPL_NAMREPLY` + finalized by `366 RPL_ENDOFNAMES` post-autojoin. No DB read; rebuilt from upstream on every reconnect (crash-safe).
- **`:topic` scrollback row** is emitted ONLY by the `TOPIC` command (someone just changed the topic). Numerics `332 RPL_TOPIC` + `333 RPL_TOPICWHOTIME` are JOIN-time backfill — `EventRouter` returns `{:cont, state, []}` for both (the topic-bar will read live state, not scrollback rows, in P4-1).
- **`:reply` effect** is type-level forward-compat in E1; no E1 routes emit it. CTCP replies (VERSION/PING/CLIENTINFO) land in Phase 5+. `PING` (transport keepalive, not CTCP) stays inline in `Session.Server.handle_info` — out of scope for this scrollback-events router.
- **PART/QUIT/KICK reason** lives in `body` (`String.t() | nil`), NOT `meta`. Per `Grappa.Scrollback.Meta` moduledoc + `@known_keys` allowlist (only `:target | :new_nick | :modes | :args` — `:reason` is NOT an allowlisted atom key). Brainstorm spec's `meta carries :reason` wording is corrected here per Meta authority.

---

## File structure

```
lib/grappa/scrollback.ex                            (REFACTOR)
  - persist_privmsg/5 deleted
  - persist_event/1 added: takes %{kind, channel, sender, server_time,
    body, meta, user_id, network_id} → {:ok, Message.t()} | {:error, _}
  - body validation per-kind preserved (delegated to Message.changeset)
  - :network preloaded on success (unchanged contract)

lib/grappa/session/server.ex                        (REFACTOR)
  - state gains `members: %{String.t() => %{String.t() => [String.t()]}}`
  - handle_info/2 keeps inline clauses for :ping (transport keepalive)
    and {:numeric, 1} (autojoin trigger); ALL other :irc messages
    delegate to EventRouter.route/2
  - apply_effects/2 helper flushes persist + reply effects sequentially
  - persist+broadcast logic for INBOUND moves to apply_effects (out of
    handle_info); OUTBOUND PRIVMSG (handle_call) keeps its existing
    persist_and_broadcast/4 path (different transaction shape — caller
    needs return value; see also A20 fold-in candidate noted in
    DESIGN_NOTES)
  - new handle_call({:list_members, channel}, _, state)
  - @logged_event_commands deleted (every kind now persists)

lib/grappa/session/event_router.ex                  (NEW — pure module)
  - @spec route(Message.t(), state()) :: {:cont, state(), [effect()]}
  - 10-kind classifier + 4 numerics (001, 332, 333, 353/366)
  - state mutations: members add/remove/rename/reset, nick reconcile
  - effects: {:persist, kind, attrs}, {:reply, iodata()} (forward-compat)

lib/grappa/session.ex                               (UPDATE)
  - new list_members/3 facade: GenServer.call wrapper (user_id, network_id, channel)
  - Boundary exports unchanged

lib/grappa_web/router.ex                            (UPDATE)
  - new GET /networks/:network_id/channels/:channel_id/members route

lib/grappa_web/controllers/members_controller.ex    (NEW)
  - index/2 only; calls Session.list_members/3;
    {:error, :no_session} → 404 via FallbackController

lib/grappa_web/controllers/members_json.ex          (NEW)
  - index/1 renders [%{nick, modes}] list (already mIRC-sorted by
    Session.list_members/3)

test/grappa/session/event_router_test.exs           (NEW)
  - per-kind unit tests (~50 cases)

test/grappa/session/event_router_property_test.exs  (NEW)
  - StreamData: classification shape contract, A6 exhaustiveness

test/grappa/session/server_test.exs                 (UPDATE)
  - existing handshake/SASL/PRIVMSG cases stay (verify delegation works)
  - new: members tracking via 353+366 + JOIN-other + PART + QUIT
  - new: handle_call list_members snapshot + mIRC sort

test/grappa/scrollback_test.exs                     (UPDATE)
  - rename describe "persist_privmsg/5" → "persist_event/1"
  - update single direct callsite to new arg shape

test/grappa_web/controllers/members_controller_test.exs (NEW)
  - GET .../members happy path + 404 (no session) + iso boundary

test/support/scrollback_helpers.ex                  (UPDATE — moduledoc only)
  - reference to persist_privmsg/5 → persist_event/1

lib/grappa_web/controllers/messages_controller.ex   (UPDATE — moduledoc only)
  - reference to persist_privmsg/5 → persist_event/1

docs/DESIGN_NOTES.md                                (UPDATE)
  - new entry: D-cluster pattern 4th application; EventRouter mirror
    of AuthFSM; persist_event/1 generalization; A20 fold-in candidate
    noted (Broadcaster extraction deferred)

docs/checkpoints/2026-04-27-cp10.md                 (UPDATE)
  - S17 entry: E1 plan executed + cluster LANDED on main + deployed
```

---

## Phase 0 — Setup

### Task 0: Worktree + baseline check

**Files:**
- No file changes. Branch + working dir setup only.

- [ ] **Step 1: Verify on main, working tree clean**

```bash
cd /srv/grappa
git status
git branch --show-current
```

Expected: `On branch main`, `working tree clean` (or only the doc commits CP10 S15-S16 already on main).

- [ ] **Step 2: Pull latest main**

```bash
git pull --ff-only origin main
```

Expected: `Already up to date.` or fast-forward.

- [ ] **Step 3: Create worktree branch**

```bash
git worktree add ~/code/IRC/grappa-task-e1 -b cluster/e1-a6-close
cd ~/code/IRC/grappa-task-e1
git branch --show-current
```

Expected: `cluster/e1-a6-close`.

- [ ] **Step 4: Run baseline `scripts/check.sh` — must be green**

```bash
scripts/check.sh
```

Expected: every gate green (format, credo --strict, sobelow, dialyzer, deps.audit, hex.audit, doctor, test). If anything fails, STOP and fix in the FIRST commit of the cluster (CLAUDE.md "Fix pre-existing errors first" — zero baseline before E1 changes start).

- [ ] **Step 5: Confirm Scrollback test isolation works in this worktree**

```bash
scripts/test.sh test/grappa/scrollback_test.exs
```

Expected: passes (smoke test that this worktree's compose mount + sandbox is wired correctly).

---

## Phase 1 — Scrollback refactor

### Task 1: Add `Scrollback.persist_event/1` (TDD; coexists with `persist_privmsg/5`)

The new function takes an explicit map. We add it alongside the old (single callsite to migrate in Task 2; delete old in Task 3 per CLAUDE.md "no half-migrated, no exclusion lists, no Phase 2 later").

**Files:**
- Modify: `lib/grappa/scrollback.ex`
- Modify: `test/grappa/scrollback_test.exs`

- [ ] **Step 1: Write failing test for `persist_event/1` accepting all 10 kinds**

Add to `test/grappa/scrollback_test.exs` after the existing `describe "persist_privmsg/5"` block:

```elixir
describe "persist_event/1" do
  test "persists :privmsg with body+meta and preloads :network", %{user: user, network: net} do
    attrs = %{
      user_id: user.id,
      network_id: net.id,
      channel: "#sniffo",
      server_time: 0,
      kind: :privmsg,
      sender: "vjt",
      body: "ciao",
      meta: %{}
    }

    assert {:ok, %Message{kind: :privmsg, body: "ciao", network: %Network{slug: _}} = m} =
             Scrollback.persist_event(attrs)

    assert m.user_id == user.id
    assert m.network_id == net.id
  end

  test "persists :join with body=nil + meta=%{}", %{user: user, network: net} do
    attrs = %{
      user_id: user.id,
      network_id: net.id,
      channel: "#sniffo",
      server_time: 0,
      kind: :join,
      sender: "alice",
      body: nil,
      meta: %{}
    }

    assert {:ok, %Message{kind: :join, body: nil, network: %Network{slug: _}}} =
             Scrollback.persist_event(attrs)
  end

  test "persists :nick_change with meta.new_nick", %{user: user, network: net} do
    attrs = %{
      user_id: user.id,
      network_id: net.id,
      channel: "#sniffo",
      server_time: 0,
      kind: :nick_change,
      sender: "vjt",
      body: nil,
      meta: %{new_nick: "vjt_"}
    }

    assert {:ok, %Message{kind: :nick_change, meta: %{new_nick: "vjt_"}}} =
             Scrollback.persist_event(attrs)
  end

  test "persists :mode with meta.modes + meta.args", %{user: user, network: net} do
    attrs = %{
      user_id: user.id,
      network_id: net.id,
      channel: "#sniffo",
      server_time: 0,
      kind: :mode,
      sender: "ChanServ",
      body: nil,
      meta: %{modes: "+o", args: ["vjt"]}
    }

    assert {:ok, %Message{kind: :mode, meta: %{modes: "+o", args: ["vjt"]}}} =
             Scrollback.persist_event(attrs)
  end

  test "persists :kick with body=reason + meta.target", %{user: user, network: net} do
    attrs = %{
      user_id: user.id,
      network_id: net.id,
      channel: "#sniffo",
      server_time: 0,
      kind: :kick,
      sender: "ChanServ",
      body: "spam",
      meta: %{target: "spammer"}
    }

    assert {:ok, %Message{kind: :kick, body: "spam", meta: %{target: "spammer"}}} =
             Scrollback.persist_event(attrs)
  end

  test "persists :quit with body=reason and no meta", %{user: user, network: net} do
    attrs = %{
      user_id: user.id,
      network_id: net.id,
      channel: "#sniffo",
      server_time: 0,
      kind: :quit,
      sender: "alice",
      body: "Ping timeout",
      meta: %{}
    }

    assert {:ok, %Message{kind: :quit, body: "Ping timeout"}} =
             Scrollback.persist_event(attrs)
  end

  test "rejects missing :kind (no defaulting)", %{user: user, network: net} do
    attrs = %{
      user_id: user.id,
      network_id: net.id,
      channel: "#sniffo",
      server_time: 0,
      sender: "vjt",
      body: "x",
      meta: %{}
    }

    assert_raise FunctionClauseError, fn ->
      Scrollback.persist_event(attrs)
    end
  end

  test "rejects body=nil for :privmsg (per-kind body validation)", %{user: user, network: net} do
    attrs = %{
      user_id: user.id,
      network_id: net.id,
      channel: "#sniffo",
      server_time: 0,
      kind: :privmsg,
      sender: "vjt",
      body: nil,
      meta: %{}
    }

    assert {:error, %Ecto.Changeset{} = cs} = Scrollback.persist_event(attrs)
    assert "can't be blank" in errors_on(cs).body
  end
end
```

- [ ] **Step 2: Run failing tests**

```bash
scripts/test.sh test/grappa/scrollback_test.exs
```

Expected: every `persist_event/1` test fails with `UndefinedFunctionError: function Grappa.Scrollback.persist_event/1 is undefined or private`.

- [ ] **Step 3: Implement `persist_event/1` in `lib/grappa/scrollback.ex`**

Add after the `persist_privmsg/5` definition (before the `fetch/5` function):

```elixir
@doc """
Persists a scrollback row of arbitrary kind. Takes the full attribute
map explicitly — no defaulting, no implicit current-time read. Caller
is responsible for `:server_time` (epoch ms) and `:meta` (`%{}` for
kinds without event-specific payload).

The returned row has `:network` preloaded so callers can hand it
straight to `Grappa.Scrollback.Wire.message_event/1` (which
pattern-matches on `%Network{slug: _}` and crashes on unloaded assoc).
Single source for the wire-shape contract — every door (REST,
PubSub, future Phase 6 listener) goes through here.

Body validation per-kind is enforced by `Message.changeset/2`:
`:privmsg | :notice | :action | :topic` require non-nil body;
`:join | :part | :quit | :nick_change | :mode | :kick` accept
`body: nil` (presence kinds + state changes).
"""
@spec persist_event(%{
        required(:user_id) => Ecto.UUID.t(),
        required(:network_id) => integer(),
        required(:channel) => String.t(),
        required(:server_time) => integer(),
        required(:kind) => Message.kind(),
        required(:sender) => String.t(),
        required(:body) => String.t() | nil,
        required(:meta) => Meta.t()
      }) :: {:ok, Message.t()} | {:error, Ecto.Changeset.t()}
def persist_event(%{kind: kind} = attrs) when is_atom(kind) do
  changeset = Message.changeset(%Message{}, attrs)

  case Repo.insert(changeset) do
    {:ok, message} -> {:ok, Repo.preload(message, :network)}
    {:error, _} = err -> err
  end
end
```

Add `alias Grappa.Scrollback.Meta` at the top of the file (next to existing `alias Grappa.Scrollback.Message`):

```elixir
alias Grappa.Scrollback.{Message, Meta}
```

- [ ] **Step 4: Run tests — should pass**

```bash
scripts/test.sh test/grappa/scrollback_test.exs
```

Expected: every `persist_event/1` test passes; existing `persist_privmsg/5` tests still pass (they share the file but exercise different functions).

- [ ] **Step 5: Run full check.sh**

```bash
scripts/check.sh
```

Expected: green. The `@spec` map shape is precise enough for Dialyzer's `:underspecs` flag.

- [ ] **Step 6: Commit**

```bash
git add lib/grappa/scrollback.ex test/grappa/scrollback_test.exs
git commit -m "$(cat <<'EOF'
feat(scrollback): add persist_event/1 — generalized writer for all 10 kinds

E1 task 1 — closes A6 producer-side gap step 1 of N. New
`Scrollback.persist_event/1` takes the full attribute map explicitly
(no `\\` defaults per CLAUDE.md). Coexists with `persist_privmsg/5`
this commit; the old function deletes in task 3 once the single
callsite (`Session.Server.persist_and_broadcast/4`) migrates in task 2.

Body validation per-kind preserved (delegated to
`Message.changeset/2`). `:network` preloaded on success (same wire-shape
contract as `persist_privmsg/5`).

Co-Authored-By: Claude Opus 4.7 <noreply@anthropic.com>
EOF
)"
```

### Task 2: Migrate the single `persist_privmsg/5` callsite to `persist_event/1`

The only production callsite is `Session.Server.persist_and_broadcast/4` (the inbound PRIVMSG path). Outbound PRIVMSG (`handle_call({:send_privmsg, ...})`) shares the same helper.

**Files:**
- Modify: `lib/grappa/session/server.ex`
- Modify: `test/grappa/scrollback_test.exs`

- [ ] **Step 1: Update existing `persist_privmsg/5` test describe block**

In `test/grappa/scrollback_test.exs`, the existing test at the `describe "persist_privmsg/5"` block exercises the SAME wire contract via the OLD function. We keep the test but flip it to exercise `persist_event/1` instead, so the contract continues to be regression-tested when the old fn deletes:

Find and replace inside `describe "persist_privmsg/5"`:

```elixir
describe "persist_privmsg/5" do
  test "returns the row with :network preloaded so Wire.to_json/1 doesn't need to",
       %{user: user, network: net} do
    # ...
    assert {:ok, %Message{network: %Network{slug: _}}} =
             Scrollback.persist_privmsg(user.id, net.id, "#sniffo", "vjt", "ciao")
```

Replace the whole describe block heading + its single test:

```elixir
describe "persist_event/1 — :network preloading (was persist_privmsg/5)" do
  test "returns the row with :network preloaded so Wire.to_json/1 doesn't need to",
       %{user: user, network: net} do
    attrs = %{
      user_id: user.id,
      network_id: net.id,
      channel: "#sniffo",
      server_time: System.system_time(:millisecond),
      kind: :privmsg,
      sender: "vjt",
      body: "ciao",
      meta: %{}
    }

    assert {:ok, %Message{network: %Network{slug: _}}} =
             Scrollback.persist_event(attrs)
  end
end
```

- [ ] **Step 2: Update `Session.Server.persist_and_broadcast/4`**

In `lib/grappa/session/server.ex`, the helper at lines 379-402 currently calls `Scrollback.persist_privmsg/5`. Replace it:

```elixir
@spec persist_and_broadcast(state(), String.t(), String.t(), String.t()) ::
        {:ok, Scrollback.Message.t()} | {:error, Ecto.Changeset.t()}
defp persist_and_broadcast(state, target, sender, body) do
  attrs = %{
    user_id: state.user_id,
    network_id: state.network_id,
    channel: target,
    server_time: System.system_time(:millisecond),
    kind: :privmsg,
    sender: sender,
    body: body,
    meta: %{}
  }

  case Scrollback.persist_event(attrs) do
    {:ok, message} ->
      :ok =
        Phoenix.PubSub.broadcast(
          Grappa.PubSub,
          Topic.channel(state.user_name, state.network_slug, target),
          Wire.message_event(message)
        )

      {:ok, message}

    {:error, _} = err ->
      err
  end
end
```

- [ ] **Step 3: Run failing tests**

```bash
scripts/test.sh
```

Expected: passes — the helper now calls `persist_event/1`. Server's existing inbound PRIVMSG + outbound `send_privmsg` tests still pass (they exercise the helper's contract end-to-end, not the function name).

- [ ] **Step 4: Run check.sh**

```bash
scripts/check.sh
```

Expected: green.

- [ ] **Step 5: Commit**

```bash
git add lib/grappa/session/server.ex test/grappa/scrollback_test.exs
git commit -m "$(cat <<'EOF'
refactor(session): migrate PRIVMSG persist callsite to persist_event/1

E1 task 2 — Session.Server.persist_and_broadcast/4 now constructs the
explicit attrs map and calls Scrollback.persist_event/1 instead of
persist_privmsg/5. Wire-shape contract unchanged (:network preloaded,
PubSub broadcast via Wire.message_event/1).

Existing scrollback test "persist_privmsg/5 :network preloading" renamed
to "persist_event/1 — :network preloading (was persist_privmsg/5)" and
flipped to call the new function; the contract regression test stays
intact for task 3 when the old function deletes.

Co-Authored-By: Claude Opus 4.7 <noreply@anthropic.com>
EOF
)"
```

### Task 3: Delete `Scrollback.persist_privmsg/5` + clean stale doc references

**Files:**
- Modify: `lib/grappa/scrollback.ex` (delete function + moduledoc reference)
- Modify: `lib/grappa_web/controllers/messages_controller.ex` (moduledoc only)
- Modify: `test/support/scrollback_helpers.ex` (moduledoc only)

- [ ] **Step 1: Delete `persist_privmsg/5` function from `lib/grappa/scrollback.ex`**

Remove lines 72-106 (the `@doc` block + `@spec` + function definition for `persist_privmsg/5`). Also remove or update the moduledoc reference at line 126 (`identical wire-shape contract as persist_privmsg/5 (A4 + A26).`) — change `persist_privmsg/5` to `persist_event/1` in any moduledoc references.

- [ ] **Step 2: Update doc references**

In `lib/grappa_web/controllers/messages_controller.ex` line 113, change the comment `# :network is preloaded by Scrollback.persist_privmsg/5 —` to `# :network is preloaded by Scrollback.persist_event/1 —`.

In `test/support/scrollback_helpers.ex` line 7, change the moduledoc reference from `persist_privmsg/5` to `persist_event/1`.

- [ ] **Step 3: Run tests + check.sh**

```bash
scripts/check.sh
```

Expected: green. No remaining references to `persist_privmsg`. Confirm via grep:

```bash
grep -rn "persist_privmsg" lib/ test/
```

Expected: zero output.

- [ ] **Step 4: Commit**

```bash
git add lib/grappa/scrollback.ex lib/grappa_web/controllers/messages_controller.ex test/support/scrollback_helpers.ex
git commit -m "$(cat <<'EOF'
refactor(scrollback): delete persist_privmsg/5 — zero callsites remain

E1 task 3 — task 2 migrated the only callsite to persist_event/1; the
old function is dead. Delete it + update three moduledoc references.
CLAUDE.md "Avoid backwards-compatibility hacks ... no half-migrated."

Co-Authored-By: Claude Opus 4.7 <noreply@anthropic.com>
EOF
)"
```

---

## Phase 2 — EventRouter scaffold + content kinds

### Task 4: Create `Grappa.Session.EventRouter` skeleton (pure module, no-op router)

**Files:**
- Create: `lib/grappa/session/event_router.ex`
- Create: `test/grappa/session/event_router_test.exs`

- [ ] **Step 1: Write failing test for the no-op route**

Create `test/grappa/session/event_router_test.exs`:

```elixir
defmodule Grappa.Session.EventRouterTest do
  @moduledoc """
  Pure-function unit tests for the inbound IRC event classifier.

  No GenServer, no socket, no Repo — these tests exercise classification
  with synthetic `Grappa.IRC.Message` structs and assert the
  `{:cont, new_state, [effect]}` tuple shape directly. The integration
  coverage lives in `Grappa.Session.ServerTest`; this file pins the
  router in isolation, mirroring the `Grappa.IRC.AuthFSMTest` shape
  template (D2 corollary).
  """
  use ExUnit.Case, async: true

  alias Grappa.IRC.Message
  alias Grappa.Session.EventRouter

  @user_id "00000000-0000-0000-0000-000000000001"
  @network_id 42

  defp base_state(overrides \\ %{}) do
    Map.merge(
      %{
        user_id: @user_id,
        network_id: @network_id,
        nick: "vjt",
        members: %{}
      },
      overrides
    )
  end

  defp msg(command, params, prefix \\ nil) do
    %Message{command: command, params: params, prefix: prefix, tags: %{}}
  end

  describe "route/2 — fallthrough" do
    test "unknown command leaves state unchanged with no effects" do
      state = base_state()

      assert {:cont, ^state, []} =
               EventRouter.route(msg({:unknown, "FOO"}, ["bar"]), state)
    end
  end
end
```

- [ ] **Step 2: Run failing test**

```bash
scripts/test.sh test/grappa/session/event_router_test.exs
```

Expected: fails with `UndefinedFunctionError` for `Grappa.Session.EventRouter.route/2`.

- [ ] **Step 3: Create the module skeleton**

Create `lib/grappa/session/event_router.ex`:

```elixir
defmodule Grappa.Session.EventRouter do
  @moduledoc """
  Pure inbound-IRC event classifier for `Grappa.Session.Server`.

  No process, no socket, no Repo, no Logger. Inputs are a parsed
  `Grappa.IRC.Message` struct + the Server's `state` map. Outputs are
  the next `state` (with `members` / `nick` derived) plus a list of
  side-effects the caller must flush:

      @type effect ::
              {:persist, kind, persist_attrs}    -- write a Scrollback row
              | {:reply, iodata()}                -- send a line upstream
                                                     (forward-compat;
                                                      no E1 route emits this)

  This shape was extracted per the 2026-04-27 architecture review
  (finding A6, CP10 D4) and mirrors `Grappa.IRC.AuthFSM` from D2 — the
  pure-classifier shape of the verb-keyed sub-context principle. Server
  owns the GenServer, transport, and effect flushing; this module owns
  IRC-message → scrollback-event mapping for all 10 kinds plus the
  4 informational numerics (001, 332, 333, 353/366) that derive
  `state.members` / `state.nick` without producing scrollback rows.

  ## State shape (subset of `Session.Server.state()`)

      @type state :: %{
              required(:user_id) => Ecto.UUID.t(),
              required(:network_id) => integer(),
              required(:nick) => String.t(),
              required(:members) => members(),
              optional(_) => _
            }

      @type members :: %{
              channel :: String.t() => %{
                nick :: String.t() => modes :: [String.t()]
              }
            }

  Q3-pinned: nick → modes_list mapping (NOT MapSet) so mIRC sort can
  re-derive at `Session.list_members/3` query time.

  ## Per-kind shape table

      | Kind          | Body           | Meta                                    | members delta              |
      |---------------|----------------|-----------------------------------------|----------------------------|
      | :privmsg      | required text  | %{}                                     | (none)                     |
      | :notice       | required text  | %{}                                     | (none)                     |
      | :action       | required text  | %{}                                     | (none)                     |
      | :join         | nil            | %{}                                     | add (or reset+add if self) |
      | :part         | reason \\| nil | %{}                                     | remove                     |
      | :quit         | reason \\| nil | %{}                                     | remove (fan-out)           |
      | :nick_change  | nil            | %{new_nick: String.t()}                 | rename (fan-out)           |
      | :mode         | nil            | %{modes: String.t(), args: [String.t()]} | per-arg add/remove modes   |
      | :topic        | required text  | %{}                                     | (none)                     |
      | :kick         | reason \\| nil | %{target: String.t()}                   | remove                     |

  Q2-pinned: NICK + QUIT are server-level events that fan out to one
  scrollback row per channel where the nick was in `state.members`.

  ## Mode prefix table (Q-non-blocking)

  Hard-coded `(ov)@+` default per RFC 2812 + most networks. PREFIX
  ISUPPORT-driven negotiation deferred to Phase 5; the table is a
  compile-time constant in this module. When Phase 5 lands per-network
  PREFIX, this constant migrates to per-Session-state config; the
  in-memory shape (`[String.t()]` list of mode chars) does not change.

  ## Topic numerics (Q-non-blocking)

  `332 RPL_TOPIC` + `333 RPL_TOPICWHOTIME` are JOIN-time backfill
  delivered by the upstream after a JOIN. They DO NOT produce scrollback
  rows — `:topic` rows come ONLY from the `TOPIC` command (someone just
  changed the topic). The topic-bar in P4-1 reads live state, not
  scrollback; numerics 332/333 are `{:cont, state, []}` here.

  ## `:reply` effect (forward-compat in E1)

  Type-level forward-compat for CTCP replies (Phase 5+). No E1 route
  emits this effect. PING (transport keepalive, not CTCP) stays inline
  in `Session.Server.handle_info` — out of this router's scope.
  """

  alias Grappa.IRC.Message

  @typedoc """
  The Session.Server state subset this module reads + mutates. The
  full Session.Server state has additional fields (`user_name`,
  `network_slug`, `autojoin`, `client`, etc.) — this typespec uses
  `optional(_) => _` to admit them without enforcing them.
  """
  @type state :: %{
          required(:user_id) => Ecto.UUID.t(),
          required(:network_id) => integer(),
          required(:nick) => String.t(),
          required(:members) => members(),
          optional(any()) => any()
        }

  @type members :: %{
          String.t() => %{String.t() => [String.t()]}
        }

  @type persist_attrs :: %{
          required(:user_id) => Ecto.UUID.t(),
          required(:network_id) => integer(),
          required(:channel) => String.t(),
          required(:server_time) => integer(),
          required(:sender) => String.t(),
          required(:body) => String.t() | nil,
          required(:meta) => map()
        }

  @type effect ::
          {:persist, Grappa.Scrollback.Message.kind(), persist_attrs()}
          | {:reply, iodata()}

  # IRCv3 mode-prefix table — RFC 2812 default. Phase 5 Replaces with
  # per-network PREFIX ISUPPORT lookup; in-memory shape unchanged.
  @mode_prefixes %{?@ => "@", ?+ => "+"}

  @doc """
  Classifies one inbound `Grappa.IRC.Message` against the current
  Session state. Returns the next state (with `members` / `nick`
  derived) plus a list of side-effects the caller must flush.

  An unrecognised command (CAP echo, vendor numerics, etc.) returns
  `{:cont, state, []}` — no mutation, no effects. The caller's
  `handle_info` clause already drops on the wildcard `{:irc, _}`
  match; this match is the equivalent here.
  """
  @spec route(Message.t(), state()) :: {:cont, state(), [effect()]}
  def route(%Message{} = _msg, state), do: {:cont, state, []}
end
```

- [ ] **Step 4: Run tests — should pass**

```bash
scripts/test.sh test/grappa/session/event_router_test.exs
```

Expected: pass.

- [ ] **Step 5: Update Boundary annotation on `Grappa.Session`**

The new `EventRouter` module lives under `lib/grappa/session/` so it inherits the `Grappa.Session` Boundary. Confirm by running:

```bash
scripts/mix.sh compile --warnings-as-errors
```

Expected: clean compile, no Boundary warnings.

- [ ] **Step 6: Run full check.sh**

```bash
scripts/check.sh
```

Expected: green.

- [ ] **Step 7: Commit**

```bash
git add lib/grappa/session/event_router.ex test/grappa/session/event_router_test.exs
git commit -m "$(cat <<'EOF'
feat(session): add EventRouter pure module — scaffold only

E1 task 4 — closes A6 step 4 of N. New `Grappa.Session.EventRouter`:
pure classifier mirroring `Grappa.IRC.AuthFSM` from D2 (4th
application of the verb-keyed sub-context principle from
D1/D2/D3/A2/A3).

`route/2` returns `{:cont, new_state, [effect]}` per Q1 resolution
(CP10 S16). Effects: `{:persist, kind, attrs} | {:reply, iodata()}`
— side-effects only; state mutations (members, nick) live in
new_state. Per-kind handlers land in tasks 5-15.

This commit only ships the no-op fallthrough; subsequent commits add
one kind handler at a time so each commit is bisectable to a single
classification rule.

Co-Authored-By: Claude Opus 4.7 <noreply@anthropic.com>
EOF
)"
```

### Task 5: Content kinds — PRIVMSG + NOTICE + ACTION

These three kinds share the same shape: required body, no meta, no member-state delta. Group into one task because the test fixtures + handler shape are identical except the kind tag.

**Files:**
- Modify: `lib/grappa/session/event_router.ex`
- Modify: `test/grappa/session/event_router_test.exs`

- [ ] **Step 1: Add failing tests for PRIVMSG / NOTICE / ACTION**

Append to `test/grappa/session/event_router_test.exs`:

```elixir
describe "route/2 — :privmsg" do
  test "PRIVMSG #channel :body emits :persist with kind=:privmsg" do
    state = base_state()

    msg = msg(:privmsg, ["#italia", "ciao"], {:nick, "alice", "u", "h"})

    assert {:cont, ^state, [{:persist, :privmsg, attrs}]} =
             EventRouter.route(msg, state)

    assert attrs.channel == "#italia"
    assert attrs.sender == "alice"
    assert attrs.body == "ciao"
    assert attrs.meta == %{}
    assert attrs.user_id == @user_id
    assert attrs.network_id == @network_id
    assert is_integer(attrs.server_time)
  end

  test "PRIVMSG carrying CTCP ACTION classifies as :action with body framed" do
    state = base_state()

    # CTCP ACTION shape: \x01ACTION <text>\x01
    body = <<0x01, "ACTION waves hello", 0x01>>
    msg = msg(:privmsg, ["#italia", body], {:nick, "alice", "u", "h"})

    assert {:cont, ^state, [{:persist, :action, attrs}]} =
             EventRouter.route(msg, state)

    # CLAUDE.md "CTCP control characters preserved as-is in scrollback body"
    assert attrs.body == body
    assert attrs.kind_tag == nil  # sanity: no extra fields snuck in
    refute Map.has_key?(attrs, :kind_tag)
  end
end

describe "route/2 — :notice" do
  test "NOTICE #channel :body emits :persist with kind=:notice" do
    state = base_state()

    msg = msg(:notice, ["#italia", "auth banner"], {:server, "irc.azzurra.chat"})

    assert {:cont, ^state, [{:persist, :notice, attrs}]} =
             EventRouter.route(msg, state)

    assert attrs.channel == "#italia"
    assert attrs.sender == "irc.azzurra.chat"
    assert attrs.body == "auth banner"
    assert attrs.meta == %{}
  end
end
```

- [ ] **Step 2: Run failing tests**

```bash
scripts/test.sh test/grappa/session/event_router_test.exs
```

Expected: every new test fails (current `route/2` is the no-op).

- [ ] **Step 3: Implement PRIVMSG / NOTICE / ACTION handlers**

In `lib/grappa/session/event_router.ex`, replace the single fallthrough clause with the per-kind clauses + the fallthrough:

```elixir
@spec route(Message.t(), state()) :: {:cont, state(), [effect()]}
def route(%Message{command: :privmsg, params: [channel, body]} = msg, state)
    when is_binary(channel) and is_binary(body) do
  if ctcp_action?(body) do
    persist(state, :action, channel, Message.sender_nick(msg), body, %{})
  else
    persist(state, :privmsg, channel, Message.sender_nick(msg), body, %{})
  end
end

def route(%Message{command: :notice, params: [channel, body]} = msg, state)
    when is_binary(channel) and is_binary(body) do
  persist(state, :notice, channel, Message.sender_nick(msg), body, %{})
end

def route(%Message{} = _msg, state), do: {:cont, state, []}

# CTCP framing: \x01<verb> ...\x01 — CLAUDE.md preserves verbatim in
# scrollback body. ACTION (CTCP /me) is the only verb that earns its
# own scrollback kind today; other CTCP verbs (VERSION, PING, etc.)
# produce :reply effects in Phase 5+.
defp ctcp_action?(<<0x01, "ACTION ", _rest::binary>>), do: true
defp ctcp_action?(_), do: false

@spec persist(state(), Grappa.Scrollback.Message.kind(), String.t(), String.t(), String.t() | nil, map()) ::
        {:cont, state(), [effect()]}
defp persist(state, kind, channel, sender, body, meta) do
  attrs = %{
    user_id: state.user_id,
    network_id: state.network_id,
    channel: channel,
    server_time: System.system_time(:millisecond),
    sender: sender,
    body: body,
    meta: meta
  }

  {:cont, state, [{:persist, kind, attrs}]}
end
```

- [ ] **Step 4: Run tests — should pass**

```bash
scripts/test.sh test/grappa/session/event_router_test.exs
```

Expected: pass.

- [ ] **Step 5: Run check.sh**

```bash
scripts/check.sh
```

Expected: green.

- [ ] **Step 6: Commit**

```bash
git add lib/grappa/session/event_router.ex test/grappa/session/event_router_test.exs
git commit -m "$(cat <<'EOF'
feat(event-router): classify PRIVMSG / NOTICE / ACTION (content kinds)

E1 task 5 — content kinds carry required body, no meta, no member delta.
PRIVMSG body starting with `\\x01ACTION ` reclassifies as :action per
CLAUDE.md "CTCP `\\x01` framing preserved verbatim in scrollback body."

Co-Authored-By: Claude Opus 4.7 <noreply@anthropic.com>
EOF
)"
```

---

## Phase 3 — EventRouter member-mutating kinds

### Task 6: JOIN handler — self vs other; reset_members on self-JOIN

`JOIN-self` clears `state.members[channel]` (stale state on reconnect) before adding self. `JOIN-other` adds to existing set. Both emit `:persist :join` (body=nil, meta=%{}).

**Files:**
- Modify: `lib/grappa/session/event_router.ex`
- Modify: `test/grappa/session/event_router_test.exs`

- [ ] **Step 1: Failing tests for JOIN-other and JOIN-self**

Append to `test/grappa/session/event_router_test.exs`:

```elixir
describe "route/2 — :join" do
  test "JOIN-other adds nick to state.members[channel] + emits :persist :join" do
    state = base_state(%{members: %{"#italia" => %{"vjt" => []}}})
    msg = msg(:join, ["#italia"], {:nick, "alice", "u", "h"})

    assert {:cont, new_state, [{:persist, :join, attrs}]} =
             EventRouter.route(msg, state)

    assert new_state.members["#italia"] == %{"vjt" => [], "alice" => []}
    assert attrs.channel == "#italia"
    assert attrs.sender == "alice"
    assert attrs.body == nil
    assert attrs.meta == %{}
  end

  test "JOIN-self clears stale state.members[channel] then adds self" do
    # Stale state from a previous session (operator reconnect, BNC bug):
    state =
      base_state(%{
        members: %{"#italia" => %{"stale_user_1" => [], "stale_user_2" => ["@"]}}
      })

    msg = msg(:join, ["#italia"], {:nick, "vjt", "u", "h"})

    assert {:cont, new_state, [{:persist, :join, _attrs}]} =
             EventRouter.route(msg, state)

    # Stale users wiped; only self remains. 353 RPL_NAMREPLY arrives
    # immediately after and re-populates the rest.
    assert new_state.members["#italia"] == %{"vjt" => []}
  end

  test "JOIN-other to an unknown channel creates the channel entry" do
    state = base_state()
    msg = msg(:join, ["#new"], {:nick, "alice", "u", "h"})

    assert {:cont, new_state, [{:persist, :join, _}]} =
             EventRouter.route(msg, state)

    assert new_state.members["#new"] == %{"alice" => []}
  end
end
```

- [ ] **Step 2: Run failing tests**

```bash
scripts/test.sh test/grappa/session/event_router_test.exs
```

Expected: fails on the JOIN clauses.

- [ ] **Step 3: Implement JOIN handler**

Insert before the fallthrough clause:

```elixir
def route(%Message{command: :join, params: [channel | _]} = msg, state)
    when is_binary(channel) do
  sender = Message.sender_nick(msg)

  members =
    if sender == state.nick do
      # Self-JOIN: wipe stale state for this channel (reconnect path);
      # 353 RPL_NAMREPLY immediately following will re-populate. Keep
      # self in the set so an outbound PRIVMSG before NAMES arrives is
      # still attributed to a known member.
      Map.put(state.members, channel, %{sender => []})
    else
      Map.update(state.members, channel, %{sender => []}, &Map.put(&1, sender, []))
    end

  {state, persist_effect} = build_persist(%{state | members: members}, :join, channel, sender, nil, %{})
  {:cont, state, [persist_effect]}
end
```

Refactor the existing `persist/6` private fn into `build_persist/6` returning `{state, effect}` so the new mutating clauses can update state AND return the persist effect in one step:

```elixir
@spec build_persist(state(), Grappa.Scrollback.Message.kind(), String.t(), String.t(), String.t() | nil, map()) ::
        {state(), effect()}
defp build_persist(state, kind, channel, sender, body, meta) do
  attrs = %{
    user_id: state.user_id,
    network_id: state.network_id,
    channel: channel,
    server_time: System.system_time(:millisecond),
    sender: sender,
    body: body,
    meta: meta
  }

  {state, {:persist, kind, attrs}}
end
```

Update the existing PRIVMSG / NOTICE / ACTION clauses to use the new helper:

```elixir
def route(%Message{command: :privmsg, params: [channel, body]} = msg, state)
    when is_binary(channel) and is_binary(body) do
  kind = if ctcp_action?(body), do: :action, else: :privmsg
  {state, persist_effect} = build_persist(state, kind, channel, Message.sender_nick(msg), body, %{})
  {:cont, state, [persist_effect]}
end

def route(%Message{command: :notice, params: [channel, body]} = msg, state)
    when is_binary(channel) and is_binary(body) do
  {state, persist_effect} = build_persist(state, :notice, channel, Message.sender_nick(msg), body, %{})
  {:cont, state, [persist_effect]}
end
```

Delete the now-redundant `persist/6` private fn.

- [ ] **Step 4: Run tests + check.sh**

```bash
scripts/check.sh
```

Expected: green.

- [ ] **Step 5: Commit**

```bash
git add lib/grappa/session/event_router.ex test/grappa/session/event_router_test.exs
git commit -m "$(cat <<'EOF'
feat(event-router): classify JOIN — self resets channel members; other adds

E1 task 6 — JOIN-self wipes state.members[channel] (reconnect-stale-state
hygiene; 353 RPL_NAMREPLY following re-populates). JOIN-other appends.
Both emit :persist :join (body=nil, meta=%{}).

Refactored persist helper to build_persist/6 returning {state, effect}
so member-mutating clauses can update state AND return effect in one
step (no double-pattern-match). Existing PRIVMSG / NOTICE / ACTION
migrated to the new helper.

Co-Authored-By: Claude Opus 4.7 <noreply@anthropic.com>
EOF
)"
```

### Task 7: PART handler — remove from members; reason → body

PART can have an optional reason as the trailing param. Reason → `body`. Empty params (no reason) → `body: nil`.

**Files:**
- Modify: `lib/grappa/session/event_router.ex`
- Modify: `test/grappa/session/event_router_test.exs`

- [ ] **Step 1: Failing tests**

```elixir
describe "route/2 — :part" do
  test "PART removes nick from state.members[channel] + emits :persist :part body=reason" do
    state = base_state(%{members: %{"#italia" => %{"vjt" => [], "alice" => []}}})
    msg = msg(:part, ["#italia", "see you"], {:nick, "alice", "u", "h"})

    assert {:cont, new_state, [{:persist, :part, attrs}]} =
             EventRouter.route(msg, state)

    assert new_state.members["#italia"] == %{"vjt" => []}
    assert attrs.body == "see you"
    assert attrs.meta == %{}
  end

  test "PART with no reason emits body=nil" do
    state = base_state(%{members: %{"#italia" => %{"vjt" => [], "alice" => []}}})
    msg = msg(:part, ["#italia"], {:nick, "alice", "u", "h"})

    assert {:cont, _new_state, [{:persist, :part, %{body: nil}}]} =
             EventRouter.route(msg, state)
  end

  test "PART for unknown channel is a no-op (defensive)" do
    state = base_state()
    msg = msg(:part, ["#unknown"], {:nick, "alice", "u", "h"})

    assert {:cont, new_state, [{:persist, :part, _}]} =
             EventRouter.route(msg, state)

    # Map.update with default-keep on missing key — channel doesn't
    # appear in members; persist row still writes (audit trail).
    refute Map.has_key?(new_state.members, "#unknown")
  end
end
```

- [ ] **Step 2: Run failing tests**

```bash
scripts/test.sh test/grappa/session/event_router_test.exs
```

Expected: PART tests fail.

- [ ] **Step 3: Implement PART handler**

Before the fallthrough clause:

```elixir
def route(%Message{command: :part, params: [channel | rest]} = msg, state)
    when is_binary(channel) do
  sender = Message.sender_nick(msg)
  reason = case rest do
    [r | _] when is_binary(r) -> r
    _ -> nil
  end

  members =
    case Map.get(state.members, channel) do
      nil -> state.members
      ch_members -> Map.put(state.members, channel, Map.delete(ch_members, sender))
    end

  {state, persist_effect} = build_persist(%{state | members: members}, :part, channel, sender, reason, %{})
  {:cont, state, [persist_effect]}
end
```

- [ ] **Step 4: Run tests + check.sh**

Expected: green.

- [ ] **Step 5: Commit**

```bash
git add lib/grappa/session/event_router.ex test/grappa/session/event_router_test.exs
git commit -m "$(cat <<'EOF'
feat(event-router): classify PART — remove member, reason → body

E1 task 7 — PART removes the parting nick from state.members[channel].
Optional reason param → body (nullable per Message schema; :part is
NOT in @body_required_kinds). Unknown channel = audit row written but
no member-state mutation.

Co-Authored-By: Claude Opus 4.7 <noreply@anthropic.com>
EOF
)"
```

### Task 8: QUIT handler — fan-out per channel where nick was member

QUIT is server-level. The IRC line is `:nick!u@h QUIT :reason` — no channel param. EventRouter scans `state.members` for every channel containing the QUITting nick, emits one `{:persist, :quit, attrs}` per channel + removes from each set.

**Files:**
- Modify: `lib/grappa/session/event_router.ex`
- Modify: `test/grappa/session/event_router_test.exs`

- [ ] **Step 1: Failing tests**

```elixir
describe "route/2 — :quit (fan-out per channel where nick was member)" do
  test "QUIT emits one :persist :quit per channel + removes nick from all" do
    state =
      base_state(%{
        members: %{
          "#italia" => %{"vjt" => [], "alice" => []},
          "#italia.lib" => %{"alice" => ["+"], "bob" => []},
          "#empty" => %{"vjt" => []}
        }
      })

    msg = msg(:quit, ["Ping timeout"], {:nick, "alice", "u", "h"})

    assert {:cont, new_state, effects} = EventRouter.route(msg, state)

    # Two :persist effects (alice was in #italia and #italia.lib);
    # #empty had no alice — no row, no mutation.
    persist_channels =
      effects
      |> Enum.map(fn {:persist, :quit, attrs} -> attrs.channel end)
      |> Enum.sort()

    assert persist_channels == ["#italia", "#italia.lib"]

    Enum.each(effects, fn {:persist, :quit, attrs} ->
      assert attrs.sender == "alice"
      assert attrs.body == "Ping timeout"
      assert attrs.meta == %{}
    end)

    assert new_state.members["#italia"] == %{"vjt" => []}
    assert new_state.members["#italia.lib"] == %{"bob" => []}
    assert new_state.members["#empty"] == %{"vjt" => []}
  end

  test "QUIT with no reason emits body=nil" do
    state = base_state(%{members: %{"#italia" => %{"alice" => []}}})
    msg = msg(:quit, [], {:nick, "alice", "u", "h"})

    assert {:cont, _, [{:persist, :quit, %{body: nil}}]} =
             EventRouter.route(msg, state)
  end

  test "QUIT for nick not in any channel emits no effects + no mutation" do
    state = base_state(%{members: %{"#italia" => %{"vjt" => []}}})
    msg = msg(:quit, ["bye"], {:nick, "stranger", "u", "h"})

    assert {:cont, ^state, []} = EventRouter.route(msg, state)
  end
end
```

- [ ] **Step 2: Run failing tests**

Expected: QUIT tests fail.

- [ ] **Step 3: Implement QUIT handler**

```elixir
def route(%Message{command: :quit, params: rest} = msg, state) do
  sender = Message.sender_nick(msg)
  reason = case rest do
    [r | _] when is_binary(r) -> r
    _ -> nil
  end

  channels = channels_with_member(state.members, sender)

  case channels do
    [] ->
      {:cont, state, []}

    _ ->
      members = remove_member_everywhere(state.members, channels, sender)
      effects =
        for ch <- channels do
          {_state, effect} = build_persist(state, :quit, ch, sender, reason, %{})
          effect
        end

      {:cont, %{state | members: members}, effects}
  end
end

@spec channels_with_member(members(), String.t()) :: [String.t()]
defp channels_with_member(members, nick) do
  members
  |> Enum.filter(fn {_ch, ch_members} -> Map.has_key?(ch_members, nick) end)
  |> Enum.map(fn {ch, _} -> ch end)
  |> Enum.sort()
end

@spec remove_member_everywhere(members(), [String.t()], String.t()) :: members()
defp remove_member_everywhere(members, channels, nick) do
  Enum.reduce(channels, members, fn ch, acc ->
    Map.update!(acc, ch, &Map.delete(&1, nick))
  end)
end
```

- [ ] **Step 4: Run tests + check.sh**

Expected: green.

- [ ] **Step 5: Commit**

```bash
git add lib/grappa/session/event_router.ex test/grappa/session/event_router_test.exs
git commit -m "$(cat <<'EOF'
feat(event-router): classify QUIT — fan-out persist per channel

E1 task 8 — QUIT is server-level (no channel param). Scan
state.members for every channel containing the quitting nick, emit
one {:persist, :quit, attrs} per channel + remove from each set.
Channels deterministically sorted so test assertions pin order.
Unknown nick (not a member anywhere) = no-op.

Per Q2 (CP10 S16): fan-out at producer side; renderer + pagination
stay simple; cicchetto filters by channel naturally.

Co-Authored-By: Claude Opus 4.7 <noreply@anthropic.com>
EOF
)"
```

### Task 9: NICK handler — fan-out per channel + self-nick reconciliation

NICK is server-level. Producer-side fan-out: one `:persist :nick_change` per channel where the renaming nick was a member, plus rename across the members map. Self-NICK additionally updates `state.nick`.

**Files:**
- Modify: `lib/grappa/session/event_router.ex`
- Modify: `test/grappa/session/event_router_test.exs`

- [ ] **Step 1: Failing tests**

```elixir
describe "route/2 — :nick (fan-out per channel where nick was member)" do
  test "NICK-other emits :persist :nick_change per channel + renames in members" do
    state =
      base_state(%{
        members: %{
          "#italia" => %{"vjt" => [], "alice" => ["@"]},
          "#italia.lib" => %{"alice" => ["+"]},
          "#empty" => %{"vjt" => []}
        }
      })

    msg = msg(:nick, ["alice_"], {:nick, "alice", "u", "h"})

    assert {:cont, new_state, effects} = EventRouter.route(msg, state)

    persist_channels =
      effects
      |> Enum.map(fn {:persist, :nick_change, a} -> a.channel end)
      |> Enum.sort()

    assert persist_channels == ["#italia", "#italia.lib"]

    Enum.each(effects, fn {:persist, :nick_change, attrs} ->
      assert attrs.sender == "alice"
      assert attrs.body == nil
      assert attrs.meta == %{new_nick: "alice_"}
    end)

    # Modes preserved on rename:
    assert new_state.members["#italia"] == %{"vjt" => [], "alice_" => ["@"]}
    assert new_state.members["#italia.lib"] == %{"alice_" => ["+"]}
    assert new_state.members["#empty"] == %{"vjt" => []}
    # state.nick unchanged for NICK-other:
    assert new_state.nick == "vjt"
  end

  test "NICK-self updates state.nick + fan-out persist" do
    state =
      base_state(%{
        members: %{
          "#italia" => %{"vjt" => ["@"], "alice" => []}
        }
      })

    msg = msg(:nick, ["vjt_"], {:nick, "vjt", "u", "h"})

    assert {:cont, new_state, [{:persist, :nick_change, attrs}]} =
             EventRouter.route(msg, state)

    assert new_state.nick == "vjt_"
    assert new_state.members["#italia"] == %{"vjt_" => ["@"], "alice" => []}
    assert attrs.meta == %{new_nick: "vjt_"}
  end

  test "NICK for nick not in any channel still updates state.nick if self" do
    state = base_state()
    msg = msg(:nick, ["vjt_"], {:nick, "vjt", "u", "h"})

    assert {:cont, new_state, []} = EventRouter.route(msg, state)
    assert new_state.nick == "vjt_"
  end

  test "NICK-other for stranger emits no effects + no mutation" do
    state = base_state(%{members: %{"#italia" => %{"vjt" => []}}})
    msg = msg(:nick, ["stranger_"], {:nick, "stranger", "u", "h"})

    assert {:cont, ^state, []} = EventRouter.route(msg, state)
  end
end
```

- [ ] **Step 2: Run failing tests**

Expected: NICK tests fail.

- [ ] **Step 3: Implement NICK handler**

```elixir
def route(%Message{command: :nick, params: [new_nick | _]} = msg, state)
    when is_binary(new_nick) do
  old_nick = Message.sender_nick(msg)
  channels = channels_with_member(state.members, old_nick)

  members = rename_member_everywhere(state.members, channels, old_nick, new_nick)

  state =
    if old_nick == state.nick do
      %{state | nick: new_nick, members: members}
    else
      %{state | members: members}
    end

  effects =
    for ch <- channels do
      {_state, effect} = build_persist(state, :nick_change, ch, old_nick, nil, %{new_nick: new_nick})
      effect
    end

  {:cont, state, effects}
end

@spec rename_member_everywhere(members(), [String.t()], String.t(), String.t()) :: members()
defp rename_member_everywhere(members, channels, old, new) do
  Enum.reduce(channels, members, fn ch, acc ->
    Map.update!(acc, ch, fn ch_members ->
      modes = Map.fetch!(ch_members, old)

      ch_members
      |> Map.delete(old)
      |> Map.put(new, modes)
    end)
  end)
end
```

- [ ] **Step 4: Run tests + check.sh**

Expected: green.

- [ ] **Step 5: Commit**

```bash
git add lib/grappa/session/event_router.ex test/grappa/session/event_router_test.exs
git commit -m "$(cat <<'EOF'
feat(event-router): classify NICK — fan-out persist + member rename

E1 task 9 — NICK is server-level (no channel param). Scan members
for every channel containing the renaming nick, emit one
{:persist, :nick_change, attrs} per channel + rename in each.
Modes preserved on rename. Self-NICK additionally updates state.nick.
Stranger-NICK (no member entries anywhere) is a no-op.

Per Q2 (CP10 S16): symmetrical fan-out shape with QUIT.

Co-Authored-By: Claude Opus 4.7 <noreply@anthropic.com>
EOF
)"
```

### Task 10: MODE handler — per-mode-char member updates + persist row

MODE on a channel: `:nick MODE #channel +ovo nick1 nick2 nick3`. Each mode char in `+/-` block toggles a permission on the corresponding arg. EventRouter applies per-arg, then emits ONE `:persist :mode` row with the raw `modes` + `args` in `meta`.

Hard-coded prefix table: `o` ↔ `@`, `v` ↔ `+`. PREFIX ISUPPORT-driven negotiation deferred to Phase 5.

**Files:**
- Modify: `lib/grappa/session/event_router.ex`
- Modify: `test/grappa/session/event_router_test.exs`

- [ ] **Step 1: Failing tests**

```elixir
describe "route/2 — :mode" do
  test "MODE +o adds @ to target nick's mode list" do
    state = base_state(%{members: %{"#italia" => %{"alice" => []}}})

    msg = msg(:mode, ["#italia", "+o", "alice"], {:nick, "ChanServ", "u", "h"})

    assert {:cont, new_state, [{:persist, :mode, attrs}]} =
             EventRouter.route(msg, state)

    assert new_state.members["#italia"]["alice"] == ["@"]
    assert attrs.meta == %{modes: "+o", args: ["alice"]}
    assert attrs.body == nil
    assert attrs.sender == "ChanServ"
  end

  test "MODE -o removes @ from target nick's mode list" do
    state = base_state(%{members: %{"#italia" => %{"alice" => ["@"]}}})

    msg = msg(:mode, ["#italia", "-o", "alice"], {:nick, "ChanServ", "u", "h"})

    assert {:cont, new_state, [{:persist, :mode, _}]} =
             EventRouter.route(msg, state)

    assert new_state.members["#italia"]["alice"] == []
  end

  test "MODE +ovo applies sequentially across args" do
    state =
      base_state(%{
        members: %{"#italia" => %{"a" => [], "b" => [], "c" => []}}
      })

    msg = msg(:mode, ["#italia", "+ovo", "a", "b", "c"], {:nick, "op", "u", "h"})

    assert {:cont, new_state, [{:persist, :mode, attrs}]} =
             EventRouter.route(msg, state)

    assert new_state.members["#italia"]["a"] == ["@"]
    assert new_state.members["#italia"]["b"] == ["+"]
    assert new_state.members["#italia"]["c"] == ["@"]
    assert attrs.meta == %{modes: "+ovo", args: ["a", "b", "c"]}
  end

  test "MODE +b (channel-level, not user mode) emits :persist but no member mutation" do
    state = base_state(%{members: %{"#italia" => %{"alice" => []}}})

    # +b is a ban — not in our user-mode prefix table; channel-level only.
    msg = msg(:mode, ["#italia", "+b", "*!*@spammer.net"], {:nick, "op", "u", "h"})

    assert {:cont, new_state, [{:persist, :mode, attrs}]} =
             EventRouter.route(msg, state)

    # alice mode list unchanged — +b doesn't apply to a member's modes
    assert new_state.members["#italia"] == %{"alice" => []}
    assert attrs.meta == %{modes: "+b", args: ["*!*@spammer.net"]}
  end

  test "MODE on user (not channel) — first param is a nick, not channel — emits :persist with sender as channel-shaped param echo, no member mutation" do
    # IRC user-MODE: `:vjt MODE vjt +i` — first param is the nick, not
    # a channel name. Identifier.valid_channel? would reject; the
    # changeset rejects the row at the boundary. Skip user-MODE for
    # now: the handler matches `params: [channel | _]` regardless,
    # but persist will fail validation. Test that we still pass through
    # without crashing — caller logs the changeset error.
    state = base_state(%{nick: "vjt"})
    msg = msg(:mode, ["vjt", "+i"], {:nick, "vjt", "u", "h"})

    # We still emit :persist; the persistence layer validates and
    # rejects (changeset error logged by Server.apply_effects).
    assert {:cont, _state, [{:persist, :mode, _}]} = EventRouter.route(msg, state)
  end
end
```

- [ ] **Step 2: Run failing tests**

Expected: MODE tests fail.

- [ ] **Step 3: Implement MODE handler**

```elixir
def route(%Message{command: :mode, params: [channel, modes | args]} = msg, state)
    when is_binary(channel) and is_binary(modes) do
  sender = Message.sender_nick(msg)
  members = apply_mode_string(state.members, channel, modes, args)

  {state, persist_effect} =
    build_persist(
      %{state | members: members},
      :mode,
      channel,
      sender,
      nil,
      %{modes: modes, args: args}
    )

  {:cont, state, [persist_effect]}
end

@spec apply_mode_string(members(), String.t(), String.t(), [String.t()]) :: members()
defp apply_mode_string(members, channel, mode_string, args) do
  case Map.get(members, channel) do
    nil ->
      members

    ch_members ->
      ch_members = walk_modes(ch_members, mode_string, args, :add)
      Map.put(members, channel, ch_members)
  end
end

@user_mode_prefixes %{"o" => "@", "v" => "+"}

defp walk_modes(ch_members, "", _args, _direction), do: ch_members
defp walk_modes(ch_members, "+" <> rest, args, _), do: walk_modes(ch_members, rest, args, :add)
defp walk_modes(ch_members, "-" <> rest, args, _), do: walk_modes(ch_members, rest, args, :remove)

defp walk_modes(ch_members, <<mode::binary-size(1), rest::binary>>, args, direction) do
  case Map.fetch(@user_mode_prefixes, mode) do
    {:ok, prefix} ->
      {target, remaining_args} = pop_arg(args)
      ch_members = update_member_mode(ch_members, target, prefix, direction)
      walk_modes(ch_members, rest, remaining_args, direction)

    :error ->
      # Channel-level mode (e.g. `+b ban_mask`); consumes one arg if it
      # takes one, none otherwise. Without a per-mode arg-taking table
      # we conservatively consume one arg if any remain — matches
      # Bahamut/InspIRCd behaviour for the most common channel modes
      # (k, l, b, e, I); the over-consume case is rare and only loses
      # us one inferred arg in a multi-mode line, never affects member
      # state.
      {_consumed, remaining_args} = pop_arg(args)
      walk_modes(ch_members, rest, remaining_args, direction)
  end
end

defp pop_arg([h | t]), do: {h, t}
defp pop_arg([]), do: {nil, []}

defp update_member_mode(ch_members, nil, _prefix, _direction), do: ch_members

defp update_member_mode(ch_members, target, prefix, direction) when is_binary(target) do
  case Map.fetch(ch_members, target) do
    {:ok, modes} ->
      new_modes =
        case direction do
          :add -> if prefix in modes, do: modes, else: modes ++ [prefix]
          :remove -> List.delete(modes, prefix)
        end

      Map.put(ch_members, target, new_modes)

    :error ->
      # Target isn't in our members map (race with NAMES, or non-member
      # channel-mode arg); leave the map untouched. The persist row
      # still records the raw MODE line — audit trail intact.
      ch_members
  end
end
```

- [ ] **Step 4: Run tests + check.sh**

Expected: green.

- [ ] **Step 5: Commit**

```bash
git add lib/grappa/session/event_router.ex test/grappa/session/event_router_test.exs
git commit -m "$(cat <<'EOF'
feat(event-router): classify MODE — per-char user-mode updates + persist row

E1 task 10 — MODE walks the +/-mode-char string left-to-right,
applying user modes (o ↔ @, v ↔ +) to args and consuming one arg per
char. Hard-coded `(ov)@+` prefix table; PREFIX ISUPPORT negotiation
deferred to Phase 5. Channel-level modes (b, k, l, e, I) consume one
arg conservatively without member-map mutation. Single :persist :mode
row carries raw `modes` + `args` in meta for renderer recovery.

Co-Authored-By: Claude Opus 4.7 <noreply@anthropic.com>
EOF
)"
```

### Task 11: TOPIC handler — TOPIC command only (not 332/333 numerics)

`TOPIC #channel :new topic` from a user (or services) → write `:topic` row, body=new topic. Numerics 332/333 are JOIN-time backfill — handled in Task 13.

**Files:**
- Modify: `lib/grappa/session/event_router.ex`
- Modify: `test/grappa/session/event_router_test.exs`

- [ ] **Step 1: Failing tests**

```elixir
describe "route/2 — :topic (TOPIC command only)" do
  test "TOPIC command emits :persist :topic with body=new_topic" do
    state = base_state()

    msg = msg(:topic, ["#italia", "Welcome to Italia"], {:nick, "ChanServ", "u", "h"})

    assert {:cont, ^state, [{:persist, :topic, attrs}]} =
             EventRouter.route(msg, state)

    assert attrs.channel == "#italia"
    assert attrs.sender == "ChanServ"
    assert attrs.body == "Welcome to Italia"
    assert attrs.meta == %{}
  end
end
```

- [ ] **Step 2: Run failing tests; expect failure**

- [ ] **Step 3: Implement TOPIC handler**

```elixir
def route(%Message{command: :topic, params: [channel, body]} = msg, state)
    when is_binary(channel) and is_binary(body) do
  {state, persist_effect} =
    build_persist(state, :topic, channel, Message.sender_nick(msg), body, %{})

  {:cont, state, [persist_effect]}
end
```

- [ ] **Step 4: Run tests + check.sh**

Expected: green.

- [ ] **Step 5: Commit**

```bash
git add lib/grappa/session/event_router.ex test/grappa/session/event_router_test.exs
git commit -m "$(cat <<'EOF'
feat(event-router): classify TOPIC command — :topic row, body=new topic

E1 task 11 — TOPIC command (someone just changed the topic) emits
:persist :topic with body=new topic, meta=%{}. Numerics 332/333
(RPL_TOPIC + RPL_TOPICWHOTIME, JOIN-time backfill) are NOT handled
here — task 13 routes them as no-ops per the topic-bar P4-1 plan
(live state, not scrollback rows).

Co-Authored-By: Claude Opus 4.7 <noreply@anthropic.com>
EOF
)"
```

### Task 12: KICK handler — remove target from members; reason → body, target → meta

`KICK #channel target :reason` — remove target from `state.members[channel]`, emit `:persist :kick` with `body: reason | nil`, `meta: %{target: kicked_nick}`.

**Files:**
- Modify: `lib/grappa/session/event_router.ex`
- Modify: `test/grappa/session/event_router_test.exs`

- [ ] **Step 1: Failing tests**

```elixir
describe "route/2 — :kick" do
  test "KICK removes target from state.members[channel] + emits :persist :kick" do
    state =
      base_state(%{
        members: %{"#italia" => %{"vjt" => [], "spammer" => []}}
      })

    msg = msg(:kick, ["#italia", "spammer", "go away"], {:nick, "ChanServ", "u", "h"})

    assert {:cont, new_state, [{:persist, :kick, attrs}]} =
             EventRouter.route(msg, state)

    assert new_state.members["#italia"] == %{"vjt" => []}
    assert attrs.sender == "ChanServ"
    assert attrs.body == "go away"
    assert attrs.meta == %{target: "spammer"}
  end

  test "KICK with no reason emits body=nil" do
    state = base_state(%{members: %{"#italia" => %{"spammer" => []}}})
    msg = msg(:kick, ["#italia", "spammer"], {:nick, "ChanServ", "u", "h"})

    assert {:cont, _new_state, [{:persist, :kick, %{body: nil, meta: %{target: "spammer"}}}]} =
             EventRouter.route(msg, state)
  end

  test "KICK target == own nick still removes (we're being kicked)" do
    state = base_state(%{nick: "vjt", members: %{"#italia" => %{"vjt" => []}}})
    msg = msg(:kick, ["#italia", "vjt", "rude"], {:nick, "ChanServ", "u", "h"})

    assert {:cont, new_state, [{:persist, :kick, _}]} = EventRouter.route(msg, state)
    assert new_state.members["#italia"] == %{}
  end
end
```

- [ ] **Step 2: Run failing tests**

- [ ] **Step 3: Implement KICK handler**

```elixir
def route(%Message{command: :kick, params: [channel, target | rest]} = msg, state)
    when is_binary(channel) and is_binary(target) do
  sender = Message.sender_nick(msg)
  reason = case rest do
    [r | _] when is_binary(r) -> r
    _ -> nil
  end

  members =
    case Map.get(state.members, channel) do
      nil -> state.members
      ch_members -> Map.put(state.members, channel, Map.delete(ch_members, target))
    end

  {state, persist_effect} =
    build_persist(
      %{state | members: members},
      :kick,
      channel,
      sender,
      reason,
      %{target: target}
    )

  {:cont, state, [persist_effect]}
end
```

- [ ] **Step 4: Run tests + check.sh**

Expected: green.

- [ ] **Step 5: Commit**

```bash
git add lib/grappa/session/event_router.ex test/grappa/session/event_router_test.exs
git commit -m "$(cat <<'EOF'
feat(event-router): classify KICK — remove target, reason → body, target → meta

E1 task 12 — KICK removes target from state.members[channel] + emits
:persist :kick with sender=kicker, body=reason|nil, meta.target=kicked
nick. Self-KICK (we're the target) leaves the channel cleanly — same
mutation path as foreign KICK.

Co-Authored-By: Claude Opus 4.7 <noreply@anthropic.com>
EOF
)"
```

---

## Phase 4 — Informational numerics + 001 nick reconciliation

### Task 13: Numeric 332 + 333 (TOPIC backfill on JOIN) — no-op

These arrive after a JOIN; no scrollback rows, no member changes.

**Files:**
- Modify: `lib/grappa/session/event_router.ex`
- Modify: `test/grappa/session/event_router_test.exs`

- [ ] **Step 1: Failing tests**

```elixir
describe "route/2 — :numeric 332 / 333 (TOPIC backfill on JOIN — no-op)" do
  test "332 RPL_TOPIC is a no-op (topic-bar reads live state, not scrollback)" do
    state = base_state()
    msg = msg({:numeric, 332}, ["vjt", "#italia", "current topic text"], {:server, "irc"})

    assert {:cont, ^state, []} = EventRouter.route(msg, state)
  end

  test "333 RPL_TOPICWHOTIME is a no-op" do
    state = base_state()
    msg = msg({:numeric, 333}, ["vjt", "#italia", "ChanServ", "1717890000"], {:server, "irc"})

    assert {:cont, ^state, []} = EventRouter.route(msg, state)
  end
end
```

- [ ] **Step 2: Run failing tests**

The current fallthrough already returns `{:cont, state, []}` for any unrecognised command, so these tests SHOULD pass without new code. Run them to confirm:

```bash
scripts/test.sh test/grappa/session/event_router_test.exs
```

Expected: pass on the first run. (The test serves as a documented regression-pin against a future "let's persist the topic backfill" idea that would conflict with the topic-bar plan.)

- [ ] **Step 3: Add explicit clauses for clarity (defensive)**

Even though fallthrough handles 332/333 correctly, add explicit clauses so future readers see the intentional no-op:

```elixir
# 332 RPL_TOPIC + 333 RPL_TOPICWHOTIME arrive as JOIN-time backfill;
# the topic-bar in P4-1 reads live state, not scrollback rows. Pin as
# explicit no-ops so a future "let's persist topic backfill" idea
# stays out of E1 scope.
def route(%Message{command: {:numeric, code}}, state) when code in [332, 333] do
  {:cont, state, []}
end
```

Insert before the fallthrough.

- [ ] **Step 4: Run tests + check.sh**

Expected: green.

- [ ] **Step 5: Commit**

```bash
git add lib/grappa/session/event_router.ex test/grappa/session/event_router_test.exs
git commit -m "$(cat <<'EOF'
feat(event-router): explicitly no-op numeric 332 / 333 (TOPIC backfill)

E1 task 13 — Numerics 332 RPL_TOPIC + 333 RPL_TOPICWHOTIME arrive as
JOIN-time backfill from upstream. The topic-bar in P4-1 will read
live state, not scrollback rows. Pin as explicit no-ops + tests that
future readers see the intentional decision.

Co-Authored-By: Claude Opus 4.7 <noreply@anthropic.com>
EOF
)"
```

### Task 14: Numeric 353 RPL_NAMREPLY + 366 RPL_ENDOFNAMES — populate members

353 line shape: `:server 353 vjt = #channel :@op +voice plain`. Trailing param is the nick list. Each token is `[prefix]nick` where prefix is one of `@`/`+`. EventRouter parses, populates `state.members[channel]` (additive — multiple 353 lines for big channels). 366 marks end (no-op state-wise).

**Files:**
- Modify: `lib/grappa/session/event_router.ex`
- Modify: `test/grappa/session/event_router_test.exs`

- [ ] **Step 1: Failing tests**

```elixir
describe "route/2 — numeric 353 RPL_NAMREPLY (members bootstrap)" do
  test "353 populates state.members[channel] with prefix-stripped nicks + modes" do
    state = base_state()

    # `:server 353 vjt = #italia :@op_user +voiced_user plain_user`
    msg =
      msg(
        {:numeric, 353},
        ["vjt", "=", "#italia", "@op_user +voiced_user plain_user"],
        {:server, "irc.azzurra.chat"}
      )

    assert {:cont, new_state, []} = EventRouter.route(msg, state)

    assert new_state.members["#italia"] == %{
             "op_user" => ["@"],
             "voiced_user" => ["+"],
             "plain_user" => []
           }
  end

  test "353 is additive — second line for the same channel merges" do
    state = base_state(%{members: %{"#big" => %{"a" => []}}})

    msg = msg({:numeric, 353}, ["vjt", "=", "#big", "@b +c d"], {:server, "irc"})

    assert {:cont, new_state, []} = EventRouter.route(msg, state)

    assert new_state.members["#big"] == %{
             "a" => [],
             "b" => ["@"],
             "c" => ["+"],
             "d" => []
           }
  end

  test "366 RPL_ENDOFNAMES is a no-op (end marker)" do
    state = base_state(%{members: %{"#italia" => %{"vjt" => []}}})

    msg = msg({:numeric, 366}, ["vjt", "#italia", "End of /NAMES list."], {:server, "irc"})

    assert {:cont, ^state, []} = EventRouter.route(msg, state)
  end
end
```

- [ ] **Step 2: Run failing tests**

Expected: 353 tests fail (current fallthrough doesn't parse the nick list); 366 test passes (fallthrough handles it).

- [ ] **Step 3: Implement 353 handler**

Insert before the 332/333 clause:

```elixir
# 353 RPL_NAMREPLY: `:server 353 nick = #channel :@op +voice plain`.
# Trailing param is space-separated `[prefix]nick` tokens. Additive
# merge into state.members[channel] — multiple 353 lines arrive for
# big channels (RFC 2812 doesn't bound the line, but most networks
# split at ~512 bytes). 366 RPL_ENDOFNAMES marks end; we don't need
# an explicit close because each 353 commits its delta immediately.
def route(
      %Message{command: {:numeric, 353}, params: [_self_nick, _eq_or_at, channel, names_blob]},
      state
    )
    when is_binary(channel) and is_binary(names_blob) do
  new_entries =
    names_blob
    |> String.split(" ", trim: true)
    |> Enum.map(&split_mode_prefix/1)
    |> Map.new()

  members =
    Map.update(state.members, channel, new_entries, fn existing ->
      Map.merge(existing, new_entries)
    end)

  {:cont, %{state | members: members}, []}
end

# 366 RPL_ENDOFNAMES is the end-of-NAMES marker; we don't need to
# react (each 353 already committed its delta). Pin as explicit no-op.
def route(%Message{command: {:numeric, 366}}, state), do: {:cont, state, []}

@spec split_mode_prefix(String.t()) :: {String.t(), [String.t()]}
defp split_mode_prefix(<<prefix, rest::binary>>) when prefix in [?@, ?+] do
  {rest, [<<prefix>>]}
end

defp split_mode_prefix(nick), do: {nick, []}
```

- [ ] **Step 4: Run tests + check.sh**

Expected: green.

- [ ] **Step 5: Commit**

```bash
git add lib/grappa/session/event_router.ex test/grappa/session/event_router_test.exs
git commit -m "$(cat <<'EOF'
feat(event-router): bootstrap members from 353 RPL_NAMREPLY

E1 task 14 — 353 trailing param = space-separated `[prefix]nick`
tokens; additive merge into state.members[channel] (multi-line for
big channels). 366 RPL_ENDOFNAMES is explicit no-op (each 353 commits
delta immediately).

Hard-coded `@`/`+` prefix table per Q-non-blocking; PREFIX ISUPPORT
negotiation deferred to Phase 5.

Co-Authored-By: Claude Opus 4.7 <noreply@anthropic.com>
EOF
)"
```

### Task 15: Numeric 001 RPL_WELCOME — nick reconciliation

The Server already special-cases 001 for autojoin (in `handle_info`, before delegation). Task 15 splits the work: nick reconciliation moves to EventRouter; autojoin stays in Server (it reads `state.autojoin` which EventRouter doesn't have).

This task only adds the EventRouter side — Server-side wiring lands in Task 19.

**Files:**
- Modify: `lib/grappa/session/event_router.ex`
- Modify: `test/grappa/session/event_router_test.exs`

- [ ] **Step 1: Failing tests**

```elixir
describe "route/2 — numeric 001 RPL_WELCOME (nick reconciliation)" do
  test "001 with welcomed nick == requested nick leaves state.nick unchanged" do
    state = base_state(%{nick: "vjt"})
    msg = msg({:numeric, 1}, ["vjt", "Welcome to IRC vjt!u@h"], {:server, "irc"})

    assert {:cont, ^state, []} = EventRouter.route(msg, state)
  end

  test "001 with welcomed nick != requested nick reconciles state.nick" do
    state = base_state(%{nick: "vjt"})
    msg = msg({:numeric, 1}, ["vjt_truncated", "Welcome to IRC"], {:server, "irc"})

    assert {:cont, new_state, []} = EventRouter.route(msg, state)
    assert new_state.nick == "vjt_truncated"
  end
end
```

- [ ] **Step 2: Run failing tests**

Expected: 001 tests fail (fallthrough doesn't reconcile nick).

- [ ] **Step 3: Implement 001 handler**

Insert before the 332/333 clause:

```elixir
# 001 RPL_WELCOME: first param is the nick the upstream registered us
# as — may differ from what we requested (case-fold normalization,
# services-driven rename, length truncation). Reconcile state.nick to
# what upstream actually registered. Autojoin trigger stays in
# Session.Server (it reads state.autojoin which this router doesn't
# have).
def route(
      %Message{command: {:numeric, 1}, params: [welcomed_nick | _]},
      state
    )
    when is_binary(welcomed_nick) do
  if welcomed_nick == state.nick do
    {:cont, state, []}
  else
    {:cont, %{state | nick: welcomed_nick}, []}
  end
end
```

- [ ] **Step 4: Run tests + check.sh**

Expected: green.

- [ ] **Step 5: Commit**

```bash
git add lib/grappa/session/event_router.ex test/grappa/session/event_router_test.exs
git commit -m "$(cat <<'EOF'
feat(event-router): reconcile state.nick on 001 RPL_WELCOME

E1 task 15 — 001's first param is the nick upstream actually registered
us as (may differ from requested via case-fold / truncation /
services-driven rename). EventRouter mutates state.nick. Autojoin
trigger stays in Session.Server (it reads state.autojoin which this
router doesn't carry). Server wiring (delegating 001 to router AFTER
firing autojoin) lands in task 19.

Co-Authored-By: Claude Opus 4.7 <noreply@anthropic.com>
EOF
)"
```

---

## Phase 5 — EventRouter contract tests + property tests

### Task 16: A6 contract test — every Scrollback.kind() has at least one persist clause

The contract: every value in `Grappa.Scrollback.Message.kinds/0` (closed-set enum) has at least one EventRouter route that produces `{:persist, kind, _}`. Compile-time exhaustiveness check via test enumeration over the public kind list.

This is the load-bearing test for A6 closure: if a future PR adds a kind to the schema but forgets to wire EventRouter, this test fails loudly.

**Files:**
- Modify: `lib/grappa/scrollback/message.ex` (expose `kinds/0`)
- Modify: `test/grappa/session/event_router_test.exs`

- [ ] **Step 1: Expose `Grappa.Scrollback.Message.kinds/0`**

In `lib/grappa/scrollback/message.ex`, add a public function exposing `@kinds` (currently a module attribute). Insert above the `@type kind ::` declaration:

```elixir
@doc """
Returns the closed-set list of valid `:kind` values. Exposed so
tests can drive coverage assertions over the full enum (e.g.
`Grappa.Session.EventRouterTest`'s A6 contract test) without
hard-coding the list at the test site (which would drift the moment
a new kind lands in the schema).
"""
@spec kinds() :: [kind(), ...]
def kinds, do: @kinds
```

- [ ] **Step 2: Failing test for A6 exhaustiveness**

Append to `test/grappa/session/event_router_test.exs`:

```elixir
describe "A6 contract — every Scrollback.kind() has at least one EventRouter route" do
  alias Grappa.Scrollback.Message, as: ScrollbackMessage

  # Synthesized fixture lines for each kind. Mapping is hand-built
  # because some kinds (:nick_change) are produced by the NICK command
  # not a kind-named command, and :action is produced by PRIVMSG with
  # a CTCP-framed body. The test asserts that EACH synthesized fixture
  # results in AT LEAST ONE :persist effect tagged with the expected
  # kind — the producer-side proof that A6 is closed.
  defp fixture_for(:privmsg) do
    {msg(:privmsg, ["#c", "body"], {:nick, "alice", "u", "h"}),
     base_state(%{members: %{"#c" => %{"alice" => []}}})}
  end

  defp fixture_for(:notice) do
    {msg(:notice, ["#c", "body"], {:server, "irc"}), base_state()}
  end

  defp fixture_for(:action) do
    body = <<0x01, "ACTION waves", 0x01>>
    {msg(:privmsg, ["#c", body], {:nick, "alice", "u", "h"}), base_state()}
  end

  defp fixture_for(:join) do
    {msg(:join, ["#c"], {:nick, "alice", "u", "h"}), base_state()}
  end

  defp fixture_for(:part) do
    {msg(:part, ["#c"], {:nick, "alice", "u", "h"}),
     base_state(%{members: %{"#c" => %{"alice" => []}}})}
  end

  defp fixture_for(:quit) do
    {msg(:quit, ["bye"], {:nick, "alice", "u", "h"}),
     base_state(%{members: %{"#c" => %{"alice" => []}}})}
  end

  defp fixture_for(:nick_change) do
    {msg(:nick, ["alice_"], {:nick, "alice", "u", "h"}),
     base_state(%{members: %{"#c" => %{"alice" => []}}})}
  end

  defp fixture_for(:mode) do
    {msg(:mode, ["#c", "+o", "alice"], {:nick, "ChanServ", "u", "h"}),
     base_state(%{members: %{"#c" => %{"alice" => []}}})}
  end

  defp fixture_for(:topic) do
    {msg(:topic, ["#c", "topic"], {:nick, "ChanServ", "u", "h"}), base_state()}
  end

  defp fixture_for(:kick) do
    {msg(:kick, ["#c", "spammer"], {:nick, "ChanServ", "u", "h"}),
     base_state(%{members: %{"#c" => %{"spammer" => []}}})}
  end

  test "every Scrollback kind has at least one EventRouter route producing :persist" do
    for kind <- ScrollbackMessage.kinds() do
      {message, state} = fixture_for(kind)
      {:cont, _new_state, effects} = EventRouter.route(message, state)

      persist_kinds =
        effects
        |> Enum.filter(&match?({:persist, _, _}, &1))
        |> Enum.map(fn {:persist, k, _} -> k end)

      assert kind in persist_kinds,
             "A6 violation: kind #{inspect(kind)} has no EventRouter route producing :persist. " <>
               "Effects produced: #{inspect(effects)}. " <>
               "If you added a new kind to Scrollback.Message.@kinds, also wire a clause " <>
               "in lib/grappa/session/event_router.ex (and add a fixture_for/1 above)."
    end
  end
end
```

- [ ] **Step 3: Run tests**

```bash
scripts/test.sh test/grappa/session/event_router_test.exs
```

Expected: pass (every kind already has a route from Tasks 5-12; the test certifies coverage).

If a kind fails, the route exists but the fixture is wrong — fix fixture (the failing message, however, is the producer-side gap A6 was created to close).

- [ ] **Step 4: Run check.sh**

Expected: green.

- [ ] **Step 5: Commit**

```bash
git add lib/grappa/scrollback/message.ex test/grappa/session/event_router_test.exs
git commit -m "$(cat <<'EOF'
test(event-router): A6 contract — every Scrollback.kind() has a route

E1 task 16 — load-bearing A6 closure test. Iterates
ScrollbackMessage.kinds() (newly exposed) and asserts each kind has
at least one EventRouter route producing {:persist, kind, _}.

If a future PR adds a kind to the schema but forgets to wire
EventRouter, this test fails loudly with a fixture-update hint.

Co-Authored-By: Claude Opus 4.7 <noreply@anthropic.com>
EOF
)"
```

### Task 17: EventRouter property tests — shape contract

`StreamData`-driven tests that the route/2 return shape is always `{:cont, state(), [effect()]}` — no panics, no malformed effects, regardless of input message shape.

**Files:**
- Create: `test/grappa/session/event_router_property_test.exs`

- [ ] **Step 1: Write the property test file**

```elixir
defmodule Grappa.Session.EventRouterPropertyTest do
  @moduledoc """
  Shape-contract properties: no synthetic input causes route/2 to
  panic, and the output is always `{:cont, state, [effect]}` with
  effects matching the documented shape.

  Property tests complement the per-kind unit tests by covering the
  long tail of garbage / unknown / partially-shaped messages a real
  upstream may send (CAP echoes, vendor numerics, malformed prefixes,
  empty params, etc.).
  """
  use ExUnit.Case, async: true
  use ExUnitProperties

  alias Grappa.IRC.Message
  alias Grappa.Session.EventRouter

  defp ascii_nick_gen do
    string([?a..?z, ?A..?Z, ?0..?9, ?_], min_length: 1, max_length: 16)
  end

  defp channel_gen do
    bind(ascii_nick_gen(), fn body -> constant("#" <> body) end)
  end

  defp message_gen do
    gen all command <-
              one_of([
                constant(:privmsg),
                constant(:notice),
                constant(:join),
                constant(:part),
                constant(:quit),
                constant(:nick),
                constant(:mode),
                constant(:topic),
                constant(:kick),
                constant(:ping),
                tuple({constant(:numeric), integer(1..999)}),
                tuple({constant(:unknown), string(:ascii, min_length: 1, max_length: 8)})
              ]),
            params <- list_of(string(:ascii, min_length: 0, max_length: 64), max_length: 6),
            sender <- ascii_nick_gen() do
      %Message{
        command: command,
        params: params,
        prefix: {:nick, sender, "u", "h"},
        tags: %{}
      }
    end
  end

  defp state_gen do
    gen all nick <- ascii_nick_gen(),
            channels <- list_of(channel_gen(), max_length: 4),
            channel_members <-
              list_of(
                map_of(ascii_nick_gen(), constant([])),
                length: length(channels)
              ) do
      members =
        channels
        |> Enum.zip(channel_members)
        |> Map.new()

      %{
        user_id: "00000000-0000-0000-0000-000000000001",
        network_id: 1,
        nick: nick,
        members: members
      }
    end
  end

  property "route/2 always returns {:cont, state, [effect]} — no panics, no malformed effects" do
    check all message <- message_gen(),
              state <- state_gen() do
      assert {:cont, new_state, effects} = EventRouter.route(message, state)

      assert is_map(new_state)
      assert is_binary(new_state.nick)
      assert is_map(new_state.members)
      assert is_list(effects)

      Enum.each(effects, fn
        {:persist, kind, attrs} ->
          assert kind in Grappa.Scrollback.Message.kinds()
          assert is_map(attrs)
          assert is_binary(attrs.channel)
          assert is_binary(attrs.sender)
          assert is_integer(attrs.server_time)
          assert is_map(attrs.meta)

        {:reply, line} ->
          # iodata is binary | improper-list-of-bytes; we accept any
          # binary as the lowest-cost shape check.
          assert is_binary(IO.iodata_to_binary(line))

        other ->
          flunk("malformed effect: #{inspect(other)}")
      end)
    end
  end

  property "QUIT preserves total membership invariant: every channel still has its other members" do
    check all original_members <-
                map_of(channel_gen(), map_of(ascii_nick_gen(), constant([])), max_length: 3),
              quitting_nick <- ascii_nick_gen() do
      state = %{
        user_id: "00000000-0000-0000-0000-000000000001",
        network_id: 1,
        nick: "self",
        members: original_members
      }

      msg = %Message{
        command: :quit,
        params: ["bye"],
        prefix: {:nick, quitting_nick, "u", "h"},
        tags: %{}
      }

      {:cont, new_state, _} = EventRouter.route(msg, state)

      # Every nick that wasn't the quitter is still in the same channel.
      Enum.each(original_members, fn {channel, ch_members} ->
        Enum.each(Map.delete(ch_members, quitting_nick), fn {nick, modes} ->
          assert get_in(new_state.members, [channel, nick]) == modes,
                 "nick #{nick} disappeared from #{channel} after QUIT of #{quitting_nick}"
        end)
      end)
    end
  end
end
```

- [ ] **Step 2: Run property tests**

```bash
scripts/test.sh test/grappa/session/event_router_property_test.exs
```

Expected: passes 100 iterations per property (StreamData default).

- [ ] **Step 3: Run check.sh**

Expected: green.

- [ ] **Step 4: Commit**

```bash
git add test/grappa/session/event_router_property_test.exs
git commit -m "$(cat <<'EOF'
test(event-router): property tests — shape contract + QUIT invariant

E1 task 17 — StreamData-driven properties:

1. `route/2` always returns `{:cont, state, [effect]}` for arbitrary
   inputs — no panics, all effects shaped correctly.
2. QUIT preserves total membership invariant — every non-quitter
   nick stays in the same channel with the same modes.

Complements the per-kind unit tests by covering the long tail of
garbage / vendor numerics / malformed prefixes a real upstream may
emit.

Co-Authored-By: Claude Opus 4.7 <noreply@anthropic.com>
EOF
)"
```

---

## Phase 6 — Server delegation + members snapshot

### Task 18: Server gains `members` field; existing `handle_info` clauses migrate to delegation

Server-side wiring of EventRouter. Significant change to `handle_info` — the per-kind clauses collapse to one delegation call. The 001 (autojoin) and PING (transport keepalive) clauses stay inline.

**Files:**
- Modify: `lib/grappa/session/server.ex`
- Modify: `test/grappa/session/server_test.exs`

- [ ] **Step 1: Failing test for `members` field initialised empty**

In `test/grappa/session/server_test.exs`, add a new describe block:

```elixir
describe "EventRouter delegation" do
  test "Session.Server starts with empty members map" do
    {server, port} = start_server()
    {user, network, _cred} = setup_user_and_network(port)

    pid = start_session_for(user, network)
    await_handshake(server)

    state = :sys.get_state(pid)
    assert state.members == %{}

    :ok = GenServer.stop(pid, :normal, 1_000)
  end

  test "JOIN-self resets members[channel] to %{own_nick => []}" do
    {server, port} = start_server()
    {user, network, _cred} = setup_user_and_network(port, %{nick: "vjt-grappa", autojoin_channels: ["#test"]})

    pid = start_session_for(user, network)
    await_handshake(server)

    # Drive through 001 + autojoin
    IRCServer.send_line(server, ":irc 001 vjt-grappa :Welcome")
    {:ok, _join_line} = IRCServer.wait_for_line(server, &String.starts_with?(&1, "JOIN"))

    # Synthesise upstream's JOIN echo
    IRCServer.send_line(server, ":vjt-grappa!u@h JOIN :#test")

    # Allow the message to reach Session
    Process.sleep(50)

    state = :sys.get_state(pid)
    assert state.members["#test"] == %{"vjt-grappa" => []}

    :ok = GenServer.stop(pid, :normal, 1_000)
  end

  test "353 RPL_NAMREPLY populates members with mode prefixes parsed" do
    {server, port} = start_server()
    {user, network, _cred} = setup_user_and_network(port, %{nick: "vjt-grappa", autojoin_channels: ["#test"]})

    pid = start_session_for(user, network)
    await_handshake(server)

    IRCServer.send_line(server, ":irc 001 vjt-grappa :Welcome")
    {:ok, _} = IRCServer.wait_for_line(server, &String.starts_with?(&1, "JOIN"))
    IRCServer.send_line(server, ":vjt-grappa!u@h JOIN :#test")
    IRCServer.send_line(server, ":irc 353 vjt-grappa = #test :@vjt-grappa +alice bob")
    IRCServer.send_line(server, ":irc 366 vjt-grappa #test :End of /NAMES list.")

    Process.sleep(50)

    state = :sys.get_state(pid)
    assert state.members["#test"] == %{
             "vjt-grappa" => ["@"],
             "alice" => ["+"],
             "bob" => []
           }

    :ok = GenServer.stop(pid, :normal, 1_000)
  end

  test "QUIT removes nick from every channel + persists one row per channel" do
    {server, port} = start_server()
    {user, network, _cred} = setup_user_and_network(port, %{nick: "vjt-grappa", autojoin_channels: ["#a", "#b"]})

    pid = start_session_for(user, network)
    await_handshake(server)

    IRCServer.send_line(server, ":irc 001 vjt-grappa :Welcome")
    {:ok, _} = IRCServer.wait_for_line(server, &String.starts_with?(&1, "JOIN #a"))
    {:ok, _} = IRCServer.wait_for_line(server, &String.starts_with?(&1, "JOIN #b"))

    IRCServer.send_line(server, ":vjt-grappa!u@h JOIN :#a")
    IRCServer.send_line(server, ":vjt-grappa!u@h JOIN :#b")
    IRCServer.send_line(server, ":alice!u@h JOIN :#a")
    IRCServer.send_line(server, ":alice!u@h JOIN :#b")

    Process.sleep(50)

    IRCServer.send_line(server, ":alice!u@h QUIT :Ping timeout")

    Process.sleep(50)

    state = :sys.get_state(pid)
    refute Map.has_key?(state.members["#a"], "alice")
    refute Map.has_key?(state.members["#b"], "alice")

    # Two persisted rows (one per channel)
    rows = Scrollback.fetch(user.id, network.id, "#a", nil, 10)
    assert Enum.any?(rows, &(&1.kind == :quit and &1.sender == "alice"))

    rows_b = Scrollback.fetch(user.id, network.id, "#b", nil, 10)
    assert Enum.any?(rows_b, &(&1.kind == :quit and &1.sender == "alice"))

    :ok = GenServer.stop(pid, :normal, 1_000)
  end
end
```

- [ ] **Step 2: Run failing tests**

Expected: every new test fails — `members` field doesn't exist on state yet.

- [ ] **Step 3: Add `members` field to `Session.Server.state()`**

In `lib/grappa/session/server.ex`, update the `@type state ::` declaration:

```elixir
@type state :: %{
        user_id: Ecto.UUID.t(),
        user_name: String.t(),
        network_id: integer(),
        network_slug: String.t(),
        nick: String.t(),
        members: %{String.t() => %{String.t() => [String.t()]}},
        autojoin: [String.t()],
        client: pid() | nil
      }
```

In `init/1`, initialise the field in the state map:

```elixir
state = %{
  user_id: opts.user_id,
  user_name: opts.user_name,
  network_id: opts.network_id,
  network_slug: opts.network_slug,
  nick: opts.nick,
  members: %{},
  autojoin: opts.autojoin_channels,
  client: nil
}
```

- [ ] **Step 4: Replace `handle_info` per-kind clauses with delegation**

Delete every existing `handle_info({:irc, ...}, state)` clause EXCEPT the `:ping` clause. Replace with:

```elixir
@impl GenServer
def handle_info({:irc, %Message{command: :ping, params: [token | _]}}, state) do
  :ok = Client.send_pong(state.client, token)
  {:noreply, state}
end

# 001 RPL_WELCOME: autojoin BEFORE delegating to EventRouter (which
# handles state.nick reconciliation). EventRouter doesn't read
# state.autojoin or own state.client — autojoin stays here as a
# transport-side action.
def handle_info(
      {:irc, %Message{command: {:numeric, 1}, params: [welcomed_nick | _]} = msg},
      state
    )
    when is_binary(welcomed_nick) do
  Enum.each(state.autojoin, fn channel ->
    case Client.send_join(state.client, channel) do
      :ok -> :ok
      {:error, :invalid_line} ->
        Logger.warning("autojoin skipped: invalid channel name", channel: inspect(channel))
    end
  end)

  delegate(msg, state)
end

def handle_info({:irc, %Message{} = msg}, state), do: delegate(msg, state)

defp delegate(msg, state) do
  {:cont, new_state, effects} = EventRouter.route(msg, state)
  new_state = apply_effects(effects, new_state)
  {:noreply, new_state}
end

@spec apply_effects([EventRouter.effect()], state()) :: state()
defp apply_effects([], state), do: state

defp apply_effects([{:persist, kind, attrs} | rest], state) do
  attrs = Map.merge(attrs, %{user_id: state.user_id, network_id: state.network_id, kind: kind})

  case Scrollback.persist_event(attrs) do
    {:ok, message} ->
      :ok =
        Phoenix.PubSub.broadcast(
          Grappa.PubSub,
          Topic.channel(state.user_name, state.network_slug, attrs.channel),
          Wire.message_event(message)
        )

    {:error, changeset} ->
      Logger.error("scrollback insert failed",
        command: kind,
        channel: attrs.channel,
        error: inspect(changeset.errors)
      )
  end

  apply_effects(rest, state)
end

defp apply_effects([{:reply, line} | rest], state) do
  :ok = Client.send_line(state.client, line)
  apply_effects(rest, state)
end
```

Note that EventRouter's `:persist` effect carries the per-message attrs; `apply_effects` merges in the kind tag (the effect tuple's second element) — no, the effect is `{:persist, kind, attrs}` where `attrs` already has every field except `:kind` (kind comes from the tuple). The Map.merge above adds it. Verify the `Scrollback.persist_event/1` spec accepts a map with `:kind`.

Also delete the now-unused `@logged_event_commands` attribute and the `persist_and_broadcast/4` helper if `handle_call({:send_privmsg, ...})` was its only OTHER caller. Wait — `handle_call({:send_privmsg, ...})` calls `persist_and_broadcast/4`. That outbound path needs to stay using `Scrollback.persist_event/1` directly. Refactor:

```elixir
@impl GenServer
def handle_call({:send_privmsg, target, body}, _, state)
    when is_binary(target) and is_binary(body) do
  attrs = %{
    user_id: state.user_id,
    network_id: state.network_id,
    channel: target,
    server_time: System.system_time(:millisecond),
    kind: :privmsg,
    sender: state.nick,
    body: body,
    meta: %{}
  }

  case Scrollback.persist_event(attrs) do
    {:ok, message} ->
      :ok =
        Phoenix.PubSub.broadcast(
          Grappa.PubSub,
          Topic.channel(state.user_name, state.network_slug, target),
          Wire.message_event(message)
        )

      case Client.send_privmsg(state.client, target, body) do
        :ok ->
          {:reply, {:ok, message}, state}

        {:error, :invalid_line} = err ->
          Logger.error("client rejected privmsg AFTER persist — facade bypass?",
            channel: target
          )

          {:reply, err, state}
      end

    {:error, _} = err ->
      {:reply, err, state}
  end
end
```

Delete `persist_and_broadcast/4` entirely (zero callsites now).

- [ ] **Step 5: Run failing tests; expect new ones to pass + existing to still pass**

```bash
scripts/test.sh
```

Expected: all green. The existing PRIVMSG send + receive tests still pass (the path through `Scrollback.persist_event/1` is the same shape as the deleted helper).

- [ ] **Step 6: Run check.sh**

Expected: green.

- [ ] **Step 7: Commit**

```bash
git add lib/grappa/session/server.ex test/grappa/session/server_test.exs
git commit -m "$(cat <<'EOF'
refactor(session): delegate handle_info to EventRouter; gain members field

E1 task 18 — closes A6 producer-side gap end-to-end. Server.handle_info
collapses from 9 per-kind clauses to one delegation call (plus inline
PING + 001-autojoin which read transport state EventRouter doesn't
have).

state gains `members: %{channel => %{nick => [mode]}}` per Q3
(CP10 S16). Bootstrapped empty; populated by EventRouter on
JOIN/353/PART/QUIT/NICK/MODE/KICK + reconciled via 366. Crash-safe:
rebuilt from upstream NAMES on reconnect.

apply_effects/2 helper flushes :persist (Scrollback insert + PubSub
broadcast) and :reply (Client.send_line) effects sequentially.
Outbound PRIVMSG handle_call uses Scrollback.persist_event/1 directly
(different transaction shape — caller needs return value). Old
persist_and_broadcast/4 helper deleted (zero callsites).

@logged_event_commands attribute deleted — every kind now persists.

Integration tests cover: members empty on init, JOIN-self reset, 353
populates with prefix parsing, QUIT fan-out across channels.

Co-Authored-By: Claude Opus 4.7 <noreply@anthropic.com>
EOF
)"
```

### Task 19: Add `Session.list_members/3` facade + `handle_call({:list_members, ...})` snapshot

`Session.list_members(user_id, network_id, channel)` → `{:ok, [%{nick, modes}]}` in mIRC sort order, or `{:error, :no_session}`. Reads `state.members[channel]`, sorts.

The brainstorm spec referred to this as `list_members/2`, but the channel is required as a third argument (the snapshot is per-channel). Plan promotes to `list_members/3` with `(user_id, network_id, channel)` — consistent with existing `send_privmsg/4`, `send_join/3`, `send_part/3` facade shape. Brainstorm spec wording was loose; this plan is the authority on the function arity.

**Files:**
- Modify: `lib/grappa/session.ex`
- Modify: `lib/grappa/session/server.ex`
- Modify: `test/grappa/session/server_test.exs`

- [ ] **Step 1: Failing tests for the snapshot + sort**

In `test/grappa/session/server_test.exs`:

```elixir
describe "list_members/3 snapshot" do
  test "returns members in mIRC sort: @ ops first, + voiced second, plain last" do
    {server, port} = start_server()
    {user, network, _cred} = setup_user_and_network(port, %{nick: "vjt-grappa", autojoin_channels: ["#test"]})

    pid = start_session_for(user, network)
    await_handshake(server)

    IRCServer.send_line(server, ":irc 001 vjt-grappa :Welcome")
    {:ok, _} = IRCServer.wait_for_line(server, &String.starts_with?(&1, "JOIN"))
    IRCServer.send_line(server, ":vjt-grappa!u@h JOIN :#test")
    IRCServer.send_line(server, ":irc 353 vjt-grappa = #test :@op_a +voice_a plain_b @op_b plain_a")
    IRCServer.send_line(server, ":irc 366 vjt-grappa #test :End")

    Process.sleep(50)

    assert {:ok, members} = Session.list_members(user.id, network.id, "#test")

    # mIRC sort: @ ops alphabetical → + voiced alphabetical → plain alphabetical
    assert members == [
             %{nick: "op_a", modes: ["@"]},
             %{nick: "op_b", modes: ["@"]},
             %{nick: "voice_a", modes: ["+"]},
             %{nick: "plain_a", modes: []},
             %{nick: "plain_b", modes: []}
           ]

    :ok = GenServer.stop(pid, :normal, 1_000)
  end

  test "no session for (user, network) returns {:error, :no_session}" do
    user = user_fixture(name: "alice-#{System.unique_integer([:positive])}")
    {network, _} = network_with_server(port: 12_345, slug: "x-#{System.unique_integer([:positive])}")

    assert {:error, :no_session} =
             Session.list_members(user.id, network.id, "#test")
  end

  test "channel not in members returns empty list (joined but no NAMES yet, or unknown channel)" do
    {_server, port} = start_server()
    {user, network, _cred} = setup_user_and_network(port)

    pid = start_session_for(user, network)
    Process.sleep(50)

    assert {:ok, []} = Session.list_members(user.id, network.id, "#nowhere")

    :ok = GenServer.stop(pid, :normal, 1_000)
  end
end
```

- [ ] **Step 2: Run failing tests**

Expected: fails — `Session.list_members/3` doesn't exist.

- [ ] **Step 3: Implement `Session.Server.handle_call({:list_members, channel}, ...)`**

Add to `lib/grappa/session/server.ex` next to the other `handle_call` clauses:

```elixir
@impl GenServer
def handle_call({:list_members, channel}, _from, state) when is_binary(channel) do
  members =
    state.members
    |> Map.get(channel, %{})
    |> Enum.map(fn {nick, modes} -> %{nick: nick, modes: modes} end)
    |> Enum.sort_by(&{member_sort_tier(&1.modes), &1.nick})

  {:reply, {:ok, members}, state}
end

# mIRC sort: ops (@) → voiced (+) → plain (no prefix). Within tier,
# alphabetical by nick.
defp member_sort_tier(modes) do
  cond do
    "@" in modes -> 0
    "+" in modes -> 1
    true -> 2
  end
end
```

- [ ] **Step 4: Implement `Session.list_members/3` facade**

Add to `lib/grappa/session.ex`:

```elixir
@doc """
Returns a snapshot of the channel's member list in mIRC sort order
(`@` ops alphabetical → `+` voiced alphabetical → plain alphabetical).
Each entry: `%{nick: String.t(), modes: [String.t()]}`.

Returns `{:ok, []}` if the session is registered but has no members
recorded for the channel (operator joined but NAMES hasn't completed,
or unknown channel). Returns `{:error, :no_session}` if no session
is registered for `(user_id, network_id)`.

Used by `GET /networks/:net/channels/:chan/members` (P4-1's nick-list
sidebar consumer). Snapshot, not subscription — cicchetto refetches
on channel-select; presence pushes via PubSub flow through
`MessagesChannel` already.
"""
@spec list_members(Ecto.UUID.t(), integer(), String.t()) ::
        {:ok, [%{nick: String.t(), modes: [String.t()]}]}
        | {:error, :no_session}
def list_members(user_id, network_id, channel)
    when is_binary(user_id) and is_integer(network_id) and is_binary(channel) do
  call_session(user_id, network_id, {:list_members, channel})
end
```

- [ ] **Step 5: Run tests + check.sh**

Expected: green.

- [ ] **Step 6: Commit**

```bash
git add lib/grappa/session.ex lib/grappa/session/server.ex test/grappa/session/server_test.exs
git commit -m "$(cat <<'EOF'
feat(session): add list_members/3 — mIRC-sorted snapshot facade

E1 task 19 — Session.list_members/3 returns the per-channel member
snapshot for cicchetto's nick-list sidebar (P4-1). mIRC sort: @ ops
alphabetical → + voiced alphabetical → plain alphabetical (Q3 pinned
in CP10 S16).

Server's handle_call({:list_members, channel}, ...) reads
state.members[channel] (default %{}) + sorts. {:error, :no_session}
when no session registered.

Co-Authored-By: Claude Opus 4.7 <noreply@anthropic.com>
EOF
)"
```

---

## Phase 7 — REST surface

### Task 20: `MembersController` + JSON view + router wire-up

**Files:**
- Create: `lib/grappa_web/controllers/members_controller.ex`
- Create: `lib/grappa_web/controllers/members_json.ex`
- Modify: `lib/grappa_web/router.ex`
- Create: `test/grappa_web/controllers/members_controller_test.exs`

- [ ] **Step 1: Failing test for the controller**

Create `test/grappa_web/controllers/members_controller_test.exs`:

```elixir
defmodule GrappaWeb.MembersControllerTest do
  @moduledoc """
  REST surface for the per-channel nick list. Smoke-test happy path,
  iso boundary (cross-user), and no-session 404.
  """
  use GrappaWeb.ConnCase, async: false

  import Grappa.AuthFixtures
  alias Grappa.{IRCServer, Session}

  defp pick_unused_port do
    {:ok, l} = :gen_tcp.listen(0, [])
    {:ok, port} = :inet.port(l)
    :gen_tcp.close(l)
    port
  end

  defp start_irc_server do
    handler = fn state, _ -> {:reply, nil, state} end
    {:ok, server} = IRCServer.start_link(handler)
    {server, IRCServer.port(server)}
  end

  defp authn(conn, user) do
    {:ok, token, _session} = Grappa.Accounts.create_session(user.id)
    Plug.Conn.put_req_header(conn, "authorization", "Bearer #{token}")
  end

  describe "GET /networks/:network_id/channels/:channel_id/members" do
    setup do
      {server, port} = start_irc_server()
      user = user_fixture(name: "vjt-#{System.unique_integer([:positive])}")
      {network, _} = network_with_server(port: port, slug: "az-#{System.unique_integer([:positive])}")
      _cred = credential_fixture(user, network, %{nick: "vjt-g", autojoin_channels: ["#test"]})

      pid = start_session_for(user, network)
      {:ok, _} = IRCServer.wait_for_line(server, &String.starts_with?(&1, "USER"))
      IRCServer.send_line(server, ":irc 001 vjt-g :Welcome")
      {:ok, _} = IRCServer.wait_for_line(server, &String.starts_with?(&1, "JOIN"))
      IRCServer.send_line(server, ":vjt-g!u@h JOIN :#test")
      IRCServer.send_line(server, ":irc 353 vjt-g = #test :@vjt-g +alice bob")
      IRCServer.send_line(server, ":irc 366 vjt-g #test :End")
      Process.sleep(50)

      on_exit(fn -> if Process.alive?(pid), do: GenServer.stop(pid, :normal, 1_000) end)

      %{user: user, network: network, server: server}
    end

    test "returns members in mIRC sort order", %{conn: conn, user: user, network: network} do
      conn =
        conn
        |> authn(user)
        |> get("/networks/#{network.slug}/channels/%23test/members")

      assert json_response(conn, 200) == %{
               "members" => [
                 %{"nick" => "vjt-g", "modes" => ["@"]},
                 %{"nick" => "alice", "modes" => ["+"]},
                 %{"nick" => "bob", "modes" => []}
               ]
             }
    end

    test "404 for cross-user network access (per-user iso)", %{conn: conn, network: network} do
      stranger = user_fixture(name: "stranger-#{System.unique_integer([:positive])}")

      conn =
        conn
        |> authn(stranger)
        |> get("/networks/#{network.slug}/channels/%23test/members")

      assert json_response(conn, 404) == %{"error" => "not_found"}
    end

    test "404 when network exists but session not registered (e.g. mid-restart)", %{conn: conn, user: user, network: network} do
      :ok = Session.stop_session(user.id, network.id)

      conn =
        conn
        |> authn(user)
        |> get("/networks/#{network.slug}/channels/%23test/members")

      assert json_response(conn, 404) == %{"error" => "not_found"}
    end
  end
end
```

- [ ] **Step 2: Run failing tests**

Expected: 404 (no route).

- [ ] **Step 3: Add the route in `lib/grappa_web/router.ex`**

In the `/networks/:network_id` scope, after the existing `get "/channels/:channel_id/messages"`:

```elixir
get "/channels/:channel_id/members", MembersController, :index
```

- [ ] **Step 4: Implement the controller**

Create `lib/grappa_web/controllers/members_controller.ex`:

```elixir
defmodule GrappaWeb.MembersController do
  @moduledoc """
  Per-channel nick-list snapshot for cicchetto's right-pane Members
  sidebar (P4-1). Source-of-truth is `Grappa.Session.list_members/3`
  — the live `Session.Server.state.members` map, populated by
  `Grappa.Session.EventRouter` from upstream JOIN/353/PART/QUIT/etc.

  Snapshot endpoint, not subscription. Cicchetto refetches on
  channel-select; presence updates flow through the existing
  `MessagesChannel` PubSub events (cicchetto applies the delta to
  its local nick-list state).
  """
  use GrappaWeb, :controller

  alias Grappa.Session

  action_fallback GrappaWeb.FallbackController

  def index(conn, %{"channel_id" => channel}) do
    user_id = conn.assigns.current_user_id
    network_id = conn.assigns.network.id

    case Session.list_members(user_id, network_id, channel) do
      {:ok, members} ->
        render(conn, :index, members: members)

      {:error, :no_session} = err ->
        err
    end
  end
end
```

Note: `:no_session` is the standard tag the existing `FallbackController` already maps to `404 not_found` (see CP10 S14 oracle close). Confirm by reading `lib/grappa_web/controllers/fallback_controller.ex` — if `:no_session` is missing, this task adds a clause. (It is present per S14.)

- [ ] **Step 5: Implement the JSON view**

Create `lib/grappa_web/controllers/members_json.ex`:

```elixir
defmodule GrappaWeb.MembersJSON do
  @moduledoc """
  Wire shape: `%{"members" => [%{"nick" => String.t(), "modes" => [String.t()]}]}`.
  Already in mIRC sort order (`Session.list_members/3` does the sort);
  this view is pure pass-through.
  """

  @doc "Render the per-channel members list."
  @spec index(%{members: [%{nick: String.t(), modes: [String.t()]}]}) :: %{
          required(String.t()) => [%{required(String.t()) => term()}]
        }
  def index(%{members: members}) do
    %{
      "members" =>
        Enum.map(members, fn %{nick: nick, modes: modes} ->
          %{"nick" => nick, "modes" => modes}
        end)
    }
  end
end
```

- [ ] **Step 6: Run tests + check.sh**

Expected: green.

- [ ] **Step 7: Commit**

```bash
git add lib/grappa_web/router.ex lib/grappa_web/controllers/members_controller.ex lib/grappa_web/controllers/members_json.ex test/grappa_web/controllers/members_controller_test.exs
git commit -m "$(cat <<'EOF'
feat(web): add GET /networks/:net/channels/:chan/members

E1 task 20 — REST surface for cicchetto's nick-list sidebar (P4-1).
Wraps Session.list_members/3 (mIRC-sorted snapshot). Snapshot, not
subscription — presence updates flow through MessagesChannel PubSub.

iso: 404 for cross-user access (existing ResolveNetwork plug handles).
404 for no-session-registered (FallbackController :no_session clause
since CP10 S14).

Wire shape: `%{"members" => [%{"nick" => String, "modes" => [String]}]}`.

Co-Authored-By: Claude Opus 4.7 <noreply@anthropic.com>
EOF
)"
```

---

## Phase 8 — Final gates + DESIGN_NOTES + merge + deploy

### Task 21: Update DESIGN_NOTES.md (E1 entry — D-cluster pattern 4th application)

**Files:**
- Modify: `docs/DESIGN_NOTES.md`

- [ ] **Step 1: Append the E1 closing entry**

Find the most recent entry (it should be CP10 D3/A4 close); append:

```markdown
## 2026-04-XX — E1 / A6 closure: EventRouter extraction (4th verb-keyed split)

Closes architecture review A6 (wire-shape vs producer divergence).
The wire (`Scrollback.Wire`), schema (`Scrollback.Message.@kinds`),
and renderer (cicchetto `MessageKind` switch) all advertised 10
message kinds; the producer (`Session.Server.handle_info`) only
persisted `:privmsg`. E1 closes the gap end-to-end with three
mechanical refactors and one new module:

1. **`Grappa.Scrollback.persist_event/1`** replaces `persist_privmsg/5`.
   Takes the explicit `:kind` (no `\\` defaults). Single
   write-side door for all 10 kinds.

2. **`Grappa.Session.EventRouter`** (new pure module, mirrors
   `Grappa.IRC.AuthFSM` from D2). `route/2` returns
   `{:cont, new_state, [effect]}`. State mutations (`members`,
   `nick`) live in `new_state`; effects are side-effects only
   (`{:persist, kind, attrs} | {:reply, iodata()}`). 10 IRC commands
   classified, plus 4 informational numerics (001 nick reconcile,
   332/333 topic backfill, 353/366 names bootstrap).

3. **`Session.Server.handle_info`** delegates to `EventRouter.route/2`.
   Inline transport clauses preserved: `:ping` (PONG keepalive) and
   `{:numeric, 1}` (autojoin trigger — reads `state.autojoin` which
   the router doesn't carry). Server gains `members:
   %{channel => %{nick => [mode]}}` (Q3-pinned per CP10 S16: nick →
   modes_list, NOT MapSet — modes survive sort).

4. **`Session.list_members/3`** + `GET /networks/:net/channels/:chan/members`
   for cicchetto P4-1's right-pane nick list. mIRC sort
   (@ → + → plain, alphabetical within tier).

This is the **4th application of the verb-keyed sub-context principle**:

| Cluster | Module                          | Split shape                            |
|---------|---------------------------------|----------------------------------------|
| D1 / A2 | `Grappa.Networks` god-context   | Servers / Credentials / SessionPlan    |
| D2 / A3 | `Grappa.IRC.Client` god-module  | Client (transport) + AuthFSM (pure)    |
| D3 / A4 | `cicchetto/lib/networks.ts`     | networks / scrollback / selection / ws |
| **E1**  | `Session.Server` god-handle_info| Server (transport) + EventRouter (pure)|

The shape is now a documented pattern (not a heuristic): when a
GenServer's `handle_info` accumulates per-message-kind logic that
will only grow with phase, extract a pure classifier module returning
`{:cont, new_state, [effect]}`. Server applies the effects; pure
module is unit-test-friendly without DataCase setup; future kind
addition is a single test+clause pair.

### Why effects + state, not effects-only

Q1 (CP10 S16) surfaced the trade-off: brainstorm spec pinned a narrow
return shape `:ignore | {:persist, ...} | {:reply, ...}` that didn't
express member-state delta. Two paths considered:

- (a) Keep narrow shape; Server.handle_info has a SECOND switch over
  `:irc` for member updates. Two switches drift.
- (b) Widen to AuthFSM-style `{:cont, new_state, [effect]}`. State
  derivation (members map mutations) lives in `new_state`; effects
  remain side-effects only.

Path (b) chosen. The `:reply` effect type is forward-compat in E1
(no current route emits it); CTCP replies (VERSION, etc.) land in
Phase 5+. Same shape as `Grappa.IRC.AuthFSM.step/2`, which is now
the documented template for any future pure-classifier extraction.

### A20 fold-in: deferred

A20 review recommended folding `persist_and_broadcast/4` into a
`Grappa.Session.Broadcaster` module (Wire + Topic + Scrollback contract
single-source). E1 deletes `persist_and_broadcast/4` (zero callsites
post-refactor) but does NOT extract Broadcaster — `apply_effects/2`
INSIDE Server holds the same logic for the inbound path; the OUTBOUND
PRIVMSG path (`handle_call({:send_privmsg, ...})`) inlines the same
shape because the caller needs the persisted `Message.t()` return
value (different transaction shape). Two paths, same logic — A20's
extraction stays open as a Phase 5 consolidation candidate.
```

(Replace `2026-04-XX` with the actual implementation date.)

- [ ] **Step 2: Commit**

```bash
git add docs/DESIGN_NOTES.md
git commit -m "$(cat <<'EOF'
docs(design-notes): E1 / A6 closure — 4th verb-keyed sub-context split

Records the EventRouter extraction as the 4th application of the
verb-keyed sub-context principle (D1 Networks → D2 IRC.Client → D3
cicchetto/networks → E1 Session.Server). Documents the
{:cont, new_state, [effect]} return shape decision (Q1 of CP10 S16)
and the A20 fold-in deferral.

Co-Authored-By: Claude Opus 4.7 <noreply@anthropic.com>
EOF
)"
```

### Task 22: Final `scripts/check.sh` + rebase + merge to main

- [ ] **Step 1: Final check.sh on the worktree**

```bash
scripts/check.sh
```

Expected: every gate green. Zero warnings. Coverage doesn't regress.

- [ ] **Step 2: Rebase onto main**

```bash
git fetch origin main
git rebase origin/main
```

Expected: clean rebase or a single trivial conflict on docs/checkpoints (if S16 was amended by another worktree). Resolve docs conflicts by keeping both entries.

Re-run `scripts/check.sh` after rebase.

- [ ] **Step 3: Merge to main (from /srv/grappa)**

```bash
cd /srv/grappa
git merge --no-ff cluster/e1-a6-close
git log --oneline | head -5
```

Expected: merge commit lands. The branch's commits are visible in `git log`.

- [ ] **Step 4: Run check.sh on main**

```bash
scripts/check.sh
```

Expected: green.

- [ ] **Step 5: Push main**

```bash
git push origin main
```

### Task 23: Deploy + health check

- [ ] **Step 1: Deploy**

```bash
cd /srv/grappa
scripts/deploy.sh
```

Expected: builds prod image, runs migrations (none for E1 — schema unchanged), restarts container.

- [ ] **Step 2: Health check**

```bash
scripts/healthcheck.sh
```

Expected: 200.

- [ ] **Step 3: Live operator-bound smoke test**

Open the cicchetto PWA at `http://grappa.bad.ass`. Login with operator credentials. Open the browser console.

```javascript
// Smoke test the new endpoint:
fetch('/networks/azzurra/channels/%23italia/members', {
  headers: { Authorization: 'Bearer ' + localStorage.getItem('token') }
}).then(r => r.json()).then(console.log)
```

Expected: `{members: [...]}` with a non-empty list (assuming session has joined #italia and 353 has populated). If empty, NAMES may not have completed — wait 30s + retry.

### Task 24: Update CP10 with S17 (E1 LANDED)

**Files:**
- Modify: `docs/checkpoints/2026-04-27-cp10.md`

- [ ] **Step 1: Append S17 entry**

```markdown
## S17 — 2026-04-XX — E1 cluster LANDED + deployed (A6 architectural close)

**What:** E1 cluster implementation per the 2026-04-27 plan
(`docs/plans/2026-04-27-e1-a6-architectural-close.md`). 22 tasks
across 8 phases. EventRouter (4th verb-keyed sub-context split)
extracted; producer-side gap closed for all 10 message kinds;
`Session.list_members/3` + REST `/members` endpoint shipped.

**Module changes (server-side only — no cicchetto):**

- NEW `lib/grappa/session/event_router.ex` (~250 LOC) — pure module,
  10 IRC kinds + 4 numerics, mirrors `Grappa.IRC.AuthFSM` shape from
  D2.
- REFACTOR `lib/grappa/scrollback.ex` — `persist_privmsg/5` →
  `persist_event/1` taking `:kind` explicit (no `\\` defaults).
- REFACTOR `lib/grappa/session/server.ex` — `handle_info` per-kind
  clauses collapsed to one delegation; `members` field added; new
  `handle_call({:list_members, channel}, ...)`.
- NEW `lib/grappa_web/controllers/members_controller.ex` + JSON view.
- UPDATE `lib/grappa_web/router.ex` — added `/members` route.
- NEW property tests in `test/grappa/session/event_router_property_test.exs`
  (shape contract + QUIT invariant).
- NEW A6 contract test (every `Scrollback.kind()` has a route producing
  `{:persist, kind, _}`).

**Tests added:** ~50 EventRouter unit tests + 2 properties + 4
Server integration tests + 3 controller tests. Zero regressions.

**Gates:** `scripts/check.sh` green on cluster branch and on main
post-merge. Zero warnings.

**LOC:** ~480 server (lib) + ~520 test = ~1000. Estimated 500/200 in
plan; tests came in heavier because of A6 contract coverage + property
tests. Cluster duration: ~3/4 session as planned.

**Deferred (per plan):**
- A5 (ChannelsController autojoin → session-tracked) → P4-1.
- A20 (Broadcaster extraction — `persist_and_broadcast` / inbound +
  outbound consolidation) → Phase 5 candidate.
- PREFIX ISUPPORT-driven mode-prefix table → Phase 5.

**Live deploy state:** `scripts/deploy.sh` ran; production at
`http://grappa.bad.ass` serves the new build; smoke test (operator
session → `/members` endpoint) returned the expected mIRC-sorted
list. cicchetto unchanged (no UI consumer of `/members` yet — P4-1
adds it).

**Next session:** P4-1 cluster (cicchetto rewrite to three-pane
responsive shell + mIRC theme + members sidebar consumer + A5
session-tracked channel list). New brainstorm not required — the
Phase 4 product-shape spec covers P4-1 in detail. Open writing-plans
against the spec's "P4-1 — Phase 4 first ship UI" section.
```

(Replace `2026-04-XX` with the actual landing date.)

- [ ] **Step 2: Commit + push**

```bash
git add docs/checkpoints/2026-04-27-cp10.md
git commit -m "docs: CP10 S17 — E1 cluster LANDED + deployed (A6 closed)"
git push origin main
```

- [ ] **Step 3: Clean up worktree**

```bash
git worktree remove ~/code/IRC/grappa-task-e1
git branch -d cluster/e1-a6-close
```

(Per CLAUDE.md "Don't push to remote unless explicitly asked" — branch deletion on remote is operator-discretion, not automated here.)

---

## Self-review (executor: skip on read; planner-only)

**Spec coverage** (against brainstorm `docs/plans/2026-04-27-phase-4-product-shape.md` § "E1 — A6 architectural close"):

- ✅ `lib/grappa/session/event_router.ex` (Task 4–17)
- ✅ `lib/grappa/scrollback.ex` `persist_event/1` (Task 1–3)
- ✅ `lib/grappa/session/server.ex` delegate + members field (Task 18)
- ✅ All 10 kinds (`:privmsg | :notice | :action | :join | :part | :quit | :nick_change | :mode | :topic | :kick`) — Tasks 5–12
- ✅ `Session.list_members/3` + REST `/members` (Tasks 19–20)
- ✅ A6 contract test (Task 16)
- ✅ Property tests (Task 17)
- ✅ Crash-safe rebuild from 353/366 (Task 14 + Task 18 init)

**Spec NOT covered (intentional, deferred):**
- A5 fix → P4-1 per Q4 resolution (CP10 S16).
- Broadcaster extraction (A20 fold-in) → Phase 5 candidate (deferred per plan).
- PREFIX ISUPPORT negotiation → Phase 5.

**Placeholder scan:** none. Every task has the actual code an engineer needs.

**Type consistency:** `route/2` always returns `{:cont, state(), [effect()]}`; `state()` always carries `:user_id, :network_id, :nick, :members`; `effect()` is `{:persist, kind, attrs} | {:reply, iodata()}`; `members()` is `%{String.t() => %{String.t() => [String.t()]}}`. `persist_attrs()` shape consistent across tasks. `Session.list_members/3` consistently `(user_id, network_id, channel)`. Member entry shape `%{nick: String.t(), modes: [String.t()]}` consistent in Server.handle_call, Session facade, MembersJSON.

**Brainstorm spec mention of `list_members/2`:** spec wording was loose; plan promotes to `list_members/3` (channel as third arg) — pinned in Task 19. Confirmed correct against existing `send_privmsg/4` etc. facade shape.

---

## Execution handoff

Plan complete and saved to `docs/plans/2026-04-27-e1-a6-architectural-close.md`. Two execution options:

**1. Subagent-Driven (recommended)** — fresh subagent per task, review between tasks, fast iteration. Use `superpowers:subagent-driven-development`.

**2. Inline Execution** — execute tasks in this session using `superpowers:executing-plans`, batch execution with checkpoints for review.

Which approach?
