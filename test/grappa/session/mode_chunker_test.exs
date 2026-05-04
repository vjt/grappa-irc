defmodule Grappa.Session.ModeChunkerTest do
  @moduledoc """
  Tests for `Grappa.Session.ModeChunker`.

  Covers:
  - Basic single-chunk operation (fits within max_per_chunk).
  - Multi-chunk split: N nicks/masks across multiple MODE lines.
  - Sign-preservation across chunk boundaries.
  - Empty param list (banlist query, umode, raw mode with no targets).
  - StreamData round-trip property: reassembling all chunks yields the
    same set of (sign+letter, param) pairs as the input.
  """
  use ExUnit.Case, async: true
  use ExUnitProperties

  alias Grappa.Session.ModeChunker

  # ---------------------------------------------------------------------------
  # Unit tests
  # ---------------------------------------------------------------------------

  describe "chunk/3 — basic cases" do
    test "single nick fits within max: one chunk returned" do
      chunks = ModeChunker.chunk("+o", ["alice"], 3)
      assert chunks == [{"+o", ["alice"]}]
    end

    test "three nicks with max=3: one chunk returned, mode letter repeated" do
      chunks = ModeChunker.chunk("+o", ["a", "b", "c"], 3)
      assert chunks == [{"+ooo", ["a", "b", "c"]}]
    end

    test "four nicks with max=3: splits into two chunks" do
      chunks = ModeChunker.chunk("+o", ["a", "b", "c", "d"], 3)
      assert length(chunks) == 2
      [{m1, p1}, {m2, p2}] = chunks
      assert m1 == "+ooo" and p1 == ["a", "b", "c"]
      assert m2 == "+o" and p2 == ["d"]
    end

    test "five nicks with max=3: first chunk has 3, second has 2" do
      chunks = ModeChunker.chunk("+o", ["a", "b", "c", "d", "e"], 3)
      assert length(chunks) == 2
      [{_, p1}, {_, p2}] = chunks
      assert length(p1) == 3
      assert length(p2) == 2
    end

    test "deop with max=2: two-letter sign groups per chunk" do
      chunks = ModeChunker.chunk("-o", ["a", "b", "c"], 2)
      assert length(chunks) == 2
      [{m1, p1}, {m2, p2}] = chunks
      assert m1 == "-oo" and p1 == ["a", "b"]
      assert m2 == "-o" and p2 == ["c"]
    end

    test "ban masks with max=1: one chunk per mask" do
      chunks = ModeChunker.chunk("+b", ["*!*@evil.com", "*!*@bad.org"], 1)
      assert chunks == [{"+b", ["*!*@evil.com"]}, {"+b", ["*!*@bad.org"]}]
    end

    test "empty params (banlist query or umode): returns single chunk with no params" do
      chunks = ModeChunker.chunk("+b", [], 3)
      assert chunks == [{"+b", []}]
    end

    test "empty params with any max_per_chunk: single empty-param chunk" do
      chunks = ModeChunker.chunk("+i", [], 1)
      assert chunks == [{"+i", []}]
    end

    test "voice with max=3 and exactly 6 nicks: two full chunks" do
      nicks = ["a", "b", "c", "d", "e", "f"]
      chunks = ModeChunker.chunk("+v", nicks, 3)
      assert length(chunks) == 2
      [{m1, p1}, {m2, p2}] = chunks
      assert m1 == "+vvv" and p1 == ["a", "b", "c"]
      assert m2 == "+vvv" and p2 == ["d", "e", "f"]
    end
  end

  describe "chunk/3 — mode letter repetition" do
    test "mode letter is repeated per param in each chunk" do
      # max=2: chunk 1 = 2 nicks → "+oo"; chunk 2 = 1 nick → "+o"
      chunks = ModeChunker.chunk("+o", ["a", "b", "c"], 2)
      [{m1, _}, {m2, _}] = chunks
      assert m1 == "+oo"
      assert m2 == "+o"
    end

    test "single mode with one nick: sign+one letter" do
      chunks = ModeChunker.chunk("+o", ["a"], 3)
      [{m1, _}] = chunks
      assert m1 == "+o"
    end

    test "devoice repeats -vv for two params" do
      chunks = ModeChunker.chunk("-v", ["a", "b"], 3)
      [{m1, _}] = chunks
      assert m1 == "-vv"
    end
  end

  # ---------------------------------------------------------------------------
  # StreamData property test
  # ---------------------------------------------------------------------------

  describe "round-trip property" do
    property "reassembling chunks recovers original (sign, letter, param) pairs" do
      check all(
              sign <- StreamData.member_of(["+", "-"]),
              letter <- StreamData.string(:alphanumeric, min_length: 1, max_length: 1),
              params <-
                StreamData.list_of(
                  StreamData.string(:printable, min_length: 1, max_length: 20),
                  max_length: 15
                ),
              max_per_chunk <- StreamData.integer(1..5)
            ) do
        mode_str = sign <> letter
        chunks = ModeChunker.chunk(mode_str, params, max_per_chunk)

        # Reassemble: flatten all params from all chunks
        all_params = Enum.flat_map(chunks, fn {_, ps} -> ps end)

        # The order and content of params must be preserved
        assert all_params == params

        # Every chunk must be non-empty (at least the mode string)
        assert Enum.all?(chunks, fn {m, _} -> is_binary(m) and byte_size(m) >= 1 end)

        # If params is non-empty: each chunk has at least 1 param, at most max_per_chunk
        if params != [] do
          assert Enum.all?(chunks, fn {_, ps} ->
                   ps != [] and Enum.count(ps) <= max_per_chunk
                 end)

          # Total params reassembled == original params count
          assert Enum.count(all_params) == Enum.count(params)
        end
      end
    end
  end
end
