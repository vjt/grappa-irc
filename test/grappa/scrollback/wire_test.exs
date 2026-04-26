defmodule Grappa.Scrollback.WireTest do
  @moduledoc """
  Tests for `Grappa.Scrollback.Wire` — the single source of truth for
  the public message wire shape and the broadcast event wrapper.
  Phase 2 (sub-task 2e): the wire emits the network slug under
  `:network` and does NOT carry `user_id` (decision G3).
  """
  use Grappa.DataCase, async: false

  alias Grappa.{Accounts, Networks, Repo, Scrollback}
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
      {:ok, msg} = Scrollback.insert(sample(user, network, 42))
      preloaded = Repo.preload(msg, :network)

      assert Wire.to_json(preloaded) == %{
               id: msg.id,
               network: network.slug,
               channel: "#sniffo",
               server_time: 42,
               kind: :privmsg,
               sender: "vjt",
               body: "msg 42",
               meta: %{}
             }
    end

    test "includes atom-keyed meta payload for non-privmsg kinds (round-trip via DB)",
         %{user: user, network: network} do
      {:ok, _} =
        Scrollback.insert(sample(user, network, 0, %{kind: :nick_change, body: nil, meta: %{new_nick: "vjt2"}}))

      [fetched] = Scrollback.fetch(user.id, network.id, "#sniffo", nil, 10)
      wire = fetched |> Repo.preload(:network) |> Wire.to_json()

      assert wire.kind == :nick_change
      assert wire.body == nil
      assert wire.meta == %{new_nick: "vjt2"}
    end

    test "does NOT expose user_id (decision G3 — topic discriminator, not payload)",
         %{user: user, network: network} do
      {:ok, msg} = Scrollback.insert(sample(user, network, 0))
      preloaded = Repo.preload(msg, :network)

      wire = Wire.to_json(preloaded)
      refute Map.has_key?(wire, :user_id)
    end
  end

  describe "message_event/1" do
    test "wraps a row in {:event, %{kind: :message, message: wire}}",
         %{user: user, network: network} do
      {:ok, msg} = Scrollback.insert(sample(user, network, 1))
      preloaded = Repo.preload(msg, :network)

      assert {:event, %{kind: :message, message: wire}} = Wire.message_event(preloaded)
      assert wire == Wire.to_json(preloaded)
    end
  end
end
