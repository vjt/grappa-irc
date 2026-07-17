defmodule Grappa.Themes.ThemeTest do
  use Grappa.DataCase, async: true

  alias Grappa.Themes.{Theme, TokenModel}

  defp payload do
    %{
      "colors" => Map.new(TokenModel.color_keys(), fn k -> {k, "#123456"} end),
      "font_family" => "mono-default",
      "background" => %{"image_id" => nil, "opacity" => 0.3}
    }
  end

  test "valid changeset sanitizes and stores the payload" do
    cs = Theme.changeset(%Theme{}, %{name: "Night", owner_id: Ecto.UUID.generate(), payload: payload()})
    assert cs.valid?
    assert get_change(cs, :payload)["colors"]["bg"] == "#123456"
  end

  test "changeset normalizes #rgb payload colors through the sanitizer" do
    raw = put_in(payload(), ["colors", "bg"], "#ABC")
    cs = Theme.changeset(%Theme{}, %{name: "N", owner_id: Ecto.UUID.generate(), payload: raw})
    assert cs.valid?
    assert get_change(cs, :payload)["colors"]["bg"] == "#aabbcc"
  end

  test "invalid payload is rejected on the :payload field" do
    bad = put_in(payload(), ["colors", "bg"], "javascript:alert(1)")
    cs = Theme.changeset(%Theme{}, %{name: "X", owner_id: Ecto.UUID.generate(), payload: bad})
    refute cs.valid?
    assert %{payload: _} = errors_on(cs)
  end

  test "name is required" do
    cs = Theme.changeset(%Theme{}, %{owner_id: Ecto.UUID.generate(), payload: payload()})
    refute cs.valid?
    assert %{name: _} = errors_on(cs)
  end

  test "owner_id is required" do
    cs = Theme.changeset(%Theme{}, %{name: "X", payload: payload()})
    refute cs.valid?
    assert %{owner_id: _} = errors_on(cs)
  end

  test "payload is required" do
    cs = Theme.changeset(%Theme{}, %{name: "X", owner_id: Ecto.UUID.generate()})
    refute cs.valid?
    assert %{payload: _} = errors_on(cs)
  end

  test "name over 60 chars is rejected" do
    cs =
      Theme.changeset(%Theme{}, %{
        name: String.duplicate("a", 61),
        owner_id: Ecto.UUID.generate(),
        payload: payload()
      })

    refute cs.valid?
    assert %{name: _} = errors_on(cs)
  end
end
