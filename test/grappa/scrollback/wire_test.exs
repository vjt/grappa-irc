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
               kind: "privmsg",
               sender: "vjt",
               body: "msg 42",
               meta: %{}
             }
    end

    # B6.3 / HIGH-26: kind is atom-stringified at the wire boundary
    # (was implicit-via-Jason; now explicit to match the @type t spec).
    test "stringifies :kind atom for non-privmsg kinds",
         %{user: user, network: network} do
      {:ok, _} =
        ScrollbackHelpers.insert(sample(user, network, 0, %{kind: :nick_change, body: nil, meta: %{new_nick: "vjt2"}}))

      [fetched] = Scrollback.fetch({:user, user.id}, network.id, "#sniffo", nil, 10)
      wire = fetched |> Repo.preload(:network) |> Wire.to_json()

      assert wire.kind == "nick_change"
      assert wire.body == nil
      assert wire.meta == %{new_nick: "vjt2"}
    end

    test "does NOT expose user_id (decision G3 — topic discriminator, not payload)",
         %{user: user, network: network} do
      {:ok, msg} = ScrollbackHelpers.insert(sample(user, network, 0))
      preloaded = Repo.preload(msg, :network)

      wire = Wire.to_json(preloaded)
      refute Map.has_key?(wire, :user_id)
    end
  end

  describe "message_payload/1" do
    test "wraps a row in %{kind: \"message\", message: wire}",
         %{user: user, network: network} do
      {:ok, msg} = ScrollbackHelpers.insert(sample(user, network, 1))
      preloaded = Repo.preload(msg, :network)

      assert %{kind: "message", message: wire} = Wire.message_payload(preloaded)
      assert wire == Wire.to_json(preloaded)
    end
  end

  describe "archive_entry/1" do
    test "stringifies :kind atom and preserves remaining fields under atom keys" do
      assert Wire.archive_entry(%{
               target: "#sniffo",
               kind: :channel,
               last_activity: 12_345,
               row_count: 7
             }) == %{
               target: "#sniffo",
               kind: "channel",
               last_activity: 12_345,
               row_count: 7
             }
    end

    test "stringifies :query kind for nick-targeted DM windows" do
      assert Wire.archive_entry(%{
               target: "vjt-peer",
               kind: :query,
               last_activity: 999,
               row_count: 1
             }).kind == "query"
    end
  end

  describe "archive_index/1" do
    test "wraps a list of entries in the %{archive: [...]} envelope" do
      entries = [
        %{target: "vjt-peer", kind: :query, last_activity: 300, row_count: 1},
        %{target: "#a", kind: :channel, last_activity: 100, row_count: 1}
      ]

      assert Wire.archive_index(entries) == %{
               archive: [
                 %{target: "vjt-peer", kind: "query", last_activity: 300, row_count: 1},
                 %{target: "#a", kind: "channel", last_activity: 100, row_count: 1}
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
               kind: "archive_purged",
               network_slug: "bahamut-test",
               target: "#bofh"
             }
    end

    test "preserves nick-shaped targets verbatim for query-kind purges" do
      assert Wire.archive_purged_payload("freenode", "alice") == %{
               kind: "archive_purged",
               network_slug: "freenode",
               target: "alice"
             }
    end
  end
end
