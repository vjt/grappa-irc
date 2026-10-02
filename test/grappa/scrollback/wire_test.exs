defmodule Grappa.Scrollback.WireTest do
  @moduledoc """
  Tests for `Grappa.Scrollback.Wire` — the single source of truth for
  the public message wire shape and the broadcast event wrapper.
  Phase 2 (sub-task 2e): the wire emits the network slug under
  `:network` and does NOT carry `user_id` (decision G3).
  """
  use Grappa.DataCase, async: false

  alias Grappa.{Accounts, Networks, Repo, Scrollback, ScrollbackHelpers}
  alias Grappa.Scrollback.Wire

  setup do
    {:ok, user} =
      Accounts.create_user(%{
        name: "vjt-#{System.unique_integer([:positive])}",
        password: "correct horse battery"
      })

    {:ok, network} =
      Networks.find_or_create_network(%{slug: "azzurra-#{System.unique_integer([:positive])}"})

    %{user: user, network: network}
  end

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

  describe "to_json/1" do
    test "renders a privmsg row to the canonical JSON-shape map (slug under :network)",
         %{user: user, network: network} do
      {:ok, msg} = ScrollbackHelpers.insert(sample(user, network, 42))
      preloaded = Repo.preload(msg, :network)

      assert Wire.to_json(preloaded) == %{
               id: msg.id,
               network: network.slug,
               channel: "#sniffo",
               server_time: 42,
               kind: :privmsg,
               sender: "vjt",
               body: "msg 42",
               meta: %{},
               dm_with: nil
             }
    end

    # issue 1365 (protocol 36) — an inbound DM carries `dm_with` RAW, the
    # discriminator a nick change never rewrites; `channel` keeps the own
    # nick we held at receipt. Same field the away bundle carries (#2333).
    test "an inbound DM row carries dm_with RAW beside the own-nick channel",
         %{user: user, network: network} do
      {:ok, msg} =
        ScrollbackHelpers.insert(sample(user, network, 43, %{channel: "vjt", sender: "Alice", dm_with: "Alice"}))

      wire = msg |> Repo.preload(:network) |> Wire.to_json()

      assert wire.dm_with == "Alice"
      assert wire.channel == "vjt"
    end

    # S14: kind is the Message.kind() ATOM in the term (Jason
    # stringifies at the JSON edge; codegen pins the literal union).
    test "carries the :kind atom in the term for non-privmsg kinds",
         %{user: user, network: network} do
      {:ok, _} =
        ScrollbackHelpers.insert(sample(user, network, 0, %{kind: :nick_change, body: nil, meta: %{new_nick: "vjt2"}}))

      [fetched] = Scrollback.fetch({:user, user.id}, network.id, "#sniffo", nil, 10, nil, false)
      wire = fetched |> Repo.preload(:network) |> Wire.to_json()

      assert wire.kind == :nick_change
      assert wire.body == nil
      assert wire.meta == %{new_nick: "vjt2"}
    end

    # S14: prove the WIRE BYTES are unchanged — Jason stringifies the
    # kind atom to the same JSON value the former `Atom.to_string/1`
    # emitted, so no runtime contract change reaches cic.
    test "Jason encodes the kind atom to its string on the wire",
         %{user: user, network: network} do
      {:ok, msg} = ScrollbackHelpers.insert(sample(user, network, 7, %{kind: :notice}))
      wire = msg |> Repo.preload(:network) |> Wire.to_json()

      assert Jason.decode!(Jason.encode!(wire))["kind"] == "notice"
    end

    test "does NOT expose user_id (decision G3 — topic discriminator, not payload)",
         %{user: user, network: network} do
      {:ok, msg} = ScrollbackHelpers.insert(sample(user, network, 0))
      preloaded = Repo.preload(msg, :network)

      wire = Wire.to_json(preloaded)
      refute Map.has_key?(wire, :user_id)
    end
  end

  describe "message_payload/2" do
    test "wraps a row in %{kind: \"message\", message: wire}",
         %{user: user, network: network} do
      {:ok, msg} = ScrollbackHelpers.insert(sample(user, network, 1))

      # #1657b — the broadcast door takes the slug; no preload. The equality
      # against the read-path door on the SAME row is what keeps "one body,
      # two entrances" a fact rather than a claim.
      assert %{kind: :message, message: wire} = Wire.message_payload(msg, network.slug)
      assert wire == Wire.to_json(Repo.preload(msg, :network))
    end
  end

  describe "archive_entry/1" do
    # S14: kind is the `:channel | :query` ATOM in the term (Jason
    # stringifies at the JSON edge; codegen pins the literal union
    # `"channel" | "query"`) — same convention as the message `:kind`.
    test "passes the :kind atom through and preserves remaining fields under atom keys" do
      assert Wire.archive_entry(%{
               target: "#sniffo",
               kind: :channel,
               last_activity: 12_345
             }) == %{
               target: "#sniffo",
               kind: :channel,
               last_activity: 12_345
             }
    end

    # #1626 (protocol v8) — `row_count` is GONE, and the equality above is
    # what pins that: an extra key in the output would fail it. This case
    # states the removal from the other side, so a reader of the test file
    # sees the field named rather than absent.
    test "does not emit row_count — removed in protocol v8" do
      wire = Wire.archive_entry(%{target: "#sniffo", kind: :channel, last_activity: 1})

      refute Map.has_key?(wire, :row_count)
      assert Enum.sort(Map.keys(wire)) == [:kind, :last_activity, :target]
    end

    # An Elixir map pattern matches a SUBSET, so a caller still holding the
    # pre-#1626 shape does NOT hit a clause error — measured, after asserting
    # the opposite and being wrong. What actually protects the wire is that
    # this function BUILDS its result rather than passing the input through:
    # the stale key is dropped, never re-emitted. That is the assertion worth
    # having, and it is the same tolerance the client side relies on.
    test "an entry still carrying row_count has it dropped, not re-emitted" do
      wire = Wire.archive_entry(%{target: "#s", kind: :channel, last_activity: 1, row_count: 7})

      refute Map.has_key?(wire, :row_count)
      assert wire == %{target: "#s", kind: :channel, last_activity: 1}
    end

    test "passes the :query kind atom through for nick-targeted DM windows" do
      assert Wire.archive_entry(%{
               target: "vjt-peer",
               kind: :query,
               last_activity: 999
             }).kind == :query
    end

    # S14: prove the WIRE BYTES are unchanged — Jason stringifies the kind
    # atom to the same JSON value the former `Atom.to_string/1` emitted, so
    # no runtime contract change reaches cic.
    test "Jason encodes the archive kind atom to its string on the wire" do
      wire =
        Wire.archive_entry(%{
          target: "vjt-peer",
          kind: :query,
          last_activity: 999
        })

      assert Jason.decode!(Jason.encode!(wire))["kind"] == "query"
    end
  end

  describe "archive_index/1" do
    test "wraps a list of entries in the %{archive: [...]} envelope" do
      entries = [
        %{target: "vjt-peer", kind: :query, last_activity: 300},
        %{target: "#a", kind: :channel, last_activity: 100}
      ]

      assert Wire.archive_index(entries) == %{
               archive: [
                 %{target: "vjt-peer", kind: :query, last_activity: 300},
                 %{target: "#a", kind: :channel, last_activity: 100}
               ]
             }
    end

    test "renders an empty list to %{archive: []}" do
      assert Wire.archive_index([]) == %{archive: []}
    end
  end

  describe "archive_purged_payload/2" do
    test "carries network_slug and target so cic can invalidate the right scrollback key" do
      assert Wire.archive_purged_payload("bahamut-test", "#bofh") == %{
               kind: :archive_purged,
               network_slug: "bahamut-test",
               target: "#bofh"
             }
    end

    test "preserves nick-shaped targets verbatim for query-kind purges" do
      assert Wire.archive_purged_payload("freenode", "alice") == %{
               kind: :archive_purged,
               network_slug: "freenode",
               target: "alice"
             }
    end
  end
end
