defmodule Grappa.ScrollbackTest do
  @moduledoc """
  Per-user iso (Phase 2 sub-task 2e): every `messages` row carries a
  `user_id` FK + integer `network_id` FK. `fetch/5` filters on both;
  `Wire.to_json/1` emits the network slug (NOT the integer id) and
  does NOT carry the user_id (it's a topic discriminator only, not a
  payload field — clients learn their own user from `/me`).

  `async: false` because every test inserts a user + network row and
  the credential-less write path is still the heaviest in this file —
  collisions with the Phase 2 write-heavy suite under max_cases:2 are
  cheaper to dodge by serializing this file than by bumping
  busy_timeout further (already 30s).
  """
  use Grappa.DataCase, async: false
  use ExUnitProperties

  import Grappa.AuthFixtures

  alias Grappa.{Accounts, Networks, Repo, Scrollback, ScrollbackHelpers}
  alias Grappa.IRC.Identifier
  alias Grappa.Networks.Network
  alias Grappa.Scrollback.{Message, Wire}

  setup do
    {:ok, user} = Accounts.create_user(%{name: "vjt-#{uniq()}", password: "correct horse battery"})
    {:ok, network} = Networks.find_or_create_network(%{slug: "azzurra-#{uniq()}"})
    %{user: user, network: network}
  end

  defp uniq, do: System.unique_integer([:positive])

  defp sample(user, network, i, overrides \\ %{}) do
    Map.merge(
      %{
        user_id: user.id,
        network_id: network.id,
        channel: "#sniffo",
        server_time: i,
        kind: :privmsg,
        sender: "vjt",
        body: "msg #{i}"
      },
      overrides
    )
  end

  describe "insert/1" do
    test "persists a valid message and returns the schema struct", %{user: user, network: net} do
      assert {:ok, %Message{} = m} = ScrollbackHelpers.insert(sample(user, net, 0))
      assert m.body == "msg 0"
      assert m.kind == :privmsg
      assert m.user_id == user.id
      assert m.network_id == net.id
      assert is_integer(m.id)
    end

    test "rejects invalid kind via Ecto.Enum cast", %{user: user, network: net} do
      assert {:error, %Ecto.Changeset{} = cs} =
               ScrollbackHelpers.insert(sample(user, net, 0, %{kind: "bogus"}))

      assert "is invalid" in errors_on(cs).kind
    end

    test "rejects missing required fields (network_id/channel/server_time/kind/sender) and XOR subject" do
      assert {:error, %Ecto.Changeset{} = cs} =
               ScrollbackHelpers.insert(%{channel: "#x"})

      errors = errors_on(cs)
      # B5.4 M-pers-2: subject XOR error attaches to synthetic :subject key,
      # not :user_id (was buggy — always :user_id regardless of which field
      # was actually wrong). user_id is no longer validate_required — XOR
      # validation fires instead.
      assert "must set user_id or visitor_id" in errors.subject
      assert "can't be blank" in errors.network_id
      assert "can't be blank" in errors.server_time
      assert "can't be blank" in errors.kind
      assert "can't be blank" in errors.sender
      refute Map.has_key?(errors, :body)
    end
  end

  describe "persist_event/1 — :network preloading (was persist_privmsg/5)" do
    test "returns the row with :network preloaded so Wire.to_json/1 doesn't need to",
         %{user: user, network: net} do
      # Wire.to_json/1 pattern-matches on `%Network{slug: slug}` and
      # crashes on unloaded assoc. Both callers (Session.Server's
      # persist_and_broadcast → Wire.message_payload, and the REST POST
      # controller → Scrollback.Wire.to_json) used to re-issue a
      # `Repo.preload(message, :network)` after the boundary returned.
      # Pushing the preload into the Scrollback boundary collapses the
      # two parallel preload sites into one — the contract is now "the
      # row I hand back is wire-shape-ready".
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

      assert {:ok, %Message{} = m} = Scrollback.persist_event(attrs)

      assert %Network{id: id, slug: slug} = m.network
      assert id == net.id
      assert slug == net.slug
    end
  end

  # #336 — the SQLite pool saturates under a write burst; `Repo.insert`/
  # `Repo.preload` then RAISE `DBConnection.ConnectionError`
  # (reason: :queue_timeout) rather than returning `{:error, _}`. Before
  # the fix that raise escaped `persist_event/1` and crashed the calling
  # Session.Server, disconnecting the user. Best-effort durability must
  # degrade (retry, then drop) — never take down liveness.
  #
  # The sandbox pool cannot reproduce a real `queue_timeout` (it
  # multiplexes one connection per owner, so there is no checkout queue),
  # so the retry/degrade contract is exercised against
  # `with_pool_retry/1` — the exact production hot-path helper that
  # `persist_event/1` runs both its insert and its preload through — by
  # injecting an op that raises the same exception the pool raises.
  describe "with_pool_retry/1 — pool-saturation resilience (#336)" do
    defp raise_queue_timeout do
      raise %DBConnection.ConnectionError{
        message: "connection not available and request was dropped from queue after 186ms",
        reason: :queue_timeout
      }
    end

    # #340 — a >30s SQLite write-lock busy raises `%Exqlite.Error{}`, NOT a
    # `DBConnection.ConnectionError`. Pre-#340 `with_pool_retry` only rescued
    # the latter, so a busy Exqlite.Error ESCAPED and crashed the session (a
    # latent #336 gap). The message text is the ONLY discriminator SQLite
    # gives us for busy/locked vs syntax/corruption.
    defp raise_busy do
      raise %Exqlite.Error{message: "database is locked", statement: nil}
    end

    defp raise_syntax do
      raise %Exqlite.Error{message: "near \"SLECT\": syntax error", statement: nil}
    end

    test "an op that always raises DBConnection.ConnectionError degrades to {:error, :persist_unavailable} — does NOT escape" do
      assert {:error, :persist_unavailable} =
               Scrollback.with_pool_retry(fn -> raise_queue_timeout() end)
    end

    test "retries transient pool exhaustion and succeeds once a checkout is served" do
      # Fail for the first two attempts, succeed on the third — proves the
      # bounded retry actually re-drives the op rather than degrading on the
      # first raise.
      {:ok, counter} = Agent.start_link(fn -> 0 end)

      op = fn ->
        n = Agent.get_and_update(counter, fn n -> {n, n + 1} end)
        if n < 2, do: raise_queue_timeout(), else: {:ok, :served}
      end

      assert {:ok, :served} = Scrollback.with_pool_retry(op)
      assert Agent.get(counter, & &1) == 3
    end

    test "a plain {:error, changeset} passes through unchanged — validation errors are NOT retried" do
      cs = Message.changeset(%Message{}, %{channel: "#x"})

      assert {:error, ^cs} = Scrollback.with_pool_retry(fn -> {:error, cs} end)
    end

    # #340 broadened catch — a busy/locked Exqlite.Error is a TRANSIENT
    # write-lock contention (SQLite is single-writer; a burst makes a slow
    # writer wait, occasionally past busy_timeout). It must be treated like
    # a pool queue_timeout: retried, then degraded — never escape.
    test "an op that always raises a busy Exqlite.Error degrades to {:error, :persist_unavailable} — does NOT escape" do
      assert {:error, :persist_unavailable} =
               Scrollback.with_pool_retry(fn -> raise_busy() end)
    end

    test "a busy Exqlite.Error that clears within the budget is retried then succeeds" do
      {:ok, counter} = Agent.start_link(fn -> 0 end)

      op = fn ->
        n = Agent.get_and_update(counter, fn n -> {n, n + 1} end)
        if n < 2, do: raise_busy(), else: {:ok, :served}
      end

      assert {:ok, :served} = Scrollback.with_pool_retry(op)
      assert Agent.get(counter, & &1) == 3
    end

    # #340 generous budget — the loop rides out MANY transient raises within
    # its wall-clock budget, so a NORMAL message caught behind a burst is
    # never dropped. Six consecutive busy raises exceed the pre-#340 fixed
    # 3-attempt cap; the budget must still ride them out and succeed.
    test "the generous budget rides out N transient raises then succeeds" do
      {:ok, counter} = Agent.start_link(fn -> 0 end)

      op = fn ->
        n = Agent.get_and_update(counter, fn n -> {n, n + 1} end)
        if n < 6, do: raise_busy(), else: {:ok, :served}
      end

      assert {:ok, :served} = Scrollback.with_pool_retry(op)
      assert Agent.get(counter, & &1) == 7
    end

    # #340 — a NON-transient Exqlite.Error (syntax/corruption) is not
    # saturation: retrying only spins pointlessly. It degrades IMMEDIATELY
    # (still never crashing the session — the #336 contract) after exactly
    # ONE attempt.
    test "a non-transient Exqlite.Error degrades WITHOUT spinning (exactly one attempt)" do
      {:ok, counter} = Agent.start_link(fn -> 0 end)

      op = fn ->
        Agent.update(counter, &(&1 + 1))
        raise_syntax()
      end

      assert {:error, :persist_unavailable} = Scrollback.with_pool_retry(op)
      assert Agent.get(counter, & &1) == 1
    end
  end

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

      # `apply/3` so Elixir's set-theoretic type analyzer doesn't
      # flag the deliberately-malformed call at compile time. The
      # contract under test is the runtime FunctionClauseError —
      # `def persist_event(%{kind: kind} = attrs) when is_atom(kind)`
      # has no defaulting fallback by design (CLAUDE.md "No `\\` defaults").
      assert_raise FunctionClauseError, fn ->
        apply(Scrollback, :persist_event, [attrs])
      end
    end

    # CP14 B3: `:dm_with` is a normalized "DM peer" column populated at
    # persist-time on PRIVMSGs whose `target == own_nick` OR `sender ==
    # own_nick`. Solves the "DM history shows only outbound" bug
    # permanently — also resilient to own-nick rotation, since the column
    # is computed from whichever side is the peer at persist time, never
    # from a possibly-stale own-nick lookup at fetch.
    #
    # `persist_event/1` is the simple persist surface — caller injects the
    # already-computed `:dm_with` (the EventRouter's `build_persist` is the
    # canonical site, where `state.nick` is in scope). The schema casts
    # the field; no per-kind validation. nil for non-DM rows (channel
    # messages, presence events, etc.).
    test "persists :dm_with attribute when caller injects it (DM PRIVMSG to own-nick)",
         %{user: user, network: net} do
      attrs = %{
        user_id: user.id,
        network_id: net.id,
        # `target = own_nick` so peer = sender = "vjt-peer"
        channel: "vjt-grappa",
        server_time: 0,
        kind: :privmsg,
        sender: "vjt-peer",
        body: "hey",
        meta: %{},
        dm_with: "vjt-peer"
      }

      assert {:ok, %Message{dm_with: "vjt-peer"}} = Scrollback.persist_event(attrs)
    end

    test "persists :dm_with attribute when caller injects it (DM PRIVMSG from own-nick)",
         %{user: user, network: net} do
      attrs = %{
        user_id: user.id,
        network_id: net.id,
        # outbound: target = peer, sender = own_nick
        channel: "vjt-peer",
        server_time: 0,
        kind: :privmsg,
        sender: "vjt-grappa",
        body: "ciao",
        meta: %{},
        dm_with: "vjt-peer"
      }

      assert {:ok, %Message{dm_with: "vjt-peer"}} = Scrollback.persist_event(attrs)
    end

    test "persists :dm_with = nil for non-DM (channel) PRIVMSG when caller injects nil",
         %{user: user, network: net} do
      attrs = %{
        user_id: user.id,
        network_id: net.id,
        channel: "#sniffo",
        server_time: 0,
        kind: :privmsg,
        sender: "alice",
        body: "channel msg",
        meta: %{},
        dm_with: nil
      }

      assert {:ok, %Message{dm_with: nil}} = Scrollback.persist_event(attrs)
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

    # M8 fix 2026-05-08: per-kind dm_with validation. Pre-M8 the @spec
    # declared `optional(:dm_with) => String.t() | nil` but enforcement
    # of "dm_with is only meaningful on :privmsg / :action rows" was
    # informal — the schema cast it for ANY kind. A caller bug
    # (forgetting to nil it on a :join row, or setting it on a
    # presence event) silently persisted a non-nil dm_with on a
    # non-DM row, contaminating the active/archive view-derivation
    # rule. Per-kind validation pins the contract in the changeset.
    test "rejects non-nil :dm_with on a non-DM kind (:join)", %{user: user, network: net} do
      attrs = %{
        user_id: user.id,
        network_id: net.id,
        channel: "#sniffo",
        server_time: 0,
        kind: :join,
        sender: "alice",
        body: nil,
        meta: %{},
        dm_with: "vjt-peer"
      }

      assert {:error, %Ecto.Changeset{} = cs} = Scrollback.persist_event(attrs)
      assert "may only be set on :privmsg or :action rows" in errors_on(cs).dm_with
    end

    test "rejects non-nil :dm_with on a non-DM kind (:topic)", %{user: user, network: net} do
      attrs = %{
        user_id: user.id,
        network_id: net.id,
        channel: "#sniffo",
        server_time: 0,
        kind: :topic,
        sender: "vjt",
        body: "the new topic",
        meta: %{},
        dm_with: "vjt-peer"
      }

      assert {:error, %Ecto.Changeset{} = cs} = Scrollback.persist_event(attrs)
      assert "may only be set on :privmsg or :action rows" in errors_on(cs).dm_with
    end

    test "accepts :dm_with = nil on any non-DM kind (no false positive)",
         %{user: user, network: net} do
      attrs = %{
        user_id: user.id,
        network_id: net.id,
        channel: "#sniffo",
        server_time: 0,
        kind: :join,
        sender: "alice",
        body: nil,
        meta: %{},
        dm_with: nil
      }

      assert {:ok, %Message{kind: :join, dm_with: nil}} = Scrollback.persist_event(attrs)
    end
  end

  describe "extended kinds + nullable body + meta (Task 8 schema future-proofing)" do
    test "accepts :join with nil body and default meta map", %{user: user, network: net} do
      assert {:ok, %Message{kind: :join, body: nil, meta: %{}}} =
               ScrollbackHelpers.insert(sample(user, net, 0, %{kind: :join, sender: "alice", body: nil}))
    end

    test "accepts :kick with body (reason) + atom-keyed meta carrying target nick",
         %{user: user, network: net} do
      {:ok, inserted} =
        ScrollbackHelpers.insert(
          sample(user, net, 0, %{
            kind: :kick,
            sender: "vjt",
            body: "rude",
            meta: %{target: "alice"}
          })
        )

      assert inserted.meta == %{target: "alice"}

      [fetched] = Scrollback.fetch({:user, user.id}, net.id, "#sniffo", nil, 10, nil)
      assert fetched.meta == %{target: "alice"}
    end

    test "rejects :privmsg without body (per-kind body required for content-bearing kinds)",
         %{user: user, network: net} do
      assert {:error, %Ecto.Changeset{} = cs} =
               ScrollbackHelpers.insert(sample(user, net, 0, %{kind: :privmsg, sender: "vjt", body: nil}))

      assert "can't be blank" in errors_on(cs).body
    end

    test "rejects :topic without body (per-kind body required)", %{user: user, network: net} do
      assert {:error, %Ecto.Changeset{} = cs} =
               ScrollbackHelpers.insert(sample(user, net, 0, %{kind: :topic, sender: "ChanServ", body: nil}))

      assert "can't be blank" in errors_on(cs).body
    end

    test "accepts all 10 extended kinds with appropriate body/meta shape",
         %{user: user, network: net} do
      cases = [
        {:privmsg, %{body: "hi"}},
        {:notice, %{body: "system notice"}},
        {:action, %{body: "slaps trout"}},
        {:join, %{body: nil}},
        {:part, %{body: nil}},
        {:quit, %{body: "Connection reset"}},
        {:nick_change, %{body: nil, meta: %{new_nick: "vjt2"}}},
        {:mode, %{body: nil, meta: %{modes: "+o", args: ["alice"]}}},
        {:topic, %{body: "new channel topic"}},
        {:kick, %{body: "rude", meta: %{target: "alice"}}}
      ]

      for {kind, overrides} <- cases do
        attrs = sample(user, net, 0, Map.merge(%{kind: kind, sender: "vjt"}, overrides))

        assert {:ok, %Message{kind: ^kind}} = ScrollbackHelpers.insert(attrs),
               "kind #{inspect(kind)} should be accepted"
      end
    end
  end

  describe "fetch/5" do
    test "returns the latest page in descending server_time order",
         %{user: user, network: net} do
      for i <- 0..4, do: {:ok, _} = ScrollbackHelpers.insert(sample(user, net, i))

      page = Scrollback.fetch({:user, user.id}, net.id, "#sniffo", nil, 3, nil)

      assert length(page) == 3
      assert Enum.map(page, & &1.body) == ["msg 4", "msg 3", "msg 2"]
    end

    test "paginates by `before` cursor (strict less-than on id post-CP29 R-2)",
         %{user: user, network: net} do
      for i <- 0..4, do: {:ok, _} = ScrollbackHelpers.insert(sample(user, net, i))

      [_, last_of_first_page] = Scrollback.fetch({:user, user.id}, net.id, "#sniffo", nil, 2, nil)
      next_page = Scrollback.fetch({:user, user.id}, net.id, "#sniffo", last_of_first_page.id, 2, nil)

      assert Enum.map(next_page, & &1.body) == ["msg 2", "msg 1"]
    end

    test "isolates rows by (network_id, channel)", %{user: user, network: net} do
      {:ok, other_net} = Networks.find_or_create_network(%{slug: "freenode-#{uniq()}"})

      {:ok, _} = ScrollbackHelpers.insert(sample(user, net, 0, %{channel: "#a"}))
      {:ok, _} = ScrollbackHelpers.insert(sample(user, net, 1, %{channel: "#b"}))
      {:ok, _} = ScrollbackHelpers.insert(sample(user, other_net, 2, %{channel: "#a"}))

      page = Scrollback.fetch({:user, user.id}, net.id, "#a", nil, 10, nil)
      assert length(page) == 1
      assert hd(page).channel == "#a"
    end

    test "PER-USER ISO: alice's rows are NOT visible when fetching as vjt (the central 2e invariant)",
         %{user: vjt, network: net} do
      {:ok, alice} =
        Accounts.create_user(%{name: "alice-#{uniq()}", password: "correct horse battery"})

      # Both users write to the SAME (network, channel). The DB row stream is
      # one (one row per user write); the fetch surface MUST partition.
      {:ok, _} = ScrollbackHelpers.insert(sample(vjt, net, 0, %{sender: "vjt", body: "vjt-msg"}))
      {:ok, _} = ScrollbackHelpers.insert(sample(alice, net, 1, %{sender: "alice", body: "alice-msg"}))

      vjt_page = Scrollback.fetch({:user, vjt.id}, net.id, "#sniffo", nil, 10, nil)
      assert length(vjt_page) == 1
      assert hd(vjt_page).body == "vjt-msg"

      alice_page = Scrollback.fetch({:user, alice.id}, net.id, "#sniffo", nil, 10, nil)
      assert length(alice_page) == 1
      assert hd(alice_page).body == "alice-msg"
    end

    test "returns [] when nothing matches", %{user: user, network: net} do
      assert Scrollback.fetch({:user, user.id}, net.id, "#empty", nil, 10, nil) == []
    end

    # B5.4 L-pers-2: an unknown subject discriminator was previously a
    # silent FunctionClauseError from `subject_where/2`'s pattern-match
    # — the Erlang-level message hid both the offending value and the
    # function name. Add an explicit fall-through that raises
    # ArgumentError with the inspected subject, so caller bugs (typo
    # like `:users`, accidental `nil`, leftover atom from a refactor)
    # surface with actionable diagnostics.
    test "raises ArgumentError on unknown subject discriminator", %{network: net} do
      assert_raise ArgumentError, ~r/unknown subject:/, fn ->
        Scrollback.fetch({:typo, "x"}, net.id, "#sniffo", nil, 10, nil)
      end
    end

    test "raises ArgumentError on subject where the discriminator is nil", %{network: net} do
      assert_raise ArgumentError, ~r/unknown subject:/, fn ->
        Scrollback.fetch(nil, net.id, "#sniffo", nil, 10, nil)
      end
    end

    # A26: every row is returned with `:network` preloaded so callers
    # can hand the result straight to `Scrollback.Wire.to_json/1`
    # (which pattern-matches on `%Network{slug: _}` and crashes on
    # unloaded assoc). Mirrors the same wire-shape-ready contract that
    # `persist_event/1` carries (A4); previously the controller had
    # to do its own `preload_networks/2` post-fetch.
    test "returns rows with :network preloaded so callers can render to wire shape",
         %{user: user, network: net} do
      for i <- 0..2, do: {:ok, _} = ScrollbackHelpers.insert(sample(user, net, i))

      page = Scrollback.fetch({:user, user.id}, net.id, "#sniffo", nil, 10, nil)

      assert length(page) == 3

      for row <- page do
        assert %Network{id: id, slug: slug} = row.network
        assert id == net.id
        assert slug == net.slug
      end
    end

    test "clamps limit to max_page_size/0", %{user: user, network: net} do
      cap = Scrollback.max_page_size()

      for i <- 0..(cap + 4), do: {:ok, _} = ScrollbackHelpers.insert(sample(user, net, i))

      page = Scrollback.fetch({:user, user.id}, net.id, "#sniffo", nil, cap + 1_000, nil)
      assert length(page) == cap
    end

    test "raises FunctionClauseError on non-positive limit", %{user: user, network: net} do
      assert_raise FunctionClauseError, fn ->
        Scrollback.fetch({:user, user.id}, net.id, "#sniffo", nil, 0, nil)
      end
    end
  end

  # Message-replay-on-reconnect cluster — server-side delta for the
  # cic backfill flow. `fetch_after/6` mirror-symmetric to `fetch/6`
  # but with cursor on `id > after_id` (NOT server_time): the wire
  # already exposes `id` (`Wire.to_json/1`), the auto-increment is
  # monotonic, and using id avoids the same-ms-collision class the
  # existing `before:` cursor docstring warns about. Returns rows in
  # ASC `id` order so cic can append in chronological sequence
  # without flipping in the consumer.
  describe "fetch_after/6" do
    test "returns rows strictly after `after_id` in ASCENDING id order",
         %{user: user, network: net} do
      rows =
        for i <- 0..4 do
          {:ok, m} = ScrollbackHelpers.insert(sample(user, net, i))
          m
        end

      [_, _, m2 | _] = rows

      page = Scrollback.fetch_after({:user, user.id}, net.id, "#sniffo", m2.id, 10, nil)

      assert Enum.map(page, & &1.body) == ["msg 3", "msg 4"]
    end

    test "returns [] when after_id is the newest row", %{user: user, network: net} do
      latest =
        for i <- 0..2 do
          {:ok, m} = ScrollbackHelpers.insert(sample(user, net, i))
          m
        end
        |> List.last()

      assert Scrollback.fetch_after({:user, user.id}, net.id, "#sniffo", latest.id, 10, nil) == []
    end

    test "returns [] when after_id is greater than the newest row id",
         %{user: user, network: net} do
      for i <- 0..2, do: {:ok, _} = ScrollbackHelpers.insert(sample(user, net, i))

      assert Scrollback.fetch_after({:user, user.id}, net.id, "#sniffo", 999_999_999, 10, nil) == []
    end

    test "after_id of a deleted/non-existent row still returns rows with id > that value",
         %{user: user, network: net} do
      # The cursor is a numeric comparison, NOT a join — referenced row
      # need not exist. Cic might persist the last-seen id, then the
      # operator hard-deletes that row via a future admin path; the
      # backfill must still be able to resume from the gap.
      rows =
        for i <- 0..3 do
          {:ok, m} = ScrollbackHelpers.insert(sample(user, net, i))
          m
        end

      [m0, _, m2, m3] = rows

      # Pick an id that is between m0 and m2 but not in the table.
      gap_id = m0.id + 1
      Repo.delete!(Enum.at(rows, 1))

      page = Scrollback.fetch_after({:user, user.id}, net.id, "#sniffo", gap_id, 10, nil)
      assert Enum.map(page, & &1.id) == [m2.id, m3.id]
    end

    test "filters by (user_id, network_id, channel) — same per-user iso as fetch/5",
         %{user: user, network: net} do
      {:ok, other_net} = Networks.find_or_create_network(%{slug: "freenode-#{uniq()}"})
      {:ok, alice} = Accounts.create_user(%{name: "alice-#{uniq()}", password: "correct horse battery"})

      {:ok, mine} = ScrollbackHelpers.insert(sample(user, net, 0, %{body: "mine"}))
      {:ok, _} = ScrollbackHelpers.insert(sample(user, net, 1, %{channel: "#other", body: "wrong-chan"}))
      {:ok, _} = ScrollbackHelpers.insert(sample(user, other_net, 2, %{body: "wrong-net"}))
      {:ok, _} = ScrollbackHelpers.insert(sample(alice, net, 3, %{sender: "alice", body: "wrong-user"}))

      page = Scrollback.fetch_after({:user, user.id}, net.id, "#sniffo", mine.id - 1, 10, nil)
      assert Enum.map(page, & &1.body) == ["mine"]
    end

    test "clamps limit to max_page_size/0", %{user: user, network: net} do
      cap = Scrollback.max_page_size()

      first_id_seed =
        for i <- 0..(cap + 4) do
          {:ok, m} = ScrollbackHelpers.insert(sample(user, net, i))
          m
        end
        |> hd()

      page = Scrollback.fetch_after({:user, user.id}, net.id, "#sniffo", first_id_seed.id - 1, cap + 1_000, nil)
      assert length(page) == cap
    end

    test "raises FunctionClauseError on non-positive limit", %{user: user, network: net} do
      assert_raise FunctionClauseError, fn ->
        Scrollback.fetch_after({:user, user.id}, net.id, "#sniffo", 1, 0, nil)
      end
    end

    test "rows have :network preloaded — wire-shape-ready contract",
         %{user: user, network: net} do
      {:ok, m0} = ScrollbackHelpers.insert(sample(user, net, 0))
      {:ok, _} = ScrollbackHelpers.insert(sample(user, net, 1))

      [row | _] = Scrollback.fetch_after({:user, user.id}, net.id, "#sniffo", m0.id, 10, nil)
      assert %Network{id: id, slug: slug} = row.network
      assert id == net.id
      assert slug == net.slug
    end

    test "DM bidirectional — peer target merges inbound + outbound after the cursor",
         %{user: user, network: net} do
      # Outbound /msg peer → channel=peer
      {:ok, outbound} =
        Scrollback.persist_event(%{
          user_id: user.id,
          network_id: net.id,
          channel: "peer",
          server_time: 100,
          kind: :privmsg,
          sender: "vjt-grappa",
          body: "out",
          meta: %{},
          dm_with: "peer"
        })

      # Inbound peer→ownnick → channel=ownnick, dm_with=peer
      {:ok, inbound} =
        Scrollback.persist_event(%{
          user_id: user.id,
          network_id: net.id,
          channel: "vjt-grappa",
          server_time: 101,
          kind: :privmsg,
          sender: "peer",
          body: "in",
          meta: %{},
          dm_with: "peer"
        })

      page = Scrollback.fetch_after({:user, user.id}, net.id, "peer", outbound.id - 1, 10, "vjt-grappa")
      assert Enum.map(page, & &1.id) == [outbound.id, inbound.id]
    end

    test "own-nick query window narrows to self-msgs only when own_nick supplied",
         %{user: user, network: net} do
      # Inbound DM from peer (channel=ownnick, dm_with=peer) — must NOT
      # leak into own-nick window's backfill.
      {:ok, _} =
        Scrollback.persist_event(%{
          user_id: user.id,
          network_id: net.id,
          channel: "vjt-grappa",
          server_time: 100,
          kind: :privmsg,
          sender: "peer",
          body: "from-peer",
          meta: %{},
          dm_with: "peer"
        })

      # Self-msg /msg ownnick (channel=ownnick, dm_with=ownnick).
      {:ok, self_msg} =
        Scrollback.persist_event(%{
          user_id: user.id,
          network_id: net.id,
          channel: "vjt-grappa",
          server_time: 101,
          kind: :privmsg,
          sender: "vjt-grappa",
          body: "to-self",
          meta: %{},
          dm_with: "vjt-grappa"
        })

      page = Scrollback.fetch_after({:user, user.id}, net.id, "vjt-grappa", 0, 10, "vjt-grappa")
      assert Enum.map(page, & &1.id) == [self_msg.id]
    end

    test "5-arity wrapper passes nil own_nick (channel-shape default)",
         %{user: user, network: net} do
      {:ok, m0} = ScrollbackHelpers.insert(sample(user, net, 0))
      {:ok, m1} = ScrollbackHelpers.insert(sample(user, net, 1))

      page = Scrollback.fetch_after({:user, user.id}, net.id, "#sniffo", m0.id, 10, nil)
      assert Enum.map(page, & &1.id) == [m1.id]
    end
  end

  # Cursor-derived unread-badge primitive (2026-06-01). Mirrors
  # `fetch_after/6`'s predicate so the count exactly matches what an
  # uncapped fetch would return — Phoenix Channel `join_reply` + cic
  # fallback seed share the same source of truth as the local
  # scrollback-derived count cic computes on its own.
  describe "count_after/5" do
    test "zero cursor counts every row for (subject, network, channel)",
         %{user: user, network: net} do
      for i <- 0..4, do: {:ok, _} = ScrollbackHelpers.insert(sample(user, net, i))

      assert Scrollback.count_after({:user, user.id}, net.id, "#sniffo", 0, nil) == 5
    end

    test "cursor at the newest row id returns 0",
         %{user: user, network: net} do
      latest =
        for i <- 0..2 do
          {:ok, m} = ScrollbackHelpers.insert(sample(user, net, i))
          m
        end
        |> List.last()

      assert Scrollback.count_after({:user, user.id}, net.id, "#sniffo", latest.id, nil) == 0
    end

    test "past-tail cursor returns 0", %{user: user, network: net} do
      for i <- 0..2, do: {:ok, _} = ScrollbackHelpers.insert(sample(user, net, i))

      assert Scrollback.count_after({:user, user.id}, net.id, "#sniffo", 999_999_999, nil) == 0
    end

    test "counts only rows strictly greater than after_id",
         %{user: user, network: net} do
      rows =
        for i <- 0..4 do
          {:ok, m} = ScrollbackHelpers.insert(sample(user, net, i))
          m
        end

      [_, _, m2 | _] = rows

      assert Scrollback.count_after({:user, user.id}, net.id, "#sniffo", m2.id, nil) == 2
    end

    test "isolated by (subject, network, channel) — same shape as fetch_after",
         %{user: user, network: net} do
      {:ok, other_net} = Networks.find_or_create_network(%{slug: "freenode-#{uniq()}"})
      {:ok, alice} = Accounts.create_user(%{name: "alice-#{uniq()}", password: "correct horse battery"})

      {:ok, _} = ScrollbackHelpers.insert(sample(user, net, 0, %{body: "mine"}))
      {:ok, _} = ScrollbackHelpers.insert(sample(user, net, 1, %{channel: "#other", body: "wrong-chan"}))
      {:ok, _} = ScrollbackHelpers.insert(sample(user, other_net, 2, %{body: "wrong-net"}))
      {:ok, _} = ScrollbackHelpers.insert(sample(alice, net, 3, %{sender: "alice", body: "wrong-user"}))

      assert Scrollback.count_after({:user, user.id}, net.id, "#sniffo", 0, nil) == 1
    end

    test "DM bidirectional — peer target counts inbound + outbound after the cursor",
         %{user: user, network: net} do
      {:ok, outbound} =
        Scrollback.persist_event(%{
          user_id: user.id,
          network_id: net.id,
          channel: "peer",
          server_time: 100,
          kind: :privmsg,
          sender: "vjt-grappa",
          body: "out",
          meta: %{},
          dm_with: "peer"
        })

      {:ok, _} =
        Scrollback.persist_event(%{
          user_id: user.id,
          network_id: net.id,
          channel: "vjt-grappa",
          server_time: 101,
          kind: :privmsg,
          sender: "peer",
          body: "in",
          meta: %{},
          dm_with: "peer"
        })

      assert Scrollback.count_after(
               {:user, user.id},
               net.id,
               "peer",
               outbound.id - 1,
               "vjt-grappa"
             ) == 2
    end

    test "own-nick window narrows to self-msgs only — inbound DMs don't inflate",
         %{user: user, network: net} do
      {:ok, _} =
        Scrollback.persist_event(%{
          user_id: user.id,
          network_id: net.id,
          channel: "vjt-grappa",
          server_time: 100,
          kind: :privmsg,
          sender: "peer",
          body: "from-peer",
          meta: %{},
          dm_with: "peer"
        })

      {:ok, _} =
        Scrollback.persist_event(%{
          user_id: user.id,
          network_id: net.id,
          channel: "vjt-grappa",
          server_time: 101,
          kind: :privmsg,
          sender: "vjt-grappa",
          body: "to-self",
          meta: %{},
          dm_with: "vjt-grappa"
        })

      assert Scrollback.count_after(
               {:user, user.id},
               net.id,
               "vjt-grappa",
               0,
               "vjt-grappa"
             ) == 1
    end

    test "is NOT capped by @max_limit — surface the true unread count",
         %{user: user, network: net} do
      cap = Scrollback.max_page_size()

      for i <- 0..(cap + 4), do: {:ok, _} = ScrollbackHelpers.insert(sample(user, net, i))

      total = cap + 5
      assert Scrollback.count_after({:user, user.id}, net.id, "#sniffo", 0, nil) == total
    end
  end

  # Bucket C (2026-06-01) — `count_after_split/5` returns the count
  # split into `%{messages, events}` via a single CASE-WHEN GROUP BY.
  # cic's `serverSeedCounts` consumes this shape (each badge renders
  # messages bold + events faint separately).
  describe "count_after_split/5" do
    test "zero cursor splits all rows by content vs presence kind",
         %{user: user, network: net} do
      {:ok, _} = ScrollbackHelpers.insert(sample(user, net, 0, %{kind: :privmsg}))
      {:ok, _} = ScrollbackHelpers.insert(sample(user, net, 1, %{kind: :notice}))
      {:ok, _} = ScrollbackHelpers.insert(sample(user, net, 2, %{kind: :action}))
      {:ok, _} = ScrollbackHelpers.insert(sample(user, net, 3, %{kind: :join, body: nil}))
      {:ok, _} = ScrollbackHelpers.insert(sample(user, net, 4, %{kind: :part, body: nil}))
      {:ok, _} = ScrollbackHelpers.insert(sample(user, net, 5, %{kind: :quit, body: nil}))

      assert Scrollback.count_after_split({:user, user.id}, net.id, "#sniffo", 0, nil) ==
               %{messages: 3, events: 3}
    end

    test "returns %{messages: 0, events: 0} for empty partition",
         %{user: user, network: net} do
      assert Scrollback.count_after_split({:user, user.id}, net.id, "#empty", 0, nil) ==
               %{messages: 0, events: 0}
    end

    test "returns %{messages: 0, events: 0} for past-tail cursor",
         %{user: user, network: net} do
      for i <- 0..2, do: {:ok, _} = ScrollbackHelpers.insert(sample(user, net, i))

      assert Scrollback.count_after_split({:user, user.id}, net.id, "#sniffo", 999_999_999, nil) ==
               %{messages: 0, events: 0}
    end

    test "respects after_id strict-greater predicate",
         %{user: user, network: net} do
      {:ok, m0} = ScrollbackHelpers.insert(sample(user, net, 0, %{kind: :privmsg}))
      {:ok, _} = ScrollbackHelpers.insert(sample(user, net, 1, %{kind: :join, body: nil}))
      {:ok, _} = ScrollbackHelpers.insert(sample(user, net, 2, %{kind: :privmsg}))

      assert Scrollback.count_after_split({:user, user.id}, net.id, "#sniffo", m0.id, nil) ==
               %{messages: 1, events: 1}
    end

    test "channel-only partition — content-only channel returns events: 0",
         %{user: user, network: net} do
      {:ok, _} = ScrollbackHelpers.insert(sample(user, net, 0, %{kind: :privmsg}))
      {:ok, _} = ScrollbackHelpers.insert(sample(user, net, 1, %{kind: :notice}))

      assert Scrollback.count_after_split({:user, user.id}, net.id, "#sniffo", 0, nil) ==
               %{messages: 2, events: 0}
    end

    test "presence-only channel returns messages: 0",
         %{user: user, network: net} do
      {:ok, _} = ScrollbackHelpers.insert(sample(user, net, 0, %{kind: :join, body: nil}))
      {:ok, _} = ScrollbackHelpers.insert(sample(user, net, 1, %{kind: :mode, body: nil}))

      assert Scrollback.count_after_split({:user, user.id}, net.id, "#sniffo", 0, nil) ==
               %{messages: 0, events: 2}
    end
  end

  # CP14 B3 — DM history bidirectional via :dm_with.
  #
  # Bug: cic's loadInitialScrollback(peer) for a DM (query) window
  # only fetched ?channel=peer; outbound messages persist there
  # (channel=peer when own_nick sends to peer) but inbound persist on
  # channel=own_nick (IRC framing). So query window showed only
  # outbound. The :dm_with column normalizes the "DM peer" so a
  # single fetch returns both directions. Server detects peer-shaped
  # channel name (no #/&/!/+ sigil, not "$server") and adds an
  # or_where(dm_with: ^channel) branch.
  describe "fetch/5 — :dm_with bidirectional DM (CP14 B3)" do
    test "peer-shaped channel returns inbound (dm_with == peer) AND outbound (channel == peer) merged",
         %{user: user, network: net} do
      # Outbound: vjt-grappa → vjt-peer (channel=peer, dm_with=peer).
      {:ok, _} =
        Scrollback.persist_event(%{
          user_id: user.id,
          network_id: net.id,
          channel: "vjt-peer",
          server_time: 100,
          kind: :privmsg,
          sender: "vjt-grappa",
          body: "ciao",
          meta: %{},
          dm_with: "vjt-peer"
        })

      # Inbound: vjt-peer → vjt-grappa (channel=own_nick, dm_with=peer).
      {:ok, _} =
        Scrollback.persist_event(%{
          user_id: user.id,
          network_id: net.id,
          channel: "vjt-grappa",
          server_time: 200,
          kind: :privmsg,
          sender: "vjt-peer",
          body: "ehi",
          meta: %{},
          dm_with: "vjt-peer"
        })

      # Channel-keyed row with same peer name as a string but different
      # context — e.g. "#vjt-peer" wouldn't fall here because of the
      # sigil — but a non-DM row with channel == "other-peer" should NOT
      # appear in a fetch for "vjt-peer".
      {:ok, _} =
        Scrollback.persist_event(%{
          user_id: user.id,
          network_id: net.id,
          channel: "other-peer",
          server_time: 150,
          kind: :privmsg,
          sender: "vjt-grappa",
          body: "to a third party",
          meta: %{},
          dm_with: "other-peer"
        })

      # Fetch for the DM window for vjt-peer — both directions present,
      # sorted desc by server_time.
      page = Scrollback.fetch({:user, user.id}, net.id, "vjt-peer", nil, 10, nil)
      assert Enum.map(page, &{&1.server_time, &1.body}) == [{200, "ehi"}, {100, "ciao"}]
    end

    test "peer-shaped channel does NOT pull rows from other peers' DM threads",
         %{user: user, network: net} do
      # Inbound from peer-A in vjt-grappa's window.
      {:ok, _} =
        Scrollback.persist_event(%{
          user_id: user.id,
          network_id: net.id,
          channel: "vjt-grappa",
          server_time: 100,
          kind: :privmsg,
          sender: "peer-a",
          body: "from A",
          meta: %{},
          dm_with: "peer-a"
        })

      # Inbound from peer-B in vjt-grappa's window.
      {:ok, _} =
        Scrollback.persist_event(%{
          user_id: user.id,
          network_id: net.id,
          channel: "vjt-grappa",
          server_time: 200,
          kind: :privmsg,
          sender: "peer-b",
          body: "from B",
          meta: %{},
          dm_with: "peer-b"
        })

      page_a = Scrollback.fetch({:user, user.id}, net.id, "peer-a", nil, 10, nil)
      assert Enum.map(page_a, & &1.body) == ["from A"]

      page_b = Scrollback.fetch({:user, user.id}, net.id, "peer-b", nil, 10, nil)
      assert Enum.map(page_b, & &1.body) == ["from B"]
    end

    test "channel-shaped target (#chan) ignores dm_with — pure channel-keyed fetch",
         %{user: user, network: net} do
      {:ok, _} =
        Scrollback.persist_event(%{
          user_id: user.id,
          network_id: net.id,
          channel: "#sniffo",
          server_time: 100,
          kind: :privmsg,
          sender: "alice",
          body: "channel msg",
          meta: %{},
          dm_with: nil
        })

      # A defensive belt-and-suspenders row: pretend a DM exists with
      # dm_with = "#sniffo" (impossible in practice, but if it did,
      # fetch on "#sniffo" must NOT pull it via the dm_with branch
      # because channel-shaped names short-circuit dm_with merging).
      {:ok, _} =
        Scrollback.persist_event(%{
          user_id: user.id,
          network_id: net.id,
          channel: "vjt-grappa",
          server_time: 200,
          kind: :privmsg,
          sender: "evil",
          body: "spoof",
          meta: %{},
          dm_with: "#sniffo"
        })

      page = Scrollback.fetch({:user, user.id}, net.id, "#sniffo", nil, 10, nil)
      assert Enum.map(page, & &1.body) == ["channel msg"]
    end

    test "$server target ignores dm_with — pure channel-keyed fetch",
         %{user: user, network: net} do
      {:ok, _} =
        Scrollback.persist_event(%{
          user_id: user.id,
          network_id: net.id,
          channel: "$server",
          server_time: 100,
          kind: :notice,
          sender: "raccooncity.azzurra.chat",
          body: "MOTD line",
          meta: %{},
          dm_with: nil
        })

      page = Scrollback.fetch({:user, user.id}, net.id, "$server", nil, 10, nil)
      assert Enum.map(page, & &1.body) == ["MOTD line"]
    end

    test "own-nick query window: fetch/6 with own_nick narrows to self-msgs only",
         %{user: user, network: net} do
      # Self-msg (`/msg vjt-grappa hello`) — channel + dm_with both = own_nick.
      {:ok, _} =
        Scrollback.persist_event(%{
          user_id: user.id,
          network_id: net.id,
          channel: "vjt-grappa",
          server_time: 100,
          kind: :privmsg,
          sender: "vjt-grappa",
          body: "self note",
          meta: %{},
          dm_with: "vjt-grappa"
        })

      # Inbound DM from peer (channel = own_nick, dm_with = peer).
      # Pre-fix this leaked into the own-nick window's fetch because
      # `channel == "vjt-grappa"` matched the OR clause regardless of
      # dm_with. (CP14-B3 commit 47866bc, observed prod-side 2026-05-10.)
      {:ok, _} =
        Scrollback.persist_event(%{
          user_id: user.id,
          network_id: net.id,
          channel: "vjt-grappa",
          server_time: 200,
          kind: :privmsg,
          sender: "CristoBOT",
          body: "DIO LURIDISSIMO",
          meta: %{},
          dm_with: "CristoBOT"
        })

      # Outbound DM to peer (channel = peer) — also must NOT show in
      # own-nick window. The 2nd inbound is the worst case (channel ==
      # own_nick), this 3rd outbound is a sanity check on the symmetric
      # path.
      {:ok, _} =
        Scrollback.persist_event(%{
          user_id: user.id,
          network_id: net.id,
          channel: "CristoBOT",
          server_time: 300,
          kind: :privmsg,
          sender: "vjt-grappa",
          body: "to bot",
          meta: %{},
          dm_with: "CristoBOT"
        })

      # Fetch own-nick window with own_nick provided — only the self-msg.
      page = Scrollback.fetch({:user, user.id}, net.id, "vjt-grappa", nil, 10, "vjt-grappa")
      assert Enum.map(page, & &1.body) == ["self note"]

      # And fetch on the peer's window still returns the bidirectional
      # conversation (sanity check that we didn't break the peer path).
      peer_page = Scrollback.fetch({:user, user.id}, net.id, "CristoBOT", nil, 10, "vjt-grappa")

      assert Enum.map(peer_page, &{&1.server_time, &1.body}) == [
               {300, "to bot"},
               {200, "DIO LURIDISSIMO"}
             ]
    end

    test "own-nick narrowing is case-insensitive",
         %{user: user, network: net} do
      # Inbound DM from peer at the canonical own-nick channel.
      {:ok, _} =
        Scrollback.persist_event(%{
          user_id: user.id,
          network_id: net.id,
          channel: "Vjt-Grappa",
          server_time: 100,
          kind: :privmsg,
          sender: "peer",
          body: "should NOT appear in own-nick window",
          meta: %{},
          dm_with: "peer"
        })

      # Self-msg at canonical own-nick.
      {:ok, _} =
        Scrollback.persist_event(%{
          user_id: user.id,
          network_id: net.id,
          channel: "Vjt-Grappa",
          server_time: 200,
          kind: :privmsg,
          sender: "Vjt-Grappa",
          body: "self note",
          meta: %{},
          dm_with: "Vjt-Grappa"
        })

      # Caller passes a differently-cased own_nick — narrowing must still
      # fire. IRC nicks are case-insensitive at the protocol level; the
      # filter mirrors that.
      page = Scrollback.fetch({:user, user.id}, net.id, "Vjt-Grappa", nil, 10, "VJT-GRAPPA")
      assert Enum.map(page, & &1.body) == ["self note"]
    end

    test "own_nick=nil DM fetch folds on the peer — no channel-match leak (#372)",
         %{user: user, network: net} do
      # No live session (Session.current_nick → :no_session) means the
      # controller threads own_nick = nil. Inbound peer→own persists as
      # channel = own_nick, dm_with = peer — the row belongs to the
      # "peer" window, NOT the own-nick window.
      {:ok, _} =
        Scrollback.persist_event(%{
          user_id: user.id,
          network_id: net.id,
          channel: "vjt-grappa",
          server_time: 100,
          kind: :privmsg,
          sender: "peer",
          body: "inbound",
          meta: %{},
          dm_with: "peer"
        })

      # #372: the DM fetch resolves by the FOLDED peer (dm_with), never a
      # raw `channel == target` arm. Fetching the "peer" window returns
      # the inbound row even with no session...
      peer_page = Scrollback.fetch({:user, user.id}, net.id, "peer", nil, 10, nil)
      assert Enum.map(peer_page, & &1.body) == ["inbound"]

      # ...and fetching "vjt-grappa" (the own-nick window) does NOT leak
      # the peer's inbound row. Pre-#372 the raw `channel == "vjt-grappa"`
      # arm returned ["inbound"] here — the CP14-B3 leak that own_nick
      # narrowing closed for live sessions, now closed for the no-session
      # path too (folding on the peer shows self-msgs only, no own_nick
      # needed).
      own_page = Scrollback.fetch({:user, user.id}, net.id, "vjt-grappa", nil, 10, nil)
      assert own_page == []
    end

    test "DM fetch is per-subject — alice's DMs are not visible when fetching as vjt",
         %{user: vjt, network: net} do
      {:ok, alice} =
        Accounts.create_user(%{name: "alice-#{uniq()}", password: "correct horse battery"})

      # Both vjt and alice have a DM thread with the same peer "common-peer".
      # Inbound to vjt (channel = vjt's own nick "vjt-grappa", dm_with = peer).
      {:ok, _} =
        Scrollback.persist_event(%{
          user_id: vjt.id,
          network_id: net.id,
          channel: "vjt-grappa",
          server_time: 100,
          kind: :privmsg,
          sender: "common-peer",
          body: "to vjt",
          meta: %{},
          dm_with: "common-peer"
        })

      # Inbound to alice (channel = alice's own nick "alice-grappa",
      # dm_with = peer).
      {:ok, _} =
        Scrollback.persist_event(%{
          user_id: alice.id,
          network_id: net.id,
          channel: "alice-grappa",
          server_time: 200,
          kind: :privmsg,
          sender: "common-peer",
          body: "to alice",
          meta: %{},
          dm_with: "common-peer"
        })

      vjt_page = Scrollback.fetch({:user, vjt.id}, net.id, "common-peer", nil, 10, nil)
      assert Enum.map(vjt_page, & &1.body) == ["to vjt"]

      alice_page = Scrollback.fetch({:user, alice.id}, net.id, "common-peer", nil, 10, nil)
      assert Enum.map(alice_page, & &1.body) == ["to alice"]
    end

    # Codebase review 2026-05-08 H1: the original CP14 B3 index
    # `(network_id, dm_with, server_time)` had no leading subject
    # column, so the OR arm of channel_or_dm_where/2 walked rows for
    # every user/visitor on the network sharing that peer name and
    # post-filtered by `subject_where/2`. The fix replaces it with two
    # subject-leading composites that mirror the channel-side shape:
    #
    #   * (user_id, network_id, dm_with, server_time)
    #   * (visitor_id, network_id, dm_with, server_time)
    #
    # These tests pin the SQLite query planner's choice so the
    # subject-leading shape can never silently regress to a slow
    # cross-subject scan. EXPLAIN QUERY PLAN is the only observable
    # signal that the index leadership matters; functional output is
    # identical either way.
    #
    # REV-B / H18 (2026-05-22 codebase review): the regression
    # invariant is "subject-LEADING", not "this specific index name".
    # The new REV-B covering index (`messages_archive_user_idx` on
    # `(user_id, network_id, COALESCE(dm_with, channel), server_time)`)
    # is ALSO subject-leading; SQLite's planner may pick it for the
    # DM-fetch OR-shape because the COALESCE column matches BOTH OR
    # arms in a single walk. Either choice preserves the H1
    # invariant — the `refute` against the subject-less
    # `messages_network_id_dm_with_server_time_index` is the
    # invariant; the asserted name list permits the planner to pick
    # the more selective subject-leading composite.
    test "EXPLAIN QUERY PLAN: user-side DM fetch picks a subject-leading composite",
         %{user: user, network: net} do
      {:ok, %{rows: rows}} =
        Repo.query("""
        EXPLAIN QUERY PLAN
        SELECT * FROM messages
        WHERE user_id = '#{user.id}'
          AND network_id = #{net.id}
          AND (channel = 'peer' OR dm_with = 'peer')
        ORDER BY server_time DESC, id DESC
        LIMIT 50
        """)

      plan_text = rows |> List.flatten() |> Enum.map_join("\n", &to_string/1)

      acceptable = [
        "messages_user_id_network_id_dm_with_server_time_index",
        "messages_archive_user_idx"
      ]

      assert Enum.any?(acceptable, &String.contains?(plan_text, &1)),
             "expected dm_with arm to use a subject-leading composite (#{Enum.join(acceptable, " OR ")}), got plan:\n#{plan_text}"

      refute plan_text =~ "messages_network_id_dm_with_server_time_index",
             "old subject-less index must NOT be used:\n#{plan_text}"
    end

    test "EXPLAIN QUERY PLAN: visitor-side DM fetch picks a subject-leading composite",
         %{network: net} do
      {:ok, visitor} =
        Grappa.Visitors.find_or_provision_anon("v-#{uniq()}", net.slug, "1.2.3.4")

      {:ok, %{rows: rows}} =
        Repo.query("""
        EXPLAIN QUERY PLAN
        SELECT * FROM messages
        WHERE visitor_id = '#{visitor.id}'
          AND network_id = #{net.id}
          AND (channel = 'peer' OR dm_with = 'peer')
        ORDER BY server_time DESC, id DESC
        LIMIT 50
        """)

      plan_text = rows |> List.flatten() |> Enum.map_join("\n", &to_string/1)

      acceptable = [
        "messages_visitor_id_network_id_dm_with_server_time_index",
        "messages_archive_visitor_idx"
      ]

      assert Enum.any?(acceptable, &String.contains?(plan_text, &1)),
             "expected dm_with arm to use a subject-leading composite (#{Enum.join(acceptable, " OR ")}), got plan:\n#{plan_text}"

      refute plan_text =~ "messages_network_id_dm_with_server_time_index",
             "old subject-less index must NOT be used:\n#{plan_text}"
    end
  end

  describe "Wire.to_json/1 (per-user iso wire-shape contract)" do
    test "emits network slug, NOT the integer network_id", %{user: user, network: net} do
      {:ok, message} = ScrollbackHelpers.insert(sample(user, net, 0))
      preloaded = Repo.preload(message, :network)

      wire = Wire.to_json(preloaded)
      assert wire.network == net.slug
      refute Map.has_key?(wire, :network_id)
    end

    test "does NOT expose user_id (it's a topic discriminator, not a payload field per decision G3)",
         %{user: user, network: net} do
      {:ok, message} = ScrollbackHelpers.insert(sample(user, net, 0))
      preloaded = Repo.preload(message, :network)

      wire = Wire.to_json(preloaded)
      refute Map.has_key?(wire, :user_id)
    end

    test "carries id, channel, server_time, kind, sender, body, meta — the rest of the wire",
         %{user: user, network: net} do
      {:ok, message} = ScrollbackHelpers.insert(sample(user, net, 42, %{body: "hello", sender: "vjt"}))
      preloaded = Repo.preload(message, :network)

      wire = Wire.to_json(preloaded)
      assert wire.id == message.id
      assert wire.channel == "#sniffo"
      assert wire.server_time == 42
      assert wire.kind == :privmsg
      assert wire.sender == "vjt"
      assert wire.body == "hello"
      assert wire.meta == %{}
    end
  end

  describe "Network struct shape (sanity)" do
    # Belt-and-braces: the wire path depends on Repo.preload(:network)
    # working, which depends on the schema's `belongs_to :network` being
    # there. This catches a typo'd schema before the controller does.
    test "Message.belongs_to(:network) is wired (preload returns Network struct)",
         %{user: user, network: net} do
      {:ok, message} = ScrollbackHelpers.insert(sample(user, net, 0))
      preloaded = Repo.preload(message, :network)
      assert %Network{slug: slug} = preloaded.network
      assert slug == net.slug
    end
  end

  # M7 fix 2026-05-08: public target_kind/1 helper. Pre-M7 the rule
  # ("sigil-led target ⇒ :channel; everything else ⇒ :query") was
  # encoded inside three separate private functions
  # (`nick_shaped?/1`, `target_kind/1`, `dm_eligible?/1`), kept in
  # lockstep by convention. Promoting it to a public helper closes
  # the convention-not-contract gap and gives external callers
  # (cic-wire, future Phase 6 listener) a canonical predicate.
  describe "dm_peer/4 — rfc1459 own-nick folding (#121)" do
    test "matches the own-nick target case-insensitively (ASCII)" do
      assert Scrollback.dm_peer(:privmsg, "VJT", "alice", "vjt") == "alice"
    end

    test "folds the rfc1459 national chars [ ] \\ ~ on the own nick" do
      # An inbound DM addressed to our nick spelled with the mirror-case
      # national chars must still resolve the peer, not be misread as a
      # message to someone else. own_nick "a[1]" folds to "a{1}".
      assert Scrollback.dm_peer(:privmsg, "a{1}", "bob", "a[1]") == "bob"
      assert Scrollback.dm_peer(:privmsg, "chan", "a{1}", "a[1]") == "chan"
    end
  end

  describe "target_kind/1 (M7)" do
    test "returns :channel for #-prefixed targets" do
      assert Scrollback.target_kind("#sniffo") == :channel
    end

    test "returns :channel for &-prefixed targets" do
      assert Scrollback.target_kind("&local") == :channel
    end

    test "returns :channel for !-prefixed targets" do
      assert Scrollback.target_kind("!safe") == :channel
    end

    test "returns :channel for +-prefixed targets" do
      assert Scrollback.target_kind("+modeless") == :channel
    end

    test "returns :query for nick-shaped targets" do
      assert Scrollback.target_kind("vjt") == :query
    end

    test "returns :query for $server (synthetic) — server-window is NOT a channel-typed sigil" do
      # The `$server` window is server-internal scrollback; it has no
      # channel sigil, so the predicate classifies it as :query by
      # construction. Callers that need to special-case $server (e.g.
      # `list_archive/3`'s exclusion, `fetch/5`'s dm_eligible? branch)
      # do so AFTER this classification, not via target_kind itself.
      assert Scrollback.target_kind("$server") == :query
    end
  end

  describe "persist_event/1 with visitor_id" do
    test "persists with visitor_id, no user_id" do
      visitor = visitor_fixture()
      network = network_fixture()

      attrs = %{
        visitor_id: visitor.id,
        network_id: network.id,
        channel: "#italia",
        kind: :privmsg,
        sender: "vjt",
        body: "ciao",
        server_time: System.system_time(:millisecond),
        meta: %{}
      }

      assert {:ok, msg} = Scrollback.persist_event(attrs)
      assert msg.visitor_id == visitor.id
      assert is_nil(msg.user_id)
    end

    test "rejects when both user_id and visitor_id set" do
      user = user_fixture()
      visitor = visitor_fixture()
      network = network_fixture()

      attrs = %{
        user_id: user.id,
        visitor_id: visitor.id,
        network_id: network.id,
        channel: "#italia",
        kind: :privmsg,
        sender: "vjt",
        body: "ciao",
        server_time: System.system_time(:millisecond),
        meta: %{}
      }

      assert {:error, changeset} = Scrollback.persist_event(attrs)
      # B5.4 M-pers-2: synthetic :subject key (was always :user_id even when
      # the conflict spans both fields). Mirror of Session XOR enforcement.
      assert "user_id and visitor_id are mutually exclusive" in errors_on(changeset).subject
      refute Map.has_key?(errors_on(changeset), :user_id)
      refute Map.has_key?(errors_on(changeset), :visitor_id)
    end

    test "rejects when neither user_id nor visitor_id set" do
      network = network_fixture()

      attrs = %{
        network_id: network.id,
        channel: "#italia",
        kind: :privmsg,
        sender: "vjt",
        body: "ciao",
        server_time: System.system_time(:millisecond),
        meta: %{}
      }

      assert {:error, changeset} = Scrollback.persist_event(attrs)
      # B5.4 M-pers-2: synthetic :subject key.
      assert "must set user_id or visitor_id" in errors_on(changeset).subject
      refute Map.has_key?(errors_on(changeset), :user_id)
      refute Map.has_key?(errors_on(changeset), :visitor_id)
    end
  end

  # --------------------------------------------------------------------
  # CP29 R-2 — fetch_around/6 (window centered on cursor)
  # --------------------------------------------------------------------
  describe "fetch_around/6" do
    test "returns floor(limit/2) before + ceil(limit/2) after, merged DESC",
         %{user: user, network: net} do
      rows =
        for i <- 0..6 do
          {:ok, m} = ScrollbackHelpers.insert(sample(user, net, i))
          m
        end

      [_, _, _, m3 | _] = rows

      page = Scrollback.fetch_around({:user, user.id}, net.id, "#sniffo", m3.id, 4, nil)

      # limit=4 → floor(4/2)=2 before-or-at, ceil(4/2)=2 after.
      # Before-or-at m3.id (DESC): m3, m2. After m3.id (ASC): m4, m5.
      # Merged DESC: reverse(after) ++ before = [m5, m4, m3, m2].
      assert Enum.map(page, & &1.body) == ["msg 5", "msg 4", "msg 3", "msg 2"]
    end

    test "returns all rows when limit exceeds row count", %{user: user, network: net} do
      rows =
        for i <- 0..2 do
          {:ok, m} = ScrollbackHelpers.insert(sample(user, net, i))
          m
        end

      [_, m1, _] = rows
      page = Scrollback.fetch_around({:user, user.id}, net.id, "#sniffo", m1.id, 50, nil)
      assert Enum.map(page, & &1.body) == ["msg 2", "msg 1", "msg 0"]
    end

    test "around_id pointing at non-existent row still returns rows on either side",
         %{user: user, network: net} do
      rows =
        for i <- 0..3 do
          {:ok, m} = ScrollbackHelpers.insert(sample(user, net, i))
          m
        end

      [_, m1, _, _] = rows
      gap_id = m1.id + 100
      page = Scrollback.fetch_around({:user, user.id}, net.id, "#sniffo", gap_id, 4, nil)
      # All four rows have id < gap_id → 2 (floor 4/2) before-or-at,
      # 0 after. DESC of those 2: ["msg 3", "msg 2"].
      assert Enum.map(page, & &1.body) == ["msg 3", "msg 2"]
    end

    test "isolates by (subject, network, channel) — no leakage", %{user: user, network: net} do
      {:ok, other_net} = Networks.find_or_create_network(%{slug: "freenode-#{uniq()}"})
      {:ok, anchor} = ScrollbackHelpers.insert(sample(user, net, 0))
      # Same id (probably) on a different network — should NOT leak in.
      {:ok, _} = ScrollbackHelpers.insert(sample(user, other_net, 1, %{channel: "#sniffo"}))

      page = Scrollback.fetch_around({:user, user.id}, net.id, "#sniffo", anchor.id, 10, nil)
      assert length(page) == 1
      assert hd(page).network_id == net.id
    end
  end

  # --------------------------------------------------------------------
  # CP15 B4 — Archive surface
  # --------------------------------------------------------------------
  #
  # `list_archive/3` returns the archive set for a (subject, network):
  # the union of all targets with at least one scrollback row, MINUS
  # the active keyset (currently-joined channels + currently-open query
  # window targets) and MINUS the `$server` pseudo-channel (always
  # active, never archived per intent doc `Active/Archive boundary`).
  #
  # Target = `COALESCE(dm_with, channel)` — picks the DM peer for DM
  # rows (inbound channel = own_nick, outbound channel = peer; both
  # carry dm_with = peer per CP14 B3), and the channel name for channel
  # rows (`dm_with = nil`).
  #
  # Kind = `:channel` for sigil-prefixed targets (`#`, `&`, `!`, `+`),
  # `:query` otherwise. Mirrors `dm_eligible?/1`'s sigil predicate so
  # the two stay in lockstep.
  describe "list_archive/3" do
    test "excludes $server and active_keyset; returns archived DM target with kind/last_activity/row_count",
         %{user: user, network: net} do
      # Seed: 3 channel rows for #a (active), 2 DM rows for "vjt-peer"
      # (archived), 1 $server row (always-active per intent doc).
      seed_archive_rows(user, net)

      assert [
               %{
                 target: "vjt-peer",
                 kind: :query,
                 last_activity: 200,
                 row_count: 2
               }
             ] =
               Scrollback.list_archive({:user, user.id}, net.id, MapSet.new(["#a"]))
    end

    test "empty active_keyset returns ALL non-$server targets sorted last_activity desc",
         %{user: user, network: net} do
      seed_archive_rows(user, net)

      result = Scrollback.list_archive({:user, user.id}, net.id, MapSet.new())

      # #a (max ts 30) and vjt-peer (max ts 200) both archived; $server
      # excluded; sorted last_activity desc.
      assert [
               %{target: "vjt-peer", kind: :query, last_activity: 200, row_count: 2},
               %{target: "#a", kind: :channel, last_activity: 30, row_count: 3}
             ] = result
    end

    test "scopes by user_id — alice's rows are NOT visible when listing as vjt",
         %{user: vjt, network: net} do
      seed_archive_rows(vjt, net)

      {:ok, alice} =
        Accounts.create_user(%{name: "alice-#{uniq()}", password: "correct horse battery"})

      {:ok, _} =
        Scrollback.persist_event(%{
          user_id: alice.id,
          network_id: net.id,
          channel: "#alice-only",
          server_time: 999,
          kind: :privmsg,
          sender: "alice",
          body: "private",
          meta: %{},
          dm_with: nil
        })

      vjt_archive = Scrollback.list_archive({:user, vjt.id}, net.id, MapSet.new())
      refute Enum.any?(vjt_archive, &(&1.target == "#alice-only"))
    end

    test "scopes by visitor_id — visitor archive is independent of user rows",
         %{user: user, network: net} do
      visitor = visitor_fixture()

      # User row that should NOT show up in the visitor's archive.
      {:ok, _} =
        Scrollback.persist_event(%{
          user_id: user.id,
          network_id: net.id,
          channel: "#user-only",
          server_time: 100,
          kind: :privmsg,
          sender: "vjt",
          body: "user msg",
          meta: %{},
          dm_with: nil
        })

      # Visitor row — single channel, qualifies for archive.
      {:ok, _} =
        Scrollback.persist_event(%{
          visitor_id: visitor.id,
          network_id: net.id,
          channel: "#visitor-only",
          server_time: 200,
          kind: :privmsg,
          sender: "anon",
          body: "visitor msg",
          meta: %{},
          dm_with: nil
        })

      assert [
               %{target: "#visitor-only", kind: :channel, last_activity: 200, row_count: 1}
             ] =
               Scrollback.list_archive({:visitor, visitor.id}, net.id, MapSet.new())
    end

    test "isolates by network_id — rows on other_net are not in this_net's archive",
         %{user: user, network: net} do
      {:ok, other_net} = Networks.find_or_create_network(%{slug: "other-#{uniq()}"})

      {:ok, _} =
        Scrollback.persist_event(%{
          user_id: user.id,
          network_id: other_net.id,
          channel: "#elsewhere",
          server_time: 100,
          kind: :privmsg,
          sender: "vjt",
          body: "wrong net",
          meta: %{},
          dm_with: nil
        })

      assert [] = Scrollback.list_archive({:user, user.id}, net.id, MapSet.new())
    end
  end

  # Shared seeder for list_archive/3 tests. Three targets:
  #   * "#a" — channel kind, 3 rows, max server_time = 30
  #   * "vjt-peer" — query kind via dm_with, 2 rows, max = 200
  #   * "$server" — always-active pseudo, 1 row, MUST be excluded
  defp seed_archive_rows(user, net) do
    for ts <- [10, 20, 30] do
      {:ok, _} =
        Scrollback.persist_event(%{
          user_id: user.id,
          network_id: net.id,
          channel: "#a",
          server_time: ts,
          kind: :privmsg,
          sender: "vjt",
          body: "channel #{ts}",
          meta: %{},
          dm_with: nil
        })
    end

    for ts <- [100, 200] do
      {:ok, _} =
        Scrollback.persist_event(%{
          user_id: user.id,
          network_id: net.id,
          channel: "vjt-grappa",
          server_time: ts,
          kind: :privmsg,
          sender: "vjt-peer",
          body: "dm #{ts}",
          meta: %{},
          dm_with: "vjt-peer"
        })
    end

    {:ok, _} =
      Scrollback.persist_event(%{
        user_id: user.id,
        network_id: net.id,
        channel: "$server",
        server_time: 50,
        kind: :notice,
        sender: "irc.example",
        body: "MOTD",
        meta: %{},
        dm_with: nil
      })

    :ok
  end

  describe "delete_for_dm/3 (UX-1)" do
    test "drops all rows with dm_with == peer for (subject, network)", %{user: user, network: net} do
      # Outbound vjt → peer (channel = peer, dm_with = peer)
      {:ok, _} =
        Scrollback.persist_event(sample(user, net, 100, %{channel: "peer", sender: "vjt", dm_with: "peer"}))

      # Inbound peer → vjt (channel = vjt, dm_with = peer)
      {:ok, _} =
        Scrollback.persist_event(sample(user, net, 110, %{channel: "vjt", sender: "peer", dm_with: "peer"}))

      # Unrelated DM (other peer) — must survive
      {:ok, survive_dm} =
        Scrollback.persist_event(sample(user, net, 120, %{channel: "other", sender: "vjt", dm_with: "other"}))

      # Unrelated channel row — must survive
      {:ok, survive_chan} =
        Scrollback.persist_event(sample(user, net, 130, %{channel: "#room", sender: "vjt", dm_with: nil}))

      assert {:ok, 2} = Scrollback.delete_for_dm({:user, user.id}, net.id, "peer")

      remaining_ids =
        Message |> Repo.all() |> Enum.map(& &1.id) |> Enum.sort()

      assert remaining_ids == Enum.sort([survive_dm.id, survive_chan.id])
    end

    test "case-insensitive on peer nick", %{user: user, network: net} do
      {:ok, _} =
        Scrollback.persist_event(sample(user, net, 100, %{channel: "Peer", sender: "vjt", dm_with: "Peer"}))

      assert {:ok, 1} = Scrollback.delete_for_dm({:user, user.id}, net.id, "PEER")
    end

    test "isolated by subject — alice's DM rows survive a vjt delete", %{user: vjt, network: net} do
      {:ok, alice} =
        Accounts.create_user(%{name: "alice-#{uniq()}", password: "correct horse battery"})

      {:ok, alice_dm} =
        Scrollback.persist_event(sample(alice, net, 100, %{channel: "peer", sender: "alice", dm_with: "peer"}))

      alice_dm_id = alice_dm.id

      assert {:ok, 0} = Scrollback.delete_for_dm({:user, vjt.id}, net.id, "peer")
      assert [%Message{id: ^alice_dm_id}] = Repo.all(Message)
    end

    test "isolated by network — peer DM on other_net survives", %{user: user, network: net} do
      {:ok, other_net} = Networks.find_or_create_network(%{slug: "other-#{uniq()}"})

      {:ok, other_dm} =
        Scrollback.persist_event(sample(user, other_net, 100, %{channel: "peer", sender: "vjt", dm_with: "peer"}))

      other_id = other_dm.id

      assert {:ok, 0} = Scrollback.delete_for_dm({:user, user.id}, net.id, "peer")
      assert [%Message{id: ^other_id}] = Repo.all(Message)
    end

    test "idempotent — returns {:ok, 0} on empty matches", %{user: user, network: net} do
      assert {:ok, 0} = Scrollback.delete_for_dm({:user, user.id}, net.id, "ghost")
      assert {:ok, 0} = Scrollback.delete_for_dm({:user, user.id}, net.id, "ghost")
    end

    test "deletes orphan rows where dm_with IS NULL and channel == peer (UX-3 Z)",
         %{user: user, network: net} do
      # Server NOTICE routed to a query window with no prior PRIVMSG
      # exchange: numeric_router.scan_params/2 routes the row to
      # `channel = nick_target`, but the persistence path never sets
      # dm_with because no PRIVMSG-direction sender/recipient pair
      # exists. list_archive/3 surfaces it via COALESCE(dm_with, channel);
      # delete_for_dm/3 must match the same coalescing rule.
      {:ok, orphan} =
        Scrollback.persist_event(
          sample(user, net, 200, %{
            channel: "ghost-cp21s7-1778420256",
            sender: "raccooncity.azzurra.chat",
            kind: :notice,
            body: "No such nick/channel",
            dm_with: nil
          })
        )

      # Unrelated dm_with-tagged row to the same peer — must also drop
      {:ok, _} =
        Scrollback.persist_event(
          sample(user, net, 210, %{
            channel: "ghost-cp21s7-1778420256",
            sender: "vjt",
            dm_with: "ghost-cp21s7-1778420256"
          })
        )

      # Unrelated channel row with dm_with IS NULL — must survive
      {:ok, survive_chan} =
        Scrollback.persist_event(sample(user, net, 220, %{channel: "#room", sender: "vjt", dm_with: nil}))

      assert {:ok, 2} =
               Scrollback.delete_for_dm(
                 {:user, user.id},
                 net.id,
                 "ghost-cp21s7-1778420256"
               )

      orphan_id = orphan.id
      survive_id = survive_chan.id
      remaining_ids = Message |> Repo.all() |> Enum.map(& &1.id) |> Enum.sort()
      assert remaining_ids == Enum.sort([survive_id])
      refute orphan_id in remaining_ids
    end

    test "orphan deletion is case-insensitive on channel name (UX-3 Z)",
         %{user: user, network: net} do
      {:ok, _} =
        Scrollback.persist_event(
          sample(user, net, 100, %{
            channel: "GhostNick",
            sender: "server.example.org",
            kind: :notice,
            body: "No such nick/channel",
            dm_with: nil
          })
        )

      assert {:ok, 1} = Scrollback.delete_for_dm({:user, user.id}, net.id, "ghostnick")
    end
  end

  describe "delete_for_channel/3 (UX-1)" do
    test "drops all rows for (subject, network, channel) — channel-shaped", %{
      user: user,
      network: net
    } do
      {:ok, _} =
        Scrollback.persist_event(sample(user, net, 10, %{channel: "#room", dm_with: nil}))

      {:ok, _} =
        Scrollback.persist_event(sample(user, net, 20, %{channel: "#room", dm_with: nil}))

      {:ok, survive} =
        Scrollback.persist_event(sample(user, net, 30, %{channel: "#other", dm_with: nil}))

      survive_id = survive.id

      assert {:ok, 2} = Scrollback.delete_for_channel({:user, user.id}, net.id, "#room")

      assert [%Message{id: ^survive_id}] = Repo.all(Message)
    end

    test "case-insensitive on channel name", %{user: user, network: net} do
      {:ok, _} =
        Scrollback.persist_event(sample(user, net, 10, %{channel: "#Room", dm_with: nil}))

      assert {:ok, 1} = Scrollback.delete_for_channel({:user, user.id}, net.id, "#ROOM")
    end

    test "DM rows for the same target name DO NOT match (pure channel filter)", %{
      user: user,
      network: net
    } do
      # `peer` (query-kind) — must NOT be touched by a delete_for_channel call.
      {:ok, dm} =
        Scrollback.persist_event(sample(user, net, 10, %{channel: "peer", sender: "vjt", dm_with: "peer"}))

      # Note: channel-shaped target — would be deleted.
      {:ok, _} =
        Scrollback.persist_event(sample(user, net, 20, %{channel: "#peer", dm_with: nil}))

      dm_id = dm.id

      assert {:ok, 1} = Scrollback.delete_for_channel({:user, user.id}, net.id, "#peer")

      assert [%Message{id: ^dm_id}] = Repo.all(Message)
    end

    test "idempotent — returns {:ok, 0} on empty matches", %{user: user, network: net} do
      assert {:ok, 0} = Scrollback.delete_for_channel({:user, user.id}, net.id, "#ghost")
    end

    test "isolated by subject — alice's channel rows survive a vjt delete",
         %{user: vjt, network: net} do
      {:ok, alice} =
        Accounts.create_user(%{name: "alice-#{uniq()}", password: "correct horse battery"})

      {:ok, _} =
        Scrollback.persist_event(sample(alice, net, 10, %{channel: "#room", dm_with: nil}))

      assert {:ok, 0} = Scrollback.delete_for_channel({:user, vjt.id}, net.id, "#room")
      assert [_] = Repo.all(Message)
    end
  end

  # REV-B / H17 (2026-05-22 codebase review). Write side canonicalises
  # channel names via `Identifier.canonical_channel/1` (sigil-aware);
  # delete side did raw `String.downcase/1`. ASCII channels agree
  # today (both shapes collapse to `String.downcase/1` for `[A-Z]`),
  # but any future canonicalisation extension would silently make the
  # delete miss its target rows. Property test pins the parity: for
  # ANY mixed-case channel name, `delete_for_channel(s)` and
  # `delete_for_channel(canonical(s))` must affect the SAME row set.
  describe "REV-B H17 — delete_for_channel/3 canonicalisation parity with write side" do
    property "write side and delete side observe the same channel canonicalisation rule",
             %{user: user, network: net} do
      # Sigil-prefixed mixed-case channel-shape names. The single-char
      # body keeps the property fast — the canonicalisation rule is
      # name-independent, the property generator only needs to vary
      # case + sigil. We bias to the common `#` sigil + a short letter
      # body; the rule is identical for `&!+`.
      check all(
              letter <- StreamData.member_of(~w(A B X y z foo BAR Mixed)),
              max_runs: 20
            ) do
        channel = "#" <> letter

        canonical = Grappa.IRC.Identifier.canonical_channel(channel)

        # Persist one row under the canonical channel (write side has
        # already canonicalised, so this matches the on-disk shape).
        {:ok, persisted} =
          Scrollback.persist_event(
            sample(user, net, :erlang.unique_integer([:positive]), %{
              channel: canonical,
              dm_with: nil
            })
          )

        # Delete via the mixed-case caller-supplied name. Pre-H17 the
        # raw `String.downcase` would have matched ASCII (today); the
        # property pins the single-source guarantee.
        assert {:ok, 1} = Scrollback.delete_for_channel({:user, user.id}, net.id, channel)

        # And the row is actually gone.
        assert Repo.get(Message, persisted.id) == nil
      end
    end
  end

  # REV-B / H18 (2026-05-22 codebase review). Covering expression index
  # on `(<subject>, network_id, COALESCE(dm_with, channel))` for
  # `list_archive/3`'s GROUP BY shape. The migration is purely
  # additive — the planner picks it up automatically once present. We
  # assert via `EXPLAIN QUERY PLAN` that the planner consults
  # `messages_archive_user_idx` (or `messages_archive_visitor_idx`)
  # for the archive query shape.
  #
  # SQLite is permitted to fall through to `SCAN messages` on very
  # small tables (zero or one row) — the test seeds enough rows to
  # nudge the planner past that heuristic.
  describe "REV-B H18 — list_archive/3 covering index" do
    test "EXPLAIN QUERY PLAN consults messages_archive_user_idx", %{user: user, network: net} do
      # Seed a handful of rows so the planner has cardinality to
      # reason about; bias toward heterogeneous COALESCE values so
      # the index is materially useful.
      for {ch, dm, st} <- [
            {"#a", nil, 10},
            {"#b", nil, 20},
            {"peer", "peer", 30},
            {"other", "other", 40}
          ] do
        {:ok, _} = Scrollback.persist_event(sample(user, net, st, %{channel: ch, dm_with: dm}))
      end

      sql = """
      EXPLAIN QUERY PLAN
        SELECT COALESCE(dm_with, channel) AS target,
               MAX(server_time) AS last_activity,
               COUNT(*) AS row_count
          FROM messages
         WHERE user_id = ? AND network_id = ?
         GROUP BY COALESCE(dm_with, channel)
      """

      %Exqlite.Result{rows: rows} = Repo.query!(sql, [user.id, net.id])

      plan = Enum.map_join(rows, "\n", fn [_, _, _, detail] -> detail end)

      # The planner output for SQLite uses "SEARCH messages USING INDEX
      # <name>" when the index is actually applied. We accept either
      # the user-scoped index by name OR the broader assertion that
      # SOME index is used (defensive against minor SQLite planner
      # wording variance across versions); the index name is the
      # canonical signal and what the migration guarantees exists.
      assert plan =~ "messages_archive_user_idx",
             """
             Expected EXPLAIN QUERY PLAN to reference messages_archive_user_idx,
             got:
             #{plan}
             """
    end
  end

  # S33 (2026-07-08 codebase review — rides-along) — the network-delete
  # gate `has_messages_for_network?/1` reads `WHERE network_id = ? LIMIT
  # 1`. Every composite messages index leads with user_id / visitor_id,
  # so pre-fix that read (and the RESTRICT-FK child scan on network
  # delete) full-scanned the largest table. The leading `[:network_id]`
  # index turns both into an index seek.
  describe "S33 — messages.network_id leading index" do
    test "has_messages_for_network?/1 query plan uses messages_network_id_index",
         %{user: user, network: net} do
      for st <- [10, 20, 30], do: {:ok, _} = ScrollbackHelpers.insert(sample(user, net, st))

      # Mirrors `has_messages_for_network?/1`'s query verbatim.
      %Exqlite.Result{rows: rows} =
        Repo.query!(
          "EXPLAIN QUERY PLAN SELECT 1 FROM messages WHERE network_id = ? LIMIT 1",
          [net.id]
        )

      plan = Enum.map_join(rows, "\n", fn [_, _, _, detail] -> detail end)

      assert plan =~ "messages_network_id_index",
             """
             Expected EXPLAIN QUERY PLAN to SEARCH via messages_network_id_index
             (not SCAN messages), got:
             #{plan}
             """
    end
  end

  # #379 (P0, 2026-07-22) — CP29 R-2 index regression. R-2 switched the
  # scrollback since-cursor key from `server_time` to monotonic `id`, so
  # every incremental read path — `fetch_after/6`, `count_after/5`,
  # `count_after_split/5`, `unread_content_tail/6` — now filters
  # `id > cursor ORDER BY id`. But the `messages` composites all still
  # END in `server_time`, so `id > ?` was NOT index-eligible: SQLite fell
  # back to scanning the busiest network's post-cursor rows (via
  # `messages_network_id_index`) and filtering `channel`/subject row by
  # row, sometimes with a TEMP B-TREE sort. Those reads fire on every
  # channel join + unread-count (×~18 topics per WS reconnect), so it was
  # a near-constant SQLite dirty-scheduler burn — the "periodic multi-core
  # CPU spike" the operator reported.
  #
  # Fix = the id-twin composites (KEEP the `server_time` twins; `fetch/6`
  # still orders `server_time DESC`). Proven on a prod DB copy: the
  # channel path flips to a clean index seek / COVERING scan, no sort.
  # These EXPLAIN tests pin that the id-cursor read is index-eligible and
  # is a regression guard against a future table-rebuild migration
  # dropping the id-twins (the exact drift class that caused this bug).
  describe "#379 — id-cursor composite indexes (CP29 R-2 regression)" do
    test "visitor channel since-cursor read seeks the id-composite, no sort",
         %{network: net} do
      {:ok, visitor} =
        Grappa.Visitors.find_or_provision_anon("v-#{uniq()}", net.slug, "1.2.3.4")

      # Seed a few rows so the query runs against a realistic non-empty
      # table. (EXPLAIN QUERY PLAN is static — without ANALYZE it reports
      # the same plan empty or full — but a non-empty fixture keeps the
      # test honest about what the query actually walks.)
      for st <- 1..8 do
        {:ok, _} =
          Scrollback.persist_event(%{
            visitor_id: visitor.id,
            network_id: net.id,
            channel: "#chan",
            server_time: st,
            kind: :privmsg,
            sender: "vjt",
            body: "m#{st}"
          })
      end

      # Mirrors `fetch_after/6` / `count_after/5`'s channel-shape query
      # verbatim: WHERE visitor_id AND network_id AND channel AND id > ?
      # ORDER BY id.
      %Exqlite.Result{rows: rows} =
        Repo.query!(
          """
          EXPLAIN QUERY PLAN
          SELECT * FROM messages
          WHERE visitor_id = ? AND network_id = ? AND channel = ? AND id > ?
          ORDER BY id ASC
          LIMIT 50
          """,
          [visitor.id, net.id, "#chan", 0]
        )

      plan = Enum.map_join(rows, "\n", fn [_, _, _, detail] -> detail end)

      assert plan =~ "messages_visitor_id_network_id_channel_id_index",
             "expected the id-cursor composite (clean seek), got:\n#{plan}"

      refute plan =~ "USE TEMP B-TREE",
             "id-cursor read must not sort in memory, got:\n#{plan}"

      refute plan =~ "messages_network_id_index",
             "must not fall back to the network-only scan, got:\n#{plan}"
    end

    test "user channel since-cursor read seeks the id-composite, no sort",
         %{user: user, network: net} do
      for st <- 1..8, do: {:ok, _} = ScrollbackHelpers.insert(sample(user, net, st, %{channel: "#chan"}))

      %Exqlite.Result{rows: rows} =
        Repo.query!(
          """
          EXPLAIN QUERY PLAN
          SELECT * FROM messages
          WHERE user_id = ? AND network_id = ? AND channel = ? AND id > ?
          ORDER BY id ASC
          LIMIT 50
          """,
          [user.id, net.id, "#chan", 0]
        )

      plan = Enum.map_join(rows, "\n", fn [_, _, _, detail] -> detail end)

      assert plan =~ "messages_user_id_network_id_channel_id_index",
             "expected the id-cursor composite (clean seek), got:\n#{plan}"

      refute plan =~ "USE TEMP B-TREE",
             "id-cursor read must not sort in memory, got:\n#{plan}"

      refute plan =~ "messages_network_id_index",
             "must not fall back to the network-only scan, got:\n#{plan}"
    end

    test "all four id-cursor composites exist (anti-drift guard)" do
      %Exqlite.Result{rows: rows} =
        Repo.query!("SELECT name FROM sqlite_master WHERE type = 'index'")

      names = List.flatten(rows)

      for idx <- [
            "messages_visitor_id_network_id_channel_id_index",
            "messages_user_id_network_id_channel_id_index",
            "messages_visitor_id_network_id_dm_with_id_index",
            "messages_user_id_network_id_dm_with_id_index"
          ] do
        assert idx in names,
               "#{idx} missing — CP29 R-2-class drift (a table-rebuild migration " <>
                 "must re-create the id-twin composites); see #379"
      end
    end
  end

  describe "#364 E/irc-S4 — rfc1459 channel window convergence" do
    test "channels differing only by rfc1459 bracket chars resolve to ONE window",
         %{user: user, network: net} do
      {:ok, m1} =
        ScrollbackHelpers.insert(sample(user, net, 1, %{channel: "#chan[1]", body: "bracket"}))

      {:ok, m2} =
        ScrollbackHelpers.insert(sample(user, net, 2, %{channel: "#chan{1}", body: "brace"}))

      # Stored canonical (rfc1459-folded) — both land on the same key, the
      # SAME fold bahamut applies ([ -> {).
      assert m1.channel == "#chan{1}"
      assert m2.channel == "#chan{1}"

      # A fetch under EITHER spelling (incl. mixed case) returns both rows:
      # one window, exactly as the ircd sees the channel.
      for spelling <- ["#chan[1]", "#chan{1}", "#CHAN[1]"] do
        bodies =
          {:user, user.id}
          |> Scrollback.fetch(net.id, spelling, nil, 50, nil)
          |> Enum.map(& &1.body)
          |> Enum.sort()

        assert bodies == ["brace", "bracket"], "spelling #{spelling} did not converge"
      end
    end

    test "non-ASCII case variants do NOT merge (ASCII-only rfc1459)",
         %{user: user, network: net} do
      {:ok, upper} =
        ScrollbackHelpers.insert(sample(user, net, 1, %{channel: "#CAFÉ", body: "upper"}))

      {:ok, lower} =
        ScrollbackHelpers.insert(sample(user, net, 2, %{channel: "#café", body: "lower"}))

      # ASCII-only fold leaves the multibyte É untouched, so the two stay
      # distinct — the old Unicode String.downcase merged them (WRONG for
      # bahamut, whose ASCII casemapping keeps them apart).
      assert upper.channel == "#cafÉ"
      assert lower.channel == "#café"
      refute upper.channel == lower.channel

      assert [%{body: "upper"}] =
               Scrollback.fetch({:user, user.id}, net.id, "#CAFÉ", nil, 50, nil)

      assert [%{body: "lower"}] =
               Scrollback.fetch({:user, user.id}, net.id, "#café", nil, 50, nil)
    end
  end

  # #372 — rfc1459 DM-peer window convergence. Bug: a query window opened
  # as `debugserv` (lowercase) split from the service's proper-case
  # `DebugServ` replies. The inbound row persists `dm_with = "DebugServ"`
  # RAW (display-case, like every nick — message.ex canonicalize_channel
  # deliberately leaves dm_with untouched), but the bidirectional DM read
  # (`channel_or_dm_where/3`) AND the archive grouping (`list_archive/3`)
  # matched/grouped the peer RAW instead of folding, so the reply fell out
  # of the window's fetch and resurfaced as an archived `DebugServ` split.
  # `delete_for_dm/3` already folded — hence "delete either → deletes both"
  # while the window stayed split, the exact inconsistency #372 reports.
  # Every peer MATCH now folds via `Identifier.nick_fold/1` (the same
  # primitive delete_for_dm + WHOIS/query_windows use, #121).
  describe "#372 — rfc1459 DM peer window convergence" do
    test "fetch/6 merges an inbound reply from a differently-cased peer into the window",
         %{user: user, network: net} do
      # Outbound: vjt-grappa → debugserv (channel = peer, dm_with = peer).
      {:ok, _} =
        ScrollbackHelpers.insert(
          sample(user, net, 100, %{
            channel: "debugserv",
            sender: "vjt-grappa",
            body: "HELP",
            dm_with: "debugserv"
          })
        )

      # Inbound: DebugServ (proper case) → vjt-grappa (channel = own_nick,
      # dm_with = sender, RAW casing).
      {:ok, _} =
        ScrollbackHelpers.insert(
          sample(user, net, 200, %{
            channel: "vjt-grappa",
            sender: "DebugServ",
            body: "usage",
            dm_with: "DebugServ"
          })
        )

      # A fetch under EITHER casing returns BOTH directions — one window,
      # exactly as the ircd (rfc1459) sees the nick.
      for spelling <- ["debugserv", "DebugServ", "DEBUGSERV"] do
        bodies =
          {:user, user.id}
          |> Scrollback.fetch(net.id, spelling, nil, 50, nil)
          |> Enum.map(& &1.body)
          |> Enum.sort()

        assert bodies == ["HELP", "usage"], "spelling #{spelling} did not converge"
      end
    end

    test "fetch/6 folds rfc1459 bracket chars in the DM peer",
         %{user: user, network: net} do
      {:ok, _} =
        ScrollbackHelpers.insert(
          sample(user, net, 100, %{
            channel: "Foo[1]",
            sender: "vjt-grappa",
            body: "out",
            dm_with: "Foo[1]"
          })
        )

      {:ok, _} =
        ScrollbackHelpers.insert(
          sample(user, net, 200, %{
            channel: "vjt-grappa",
            sender: "Foo{1}",
            body: "in",
            dm_with: "Foo{1}"
          })
        )

      bodies =
        {:user, user.id}
        |> Scrollback.fetch(net.id, "Foo[1]", nil, 50, nil)
        |> Enum.map(& &1.body)
        |> Enum.sort()

      assert bodies == ["in", "out"]
    end

    test "list_archive/3 collapses casing-variant DM targets into ONE entry",
         %{user: user, network: net} do
      {:ok, _} =
        ScrollbackHelpers.insert(
          sample(user, net, 100, %{
            channel: "debugserv",
            sender: "vjt-grappa",
            body: "out",
            dm_with: "debugserv"
          })
        )

      {:ok, _} =
        ScrollbackHelpers.insert(
          sample(user, net, 200, %{
            channel: "vjt-grappa",
            sender: "DebugServ",
            body: "in",
            dm_with: "DebugServ"
          })
        )

      assert [entry] = Scrollback.list_archive({:user, user.id}, net.id, MapSet.new())
      assert entry.kind == :query
      assert entry.row_count == 2
      assert entry.last_activity == 200
      # Representative display casing is incidental; the fold is the identity.
      assert Identifier.canonical_nick(entry.target) == "debugserv"
    end

    test "list_archive/3 excludes a folded-active query window (no archived split)",
         %{user: user, network: net} do
      # Window opened as `debugserv`; the service replied as `DebugServ`.
      {:ok, _} =
        ScrollbackHelpers.insert(
          sample(user, net, 100, %{
            channel: "debugserv",
            sender: "vjt-grappa",
            body: "out",
            dm_with: "debugserv"
          })
        )

      {:ok, _} =
        ScrollbackHelpers.insert(
          sample(user, net, 200, %{
            channel: "vjt-grappa",
            sender: "DebugServ",
            body: "in",
            dm_with: "DebugServ"
          })
        )

      # active_keyset carries the open query window's canonical target
      # only; the proper-case inbound rows MUST NOT resurface as archived.
      assert [] = Scrollback.list_archive({:user, user.id}, net.id, MapSet.new(["debugserv"]))
    end
  end
end
