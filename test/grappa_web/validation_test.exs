defmodule GrappaWeb.ValidationTest do
  @moduledoc """
  Unit tests for the boundary-shape validators shared by the JSON REST
  controllers.

  `take_atomized/2,3` (codebase review S22) is the single atomize helper
  the five admin controllers route their PATCH/POST whitelists through.
  It is asserted here directly — the controller tests assert each
  whitelist's key set is unchanged, this asserts the shared reduce's
  present-key / atomize / value-hook contract in isolation.
  """
  use ExUnit.Case, async: true

  alias GrappaWeb.Validation

  describe "take_atomized/2" do
    test "keeps only whitelisted keys present in params, atomized" do
      params = %{"name" => "irc.example.org", "port" => 6697}

      assert Validation.take_atomized(params, ["name", "port"]) ==
               %{name: "irc.example.org", port: 6697}
    end

    test "omits a whitelisted key absent from params (no nil fill)" do
      params = %{"name" => "irc.example.org"}

      assert Validation.take_atomized(params, ["name", "port"]) == %{name: "irc.example.org"}
    end

    test "ignores a params key that is not whitelisted" do
      params = %{"name" => "irc.example.org", "rogue" => "x"}

      assert Validation.take_atomized(params, ["name"]) == %{name: "irc.example.org"}
    end

    test "returns an empty map when no whitelisted key is present (valid no-op)" do
      assert Validation.take_atomized(%{"other" => 1}, ["name", "port"]) == %{}
    end

    test "preserves a null value for a present key (clear-the-field semantics)" do
      assert Validation.take_atomized(%{"port" => nil}, ["port"]) == %{port: nil}
    end
  end

  describe "take_atomized/3" do
    test "threads each retained value through value_fun keyed by its string key" do
      params = %{"auth_method" => "sasl", "nick" => "vjt"}

      fun = fn
        "auth_method", v -> String.to_atom(v)
        _key, v -> v
      end

      assert Validation.take_atomized(params, ["auth_method", "nick"], fun) ==
               %{auth_method: :sasl, nick: "vjt"}
    end

    test "value_fun never runs for an absent whitelisted key" do
      fun = fn
        "sasl_user", _v -> raise "must not be called for an absent key"
        _key, v -> v
      end

      assert Validation.take_atomized(%{"nick" => "vjt"}, ["nick", "sasl_user"], fun) ==
               %{nick: "vjt"}
    end
  end
end
