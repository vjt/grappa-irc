defmodule Grappa.ChannelDirectory.WireTest do
  use ExUnit.Case, async: true
  alias Grappa.ChannelDirectory.Wire

  test "index_payload renders the page envelope with ISO8601 captured_at + featured flag" do
    page = %{
      entries: [%{name: "#a", topic: "t", user_count: 3}, %{name: "#B", topic: nil, user_count: 1}],
      next_cursor: "C",
      total: 2,
      captured_at: ~U[2026-06-26 10:00:00Z],
      status: :fresh
    }

    # featured set is downcased; "#B" matches "#b" (channel fold).
    featured = MapSet.new(["#b"])

    assert Wire.index_payload(page, featured) == %{
             entries: [
               %{name: "#a", topic: "t", user_count: 3, featured: false},
               %{name: "#B", topic: nil, user_count: 1, featured: true}
             ],
             next_cursor: "C",
             total: 2,
             captured_at: "2026-06-26T10:00:00Z",
             status: "fresh"
           }
  end

  test "nil captured_at stays nil; empty featured set marks nothing" do
    page = %{entries: [], next_cursor: nil, total: 0, captured_at: nil, status: :empty}
    assert %{captured_at: nil, status: "empty"} = Wire.index_payload(page, MapSet.new())
  end

  test "featured match folds rfc1459 brackets, not bare downcase (#364)" do
    # Directory names are stored VERBATIM (case-preserving display); the
    # featured set is stored canonical (rfc1459-folded via
    # canonical_channel/1). A bracket-char channel `#Foo[1]` from the
    # directory must mark featured against the folded `#foo{1}` — a bare
    # String.downcase would leave `#foo[1]` and miss it.
    page = %{
      entries: [%{name: "#Foo[1]", topic: nil, user_count: 2}],
      next_cursor: nil,
      total: 1,
      captured_at: nil,
      status: :fresh
    }

    featured = MapSet.new(["#foo{1}"])

    assert %{entries: [%{name: "#Foo[1]", featured: true}]} =
             Wire.index_payload(page, featured)
  end
end
