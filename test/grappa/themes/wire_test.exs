defmodule Grappa.Themes.WireTest do
  use Grappa.DataCase, async: true

  import Grappa.AuthFixtures

  alias Grappa.{Repo, Themes, Themes.Theme, Themes.TokenModel, Themes.Wire, Visitors.Visitor}

  defp valid_payload do
    %{
      "colors" => Map.new(TokenModel.color_keys(), fn k -> {k, "#123456"} end),
      "font_family" => "mono-default",
      "background" => %{"image_id" => nil, "builtin" => nil, "size" => "cover", "opacity" => 0.3}
    }
  end

  defp visitor_subject, do: {:visitor, %Visitor{id: Ecto.UUID.generate()}}

  defp seed_builtin do
    system = Themes.system_user()

    {:ok, theme} =
      %Theme{}
      |> Theme.changeset(%{
        name: "builtin-#{System.unique_integer([:positive])}",
        user_id: system.id,
        payload: valid_payload(),
        published: true
      })
      |> Repo.insert()

    {:ok, reloaded} = Themes.get_theme(theme.id)
    reloaded
  end

  describe "to_wire/3" do
    test "renders the full wire shape with the owner's name as author" do
      user = user_fixture(name: "alice")
      {:ok, created} = Themes.create_theme({:user, user}, %{name: "Night", payload: valid_payload()})
      {:ok, theme} = Themes.get_theme(created.id)

      wire = Wire.to_wire(theme, {:user, user}, 3)

      assert wire.id == theme.id
      assert wire.name == "Night"
      assert wire.author == "alice"
      assert wire.built_in == false
      assert wire.published == false
      assert wire.apply_count == 0
      assert wire.in_use == 3
      assert wire.payload == valid_payload()

      assert Enum.sort(Map.keys(wire)) ==
               ~w(apply_count author built_in id in_use inserted_at mine name payload published)a
    end

    test "inserted_at is an ISO-8601 string" do
      user = user_fixture()
      {:ok, created} = Themes.create_theme({:user, user}, %{name: "N", payload: valid_payload()})
      {:ok, theme} = Themes.get_theme(created.id)

      wire = Wire.to_wire(theme, {:user, user}, 0)
      assert {:ok, %DateTime{}, _} = DateTime.from_iso8601(wire.inserted_at)
    end

    test "in_use echoes the caller-supplied active-usage count" do
      user = user_fixture()
      {:ok, created} = Themes.create_theme({:user, user}, %{name: "N", payload: valid_payload()})
      {:ok, theme} = Themes.get_theme(created.id)

      assert Wire.to_wire(theme, {:user, user}, 7).in_use == 7
      assert Wire.to_wire(theme, {:user, user}, 0).in_use == 0
    end

    test "built_in is true when the owner is the system user" do
      builtin = seed_builtin()
      viewer = user_fixture()
      assert Wire.to_wire(builtin, {:user, viewer}, 0).built_in == true
    end

    test "mine is true only when the viewer is the owner" do
      owner = user_fixture()
      other = user_fixture()
      {:ok, created} = Themes.create_theme({:user, owner}, %{name: "N", payload: valid_payload()})
      {:ok, theme} = Themes.get_theme(created.id)

      assert Wire.to_wire(theme, {:user, owner}, 0).mine == true
      assert Wire.to_wire(theme, {:user, other}, 0).mine == false
      assert Wire.to_wire(theme, visitor_subject(), 0).mine == false
    end
  end

  describe "to_wire/3 — visitor-owned (#299 author model B)" do
    test "author is the fixed guest label (never a nick) and built_in is false" do
      visitor = visitor_fixture()
      {:ok, created} = Themes.create_theme({:visitor, visitor}, %{name: "Guest", payload: valid_payload()})
      {:ok, theme} = Themes.get_theme(created.id)

      wire = Wire.to_wire(theme, {:visitor, visitor}, 0)
      assert wire.author == Wire.guest_author()
      assert wire.built_in == false
    end

    test "mine is true for the owning visitor, false for other subjects" do
      visitor = visitor_fixture()
      other = visitor_fixture()
      {:ok, created} = Themes.create_theme({:visitor, visitor}, %{name: "G", payload: valid_payload()})
      {:ok, theme} = Themes.get_theme(created.id)

      assert Wire.to_wire(theme, {:visitor, visitor}, 0).mine == true
      assert Wire.to_wire(theme, {:visitor, other}, 0).mine == false
      assert Wire.to_wire(theme, {:user, user_fixture()}, 0).mine == false
    end
  end
end
