defmodule Grappa.ClientIdTest do
  @moduledoc """
  Direct exercise of the custom Ecto type. The plug
  (`GrappaWeb.Plugs.ClientId`) is tested separately at
  `test/grappa_web/plugs/client_id_test.exs`; both surfaces share the
  regex via `Grappa.ClientId.regex/0`.
  """
  use ExUnit.Case, async: true

  alias Grappa.ClientId

  @valid_v4 "44c2ab8a-cb38-4960-b92a-a7aefb190386"
  @invalid_no_hyphens "44c2ab8acb384960b92aa7aefb190386"
  # version nibble = 1, not 4
  @invalid_v1 "44c2ab8a-cb38-1960-b92a-a7aefb190386"
  @invalid_too_long String.duplicate("a", 100)

  describe "cast/1" do
    test "accepts canonical UUID v4" do
      assert {:ok, @valid_v4} = ClientId.cast(@valid_v4)
    end

    test "rejects non-UUID string (no hyphens)" do
      assert :error = ClientId.cast(@invalid_no_hyphens)
    end

    test "rejects oversize string" do
      assert :error = ClientId.cast(@invalid_too_long)
    end

    test "rejects non-v4 UUID (version nibble enforced)" do
      assert :error = ClientId.cast(@invalid_v1)
    end

    test "accepts nil" do
      assert {:ok, nil} = ClientId.cast(nil)
    end

    test "rejects non-binary input (integer)" do
      assert :error = ClientId.cast(42)
    end
  end

  describe "load/1 (defense in depth)" do
    test "re-validates UUID v4 on schema load" do
      assert {:ok, @valid_v4} = ClientId.load(@valid_v4)
    end

    test "rejects malformed value loaded directly from DB" do
      assert :error = ClientId.load(@invalid_no_hyphens)
    end

    test "passes nil through" do
      assert {:ok, nil} = ClientId.load(nil)
    end
  end

  describe "dump/1" do
    test "returns underlying string for valid UUID v4" do
      assert {:ok, @valid_v4} = ClientId.dump(@valid_v4)
    end

    test "passes nil through" do
      assert {:ok, nil} = ClientId.dump(nil)
    end

    test "rejects malformed string at dump-time (defense for direct changeset.change/2 callers)" do
      assert :error = ClientId.dump(@invalid_no_hyphens)
    end

    test "rejects non-binary input" do
      assert :error = ClientId.dump(42)
    end
  end

  describe "type/0" do
    test "underlying storage is :string" do
      assert ClientId.type() == :string
    end
  end

  describe "regex/0" do
    test "exposes the compiled UUID v4 regex (case-insensitive)" do
      assert Regex.match?(ClientId.regex(), @valid_v4)
      assert Regex.match?(ClientId.regex(), String.upcase(@valid_v4))
      refute Regex.match?(ClientId.regex(), @invalid_v1)
    end
  end
end
