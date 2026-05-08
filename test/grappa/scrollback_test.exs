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

  import Grappa.AuthFixtures

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

      [fetched] = Scrollback.fetch({:user, user.id}, net.id, "#sniffo", nil, 10)
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

      page = Scrollback.fetch({:user, user.id}, net.id, "#sniffo", nil, 3)

      assert length(page) == 3
      assert Enum.map(page, & &1.body) == ["msg 4", "msg 3", "msg 2"]
    end

    test "paginates by `before` cursor (strict less-than on server_time)",
         %{user: user, network: net} do
      for i <- 0..4, do: {:ok, _} = ScrollbackHelpers.insert(sample(user, net, i))

      [_, last_of_first_page] = Scrollback.fetch({:user, user.id}, net.id, "#sniffo", nil, 2)
      next_page = Scrollback.fetch({:user, user.id}, net.id, "#sniffo", last_of_first_page.server_time, 2)

      assert Enum.map(next_page, & &1.body) == ["msg 2", "msg 1"]
    end

    test "isolates rows by (network_id, channel)", %{user: user, network: net} do
      {:ok, other_net} = Networks.find_or_create_network(%{slug: "freenode-#{uniq()}"})

      {:ok, _} = ScrollbackHelpers.insert(sample(user, net, 0, %{channel: "#a"}))
      {:ok, _} = ScrollbackHelpers.insert(sample(user, net, 1, %{channel: "#b"}))
      {:ok, _} = ScrollbackHelpers.insert(sample(user, other_net, 2, %{channel: "#a"}))

      page = Scrollback.fetch({:user, user.id}, net.id, "#a", nil, 10)
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

      vjt_page = Scrollback.fetch({:user, vjt.id}, net.id, "#sniffo", nil, 10)
      assert length(vjt_page) == 1
      assert hd(vjt_page).body == "vjt-msg"

      alice_page = Scrollback.fetch({:user, alice.id}, net.id, "#sniffo", nil, 10)
      assert length(alice_page) == 1
      assert hd(alice_page).body == "alice-msg"
    end

    test "returns [] when nothing matches", %{user: user, network: net} do
      assert Scrollback.fetch({:user, user.id}, net.id, "#empty", nil, 10) == []
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
        Scrollback.fetch({:typo, "x"}, net.id, "#sniffo", nil, 10)
      end
    end

    test "raises ArgumentError on subject where the discriminator is nil", %{network: net} do
      assert_raise ArgumentError, ~r/unknown subject:/, fn ->
        Scrollback.fetch(nil, net.id, "#sniffo", nil, 10)
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

      page = Scrollback.fetch({:user, user.id}, net.id, "#sniffo", nil, 10)

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

      page = Scrollback.fetch({:user, user.id}, net.id, "#sniffo", nil, cap + 1_000)
      assert length(page) == cap
    end

    test "raises FunctionClauseError on non-positive limit", %{user: user, network: net} do
      assert_raise FunctionClauseError, fn ->
        Scrollback.fetch({:user, user.id}, net.id, "#sniffo", nil, 0)
      end
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
      page = Scrollback.fetch({:user, user.id}, net.id, "vjt-peer", nil, 10)
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

      page_a = Scrollback.fetch({:user, user.id}, net.id, "peer-a", nil, 10)
      assert Enum.map(page_a, & &1.body) == ["from A"]

      page_b = Scrollback.fetch({:user, user.id}, net.id, "peer-b", nil, 10)
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

      page = Scrollback.fetch({:user, user.id}, net.id, "#sniffo", nil, 10)
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

      page = Scrollback.fetch({:user, user.id}, net.id, "$server", nil, 10)
      assert Enum.map(page, & &1.body) == ["MOTD line"]
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

      vjt_page = Scrollback.fetch({:user, vjt.id}, net.id, "common-peer", nil, 10)
      assert Enum.map(vjt_page, & &1.body) == ["to vjt"]

      alice_page = Scrollback.fetch({:user, alice.id}, net.id, "common-peer", nil, 10)
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
    test "EXPLAIN QUERY PLAN: user-side DM fetch picks the subject-leading composite",
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

      assert plan_text =~ "messages_user_id_network_id_dm_with_server_time_index",
             "expected dm_with arm to use the subject-leading composite, got plan:\n#{plan_text}"

      refute plan_text =~ "messages_network_id_dm_with_server_time_index",
             "old subject-less index must NOT be used:\n#{plan_text}"
    end

    test "EXPLAIN QUERY PLAN: visitor-side DM fetch picks the subject-leading composite",
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

      assert plan_text =~ "messages_visitor_id_network_id_dm_with_server_time_index",
             "expected dm_with arm to use the subject-leading composite, got plan:\n#{plan_text}"

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
end
