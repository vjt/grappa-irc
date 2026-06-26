defmodule Grappa.ChannelDirectory.WireTest do
  use ExUnit.Case, async: true
  alias Grappa.ChannelDirectory.Wire

  test "index_payload renders the page envelope with ISO8601 captured_at" do
    page = %{
      entries: [%{name: "#a", topic: "t", user_count: 3}],
      next_cursor: "C",
      total: 1,
      captured_at: ~U[2026-06-26 10:00:00Z],
      status: :fresh
    }

    assert Wire.index_payload(page) == %{
             entries: [%{name: "#a", topic: "t", user_count: 3}],
             next_cursor: "C",
             total: 1,
             captured_at: "2026-06-26T10:00:00Z",
             status: "fresh"
           }
  end

  test "nil captured_at stays nil" do
    page = %{entries: [], next_cursor: nil, total: 0, captured_at: nil, status: :empty}
    assert %{captured_at: nil, status: "empty"} = Wire.index_payload(page)
  end
end
