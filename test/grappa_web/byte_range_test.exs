defmodule GrappaWeb.ByteRangeTest do
  use ExUnit.Case, async: true
  use ExUnitProperties

  alias GrappaWeb.ByteRange

  # Contract: parse(header, total) ::
  #   {:ok, {offset, length}} → serve 206 with that slice
  #   :unsatisfiable          → serve 416 (start beyond EOF / zero suffix)
  #   :ignore                 → serve 200 full (absent grammar, multi-range)
  describe "parse/2 — satisfiable single ranges" do
    test "bounded range bytes=0-3" do
      assert ByteRange.parse("bytes=0-3", 16) == {:ok, {0, 4}}
    end

    test "single byte probe bytes=0-0 (iOS Safari opener)" do
      assert ByteRange.parse("bytes=0-0", 16) == {:ok, {0, 1}}
    end

    test "open-ended bytes=4- runs to EOF" do
      assert ByteRange.parse("bytes=4-", 16) == {:ok, {4, 12}}
    end

    test "suffix bytes=-5 is the last five bytes" do
      assert ByteRange.parse("bytes=-5", 16) == {:ok, {11, 5}}
    end

    test "suffix longer than the file is the whole file" do
      assert ByteRange.parse("bytes=-99", 16) == {:ok, {0, 16}}
    end

    test "last-byte-pos beyond EOF clamps to EOF" do
      assert ByteRange.parse("bytes=8-999", 16) == {:ok, {8, 8}}
    end

    test "range unit is case-insensitive per RFC 9110" do
      assert ByteRange.parse("BYTES=0-3", 16) == {:ok, {0, 4}}
    end
  end

  describe "parse/2 — unsatisfiable ranges (416)" do
    test "first-byte-pos at EOF" do
      assert ByteRange.parse("bytes=16-", 16) == :unsatisfiable
    end

    test "first-byte-pos beyond EOF" do
      assert ByteRange.parse("bytes=99-100", 16) == :unsatisfiable
    end

    test "zero-length suffix" do
      assert ByteRange.parse("bytes=-0", 16) == :unsatisfiable
    end
  end

  describe "parse/2 — ignored headers (200 full body)" do
    test "last-byte-pos below first-byte-pos is an invalid spec" do
      assert ByteRange.parse("bytes=5-2", 16) == :ignore
    end

    test "multi-range is legal but we choose not to serve it" do
      assert ByteRange.parse("bytes=0-1,3-4", 16) == :ignore
    end

    test "unknown unit" do
      assert ByteRange.parse("lines=0-3", 16) == :ignore
    end

    test "no unit at all" do
      assert ByteRange.parse("bananas", 16) == :ignore
    end

    test "empty spec" do
      assert ByteRange.parse("bytes=", 16) == :ignore
    end

    test "non-numeric positions" do
      assert ByteRange.parse("bytes=a-b", 16) == :ignore
    end

    test "bare dash" do
      assert ByteRange.parse("bytes=-", 16) == :ignore
    end

    test "negative first-byte-pos never parses as a bounded range" do
      assert ByteRange.parse("bytes=-5-3", 16) == :ignore
    end
  end

  describe "parse/2 — properties" do
    property "an {:ok, slice} always lies within the file" do
      check all(
              total <- integer(1..10_000),
              first <- integer(0..12_000),
              last <- one_of([integer(0..12_000), constant(nil)])
            ) do
        header =
          case last do
            nil -> "bytes=#{first}-"
            n -> "bytes=#{first}-#{n}"
          end

        case ByteRange.parse(header, total) do
          {:ok, {offset, length}} ->
            assert offset >= 0
            assert length >= 1
            assert offset + length <= total

          other ->
            assert other in [:unsatisfiable, :ignore]
        end
      end
    end

    property "satisfiable bounded ranges slice exactly [first, min(last, total-1)]" do
      check all(
              total <- integer(1..10_000),
              first <- integer(0..(total - 1)),
              extra <- integer(0..5_000)
            ) do
        last = first + extra

        assert ByteRange.parse("bytes=#{first}-#{last}", total) ==
                 {:ok, {first, min(last, total - 1) - first + 1}}
      end
    end

    property "suffix ranges cover the tail of the file" do
      check all(total <- integer(1..10_000), n <- integer(1..12_000)) do
        start = max(total - n, 0)
        assert ByteRange.parse("bytes=-#{n}", total) == {:ok, {start, total - start}}
      end
    end
  end
end
