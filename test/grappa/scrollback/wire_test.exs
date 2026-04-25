defmodule Grappa.Scrollback.WireTest do
  @moduledoc """
  Tests for `Grappa.Scrollback.Wire` — the single source of truth for
  the public message wire shape and the broadcast event wrapper.
  """
  use Grappa.DataCase, async: true

  alias Grappa.Scrollback
  alias Grappa.Scrollback.Wire

  defp sample(i, overrides \\ %{}) do
    Map.merge(
      %{
        network_id: "azzurra",
        channel: "#sniffo",
        server_time: i,
        kind: "privmsg",
        sender: "vjt",
        body: "msg #{i}"
      },
      overrides
    )
  end

  describe "to_json/1" do
    test "renders a privmsg row to the canonical JSON-shape map" do
      {:ok, msg} = Scrollback.insert(sample(42))

      assert Wire.to_json(msg) == %{
               id: msg.id,
               network_id: "azzurra",
               channel: "#sniffo",
               server_time: 42,
               kind: :privmsg,
               sender: "vjt",
               body: "msg 42",
               meta: %{}
             }
    end

    test "includes atom-keyed meta payload for non-privmsg kinds (round-trip via DB)" do
      {:ok, _} =
        Scrollback.insert(%{
          network_id: "azzurra",
          channel: "#sniffo",
          server_time: 0,
          kind: :nick_change,
          sender: "vjt",
          meta: %{new_nick: "vjt2"}
        })

      [fetched] = Scrollback.fetch("azzurra", "#sniffo", nil, 10)
      wire = Wire.to_json(fetched)

      assert wire.kind == :nick_change
      assert wire.body == nil
      assert wire.meta == %{new_nick: "vjt2"}
    end
  end

  describe "message_event/1" do
    test "wraps a row in {:event, %{kind: :message, message: wire}}" do
      {:ok, msg} = Scrollback.insert(sample(1))

      assert {:event, %{kind: :message, message: wire}} = Wire.message_event(msg)
      assert wire == Wire.to_json(msg)
    end
  end
end
