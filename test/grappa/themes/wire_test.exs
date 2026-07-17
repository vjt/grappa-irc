defmodule Grappa.Themes.WireTest do
  use Grappa.DataCase, async: true

  import Grappa.AuthFixtures

  alias Grappa.{Repo, Themes, Themes.Theme, Themes.TokenModel, Themes.Wire, Visitors.Visitor}

  defp valid_payload do
    %{
      "colors" => Map.new(TokenModel.color_keys(), fn k -> {k, "#123456"} end),
      "font_family" => "mono-default",
      "background" => %{"image_id" => nil, "opacity" => 0.3}
    }
  end

  defp visitor_subject, do: {:visitor, %Visitor{id: Ecto.UUID.generate()}}

  defp seed_builtin do
    system = Themes.system_user()

    {:ok, theme} =
      %Theme{}
      |> Theme.changeset(%{
        name: "builtin-#{System.unique_integer([:positive])}",
        owner_id: system.id,
        payload: valid_payload(),
        published: true
      })
      |> Repo.insert()

    {:ok, reloaded} = Themes.get_theme(theme.id)
    reloaded
  end

  describe "to_wire/2" do
    test "renders the full wire shape with the owner's name as author" do
      user = user_fixture(name: "alice")
      {:ok, created} = Themes.create_theme({:user, user}, %{name: "Night", payload: valid_payload()})
      {:ok, theme} = Themes.get_theme(created.id)

      wire = Wire.to_wire(theme, {:user, user})

      assert wire.id == theme.id
      assert wire.name == "Night"
      assert wire.author == "alice"
      assert wire.built_in == false
      assert wire.published == false
      assert wire.apply_count == 0
      assert wire.payload == valid_payload()

      assert Enum.sort(Map.keys(wire)) ==
               ~w(apply_count author built_in id inserted_at mine name payload published)a
    end

    test "inserted_at is an ISO-8601 string" do
      user = user_fixture()
      {:ok, created} = Themes.create_theme({:user, user}, %{name: "N", payload: valid_payload()})
      {:ok, theme} = Themes.get_theme(created.id)

      wire = Wire.to_wire(theme, {:user, user})
      assert {:ok, %DateTime{}, _} = DateTime.from_iso8601(wire.inserted_at)
    end

    test "built_in is true when the owner is the system user" do
      builtin = seed_builtin()
      viewer = user_fixture()
      assert Wire.to_wire(builtin, {:user, viewer}).built_in == true
    end

    test "mine is true only when the viewer is the owner" do
      owner = user_fixture()
      other = user_fixture()
      {:ok, created} = Themes.create_theme({:user, owner}, %{name: "N", payload: valid_payload()})
      {:ok, theme} = Themes.get_theme(created.id)

      assert Wire.to_wire(theme, {:user, owner}).mine == true
      assert Wire.to_wire(theme, {:user, other}).mine == false
      assert Wire.to_wire(theme, visitor_subject()).mine == false
    end
  end
end
