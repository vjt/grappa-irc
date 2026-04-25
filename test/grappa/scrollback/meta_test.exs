defmodule Grappa.Scrollback.MetaTest do
  @moduledoc """
  Unit tests for the custom `Ecto.Type` used by
  `Grappa.Scrollback.Message.meta`. Pinned at the type level (not just
  via `Scrollback.insert/1` integration) because the allowlist + atom
  table guard is a security boundary — unknown JSON keys MUST NOT be
  atomized via `String.to_atom/1` (atom table is unbounded and not
  garbage-collected).
  """
  use ExUnit.Case, async: true

  alias Grappa.Scrollback.Meta

  describe "cast/1 (changeset attrs → typed value)" do
    test "atom-keyed map: known atoms preserved" do
      assert {:ok, %{target: "alice"}} = Meta.cast(%{target: "alice"})
      assert {:ok, %{new_nick: "vjt2"}} = Meta.cast(%{new_nick: "vjt2"})
      assert {:ok, %{modes: "+o", args: ["alice"]}} = Meta.cast(%{modes: "+o", args: ["alice"]})
    end

    test "string-keyed map: known keys atomized" do
      assert {:ok, %{target: "alice"}} = Meta.cast(%{"target" => "alice"})
    end

    test "atom-keyed map: unknown atoms downgraded to strings (defensive)" do
      assert {:ok, %{"bogus" => "x"}} = Meta.cast(%{bogus: "x"})
    end

    test "string-keyed map: unknown strings stay as strings (NO String.to_atom)" do
      assert {:ok, %{"bogus" => "x"}} = Meta.cast(%{"bogus" => "x"})
    end

    test "empty map round-trips as empty map" do
      assert {:ok, %{}} = Meta.cast(%{})
    end

    test "non-map input rejected" do
      assert :error = Meta.cast("not a map")
      assert :error = Meta.cast(nil)
      assert :error = Meta.cast(42)
    end
  end

  describe "dump/1 (typed value → DB JSON map)" do
    test "stringifies all keys for JSON encoding" do
      assert {:ok, %{"target" => "alice"}} = Meta.dump(%{target: "alice"})
      assert {:ok, %{"target" => "alice"}} = Meta.dump(%{"target" => "alice"})
      assert {:ok, %{"new_nick" => "vjt2"}} = Meta.dump(%{new_nick: "vjt2"})
    end

    test "empty map dumps to empty map" do
      assert {:ok, %{}} = Meta.dump(%{})
    end

    test "non-map input rejected" do
      assert :error = Meta.dump("nope")
      assert :error = Meta.dump(nil)
    end
  end

  describe "load/1 (DB JSON map → typed value)" do
    test "atomizes allowlisted string keys (mimics post-Jason-decode shape)" do
      assert {:ok, %{target: "alice"}} = Meta.load(%{"target" => "alice"})
      assert {:ok, %{new_nick: "vjt2"}} = Meta.load(%{"new_nick" => "vjt2"})
    end

    test "leaves unknown string keys as strings (security boundary)" do
      # If a row was written with a key that isn't in @known_keys
      # (e.g. via a future kind we forgot to register), we get a
      # string key back rather than crashing the load — the row is
      # still readable.
      assert {:ok, %{"unregistered" => "value"}} = Meta.load(%{"unregistered" => "value"})
    end

    test "mixed allowlisted + unknown keys: only allowlisted atomized" do
      assert {:ok, %{"extra" => "field", target: "alice"}} =
               Meta.load(%{"target" => "alice", "extra" => "field"})
    end

    test "empty map loads to empty map" do
      assert {:ok, %{}} = Meta.load(%{})
    end

    test "non-map input rejected" do
      assert :error = Meta.load("nope")
    end
  end

  describe "type/0" do
    test "underlying DB column type is :map" do
      assert Meta.type() == :map
    end
  end

  describe "known_keys/0 ↔ Logger metadata allowlist (architecture review A18)" do
    test "every Meta @known_keys atom is present in the Logger :metadata allowlist" do
      missing = Meta.known_keys() -- logger_metadata_keys()

      assert missing == [],
             "Meta.@known_keys not in Logger metadata allowlist: " <>
               "#{inspect(missing)} — extend config/config.exs :metadata list"
    end

    defp logger_metadata_keys do
      # Elixir 1.15+ uses :default_formatter; fall back to legacy :console.
      modern = Application.get_env(:logger, :default_formatter, [])[:metadata] || []

      if modern == [],
        do: Application.get_env(:logger, :console, [])[:metadata] || [],
        else: modern
    end
  end
end
