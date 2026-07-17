defmodule Grappa.Themes.BuiltinsTest do
  use ExUnit.Case, async: true

  alias Grappa.Themes.{Builtins, TokenModel}

  test "all/0 ships at least ten curated built-ins" do
    assert length(Builtins.all()) >= 10
  end

  test "every built-in has a unique, non-empty name" do
    names = Enum.map(Builtins.all(), & &1.name)
    assert Enum.all?(names, &(is_binary(&1) and byte_size(&1) > 0))
    assert names == Enum.uniq(names)
  end

  test "every built-in payload sanitizes clean (round-trips through the closed model)" do
    for %{name: name, payload: payload} <- Builtins.all() do
      assert {:ok, clean} = TokenModel.sanitize(payload),
             "built-in #{name} does not sanitize clean"

      # A curated payload is ALREADY canonical — sanitize is the identity.
      assert clean == payload, "built-in #{name} is not already canonical"
    end
  end
end
