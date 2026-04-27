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

  alias Grappa.{Accounts, Networks, Repo, Scrollback, ScrollbackHelpers}
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

    test "rejects missing required fields (user_id/network_id/channel/server_time/kind/sender)" do
      assert {:error, %Ecto.Changeset{} = cs} =
               ScrollbackHelpers.insert(%{channel: "#x"})

      errors = errors_on(cs)
      assert "can't be blank" in errors.user_id
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
      # persist_and_broadcast → Wire.message_event, and the REST POST
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

      [fetched] = Scrollback.fetch(user.id, net.id, "#sniffo", nil, 10)
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

      page = Scrollback.fetch(user.id, net.id, "#sniffo", nil, 3)

      assert length(page) == 3
      assert Enum.map(page, & &1.body) == ["msg 4", "msg 3", "msg 2"]
    end

    test "paginates by `before` cursor (strict less-than on server_time)",
         %{user: user, network: net} do
      for i <- 0..4, do: {:ok, _} = ScrollbackHelpers.insert(sample(user, net, i))

      [_, last_of_first_page] = Scrollback.fetch(user.id, net.id, "#sniffo", nil, 2)
      next_page = Scrollback.fetch(user.id, net.id, "#sniffo", last_of_first_page.server_time, 2)

      assert Enum.map(next_page, & &1.body) == ["msg 2", "msg 1"]
    end

    test "isolates rows by (network_id, channel)", %{user: user, network: net} do
      {:ok, other_net} = Networks.find_or_create_network(%{slug: "freenode-#{uniq()}"})

      {:ok, _} = ScrollbackHelpers.insert(sample(user, net, 0, %{channel: "#a"}))
      {:ok, _} = ScrollbackHelpers.insert(sample(user, net, 1, %{channel: "#b"}))
      {:ok, _} = ScrollbackHelpers.insert(sample(user, other_net, 2, %{channel: "#a"}))

      page = Scrollback.fetch(user.id, net.id, "#a", nil, 10)
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

      vjt_page = Scrollback.fetch(vjt.id, net.id, "#sniffo", nil, 10)
      assert length(vjt_page) == 1
      assert hd(vjt_page).body == "vjt-msg"

      alice_page = Scrollback.fetch(alice.id, net.id, "#sniffo", nil, 10)
      assert length(alice_page) == 1
      assert hd(alice_page).body == "alice-msg"
    end

    test "returns [] when nothing matches", %{user: user, network: net} do
      assert Scrollback.fetch(user.id, net.id, "#empty", nil, 10) == []
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

      page = Scrollback.fetch(user.id, net.id, "#sniffo", nil, 10)

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

      page = Scrollback.fetch(user.id, net.id, "#sniffo", nil, cap + 1_000)
      assert length(page) == cap
    end

    test "raises FunctionClauseError on non-positive limit", %{user: user, network: net} do
      assert_raise FunctionClauseError, fn ->
        Scrollback.fetch(user.id, net.id, "#sniffo", nil, 0)
      end
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
end
