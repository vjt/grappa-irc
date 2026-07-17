defmodule Grappa.ThemesTest do
  use Grappa.DataCase, async: true

  import Grappa.AuthFixtures

  alias Grappa.Repo
  alias Grappa.Themes
  alias Grappa.Themes.{Theme, TokenModel}
  alias Grappa.Visitors.Visitor

  defp valid_payload do
    %{
      "colors" => Map.new(TokenModel.color_keys(), fn k -> {k, "#123456"} end),
      "font_family" => "mono-default",
      "background" => %{"image_id" => nil, "opacity" => 0.3}
    }
  end

  defp visitor_subject, do: {:visitor, %Visitor{id: Ecto.UUID.generate()}}

  # A system-owned, published built-in inserted directly (bypasses the
  # user-facing create path, mirroring the seed task).
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

    theme
  end

  describe "create_theme/2" do
    test "a user persists an owned, unpublished theme" do
      user = user_fixture()
      assert {:ok, theme} = Themes.create_theme({:user, user}, %{name: "Mine", payload: valid_payload()})
      assert theme.owner_id == user.id
      refute theme.published
      assert theme.apply_count == 0
    end

    test "a visitor is forbidden" do
      assert {:error, :forbidden} =
               Themes.create_theme(visitor_subject(), %{name: "x", payload: valid_payload()})
    end

    test "an invalid payload returns a changeset error and does NOT consume quota" do
      user = user_fixture()
      bad = put_in(valid_payload(), ["colors", "bg"], "not-a-color")
      assert {:error, %Ecto.Changeset{}} = Themes.create_theme({:user, user}, %{name: "X", payload: bad})
      # quota untouched: a valid create still succeeds right after
      assert {:ok, _} = Themes.create_theme({:user, user}, %{name: "Y", payload: valid_payload()})
    end

    test "enforces the ~5/day creation quota" do
      user = user_fixture()

      for n <- 1..5 do
        assert {:ok, _} = Themes.create_theme({:user, user}, %{name: "T#{n}", payload: valid_payload()})
      end

      assert {:error, :rate_limited} =
               Themes.create_theme({:user, user}, %{name: "T6", payload: valid_payload()})
    end
  end

  describe "get_theme/1" do
    test "returns the theme with its owner preloaded" do
      user = user_fixture()
      {:ok, theme} = Themes.create_theme({:user, user}, %{name: "N", payload: valid_payload()})
      assert {:ok, got} = Themes.get_theme(theme.id)
      assert got.id == theme.id
      assert got.owner.id == user.id
    end

    test "returns :not_found for a missing id" do
      assert {:error, :not_found} = Themes.get_theme(9_999_999)
    end
  end

  describe "update_theme/3" do
    test "the owner can edit their own theme" do
      user = user_fixture()
      {:ok, theme} = Themes.create_theme({:user, user}, %{name: "A", payload: valid_payload()})
      assert {:ok, %{name: "B"}} = Themes.update_theme({:user, user}, theme.id, %{name: "B"})
    end

    test "a non-owner non-admin is forbidden" do
      owner = user_fixture()
      other = user_fixture()
      {:ok, theme} = Themes.create_theme({:user, owner}, %{name: "A", payload: valid_payload()})
      assert {:error, :forbidden} = Themes.update_theme({:user, other}, theme.id, %{name: "B"})
    end

    test "an admin can edit anyone's theme (moderation)" do
      owner = user_fixture()
      admin = user_fixture(is_admin: true)
      {:ok, theme} = Themes.create_theme({:user, owner}, %{name: "A", payload: valid_payload()})
      assert {:ok, %{name: "B"}} = Themes.update_theme({:user, admin}, theme.id, %{name: "B"})
    end

    test "a built-in is read-only for a non-admin" do
      builtin = seed_builtin()
      user = user_fixture()
      assert {:error, :forbidden} = Themes.update_theme({:user, user}, builtin.id, %{name: "hax"})
    end

    test "an admin can edit a built-in (moderation)" do
      builtin = seed_builtin()
      admin = user_fixture(is_admin: true)
      assert {:ok, %{name: "curated"}} = Themes.update_theme({:user, admin}, builtin.id, %{name: "curated"})
    end
  end

  describe "delete_theme/2" do
    test "the owner deletes their own theme" do
      user = user_fixture()
      {:ok, theme} = Themes.create_theme({:user, user}, %{name: "A", payload: valid_payload()})
      assert :ok = Themes.delete_theme({:user, user}, theme.id)
      assert {:error, :not_found} = Themes.get_theme(theme.id)
    end

    test "a non-owner non-admin is forbidden" do
      owner = user_fixture()
      other = user_fixture()
      {:ok, theme} = Themes.create_theme({:user, owner}, %{name: "A", payload: valid_payload()})
      assert {:error, :forbidden} = Themes.delete_theme({:user, other}, theme.id)
    end
  end

  describe "publish_theme/2 + list_gallery/0" do
    test "gallery lists published + built-ins, excludes private drafts" do
      owner = user_fixture()
      {:ok, draft} = Themes.create_theme({:user, owner}, %{name: "Draft", payload: valid_payload()})
      {:ok, pub} = Themes.create_theme({:user, owner}, %{name: "Pub", payload: valid_payload()})
      {:ok, _} = Themes.publish_theme({:user, owner}, pub.id)
      builtin = seed_builtin()

      ids = Themes.list_gallery() |> Enum.map(& &1.id)
      assert pub.id in ids
      assert builtin.id in ids
      refute draft.id in ids
    end

    test "unpublish removes a theme from the gallery" do
      owner = user_fixture()
      {:ok, pub} = Themes.create_theme({:user, owner}, %{name: "Pub", payload: valid_payload()})
      {:ok, _} = Themes.publish_theme({:user, owner}, pub.id)
      {:ok, _} = Themes.unpublish_theme({:user, owner}, pub.id)
      refute pub.id in (Themes.list_gallery() |> Enum.map(& &1.id))
    end
  end

  describe "copy_theme/2" do
    test "creates an owned copy and bumps the source apply_count" do
      owner = user_fixture()
      copier = user_fixture()
      {:ok, src} = Themes.create_theme({:user, owner}, %{name: "Src", payload: valid_payload()})

      assert {:ok, copy} = Themes.copy_theme({:user, copier}, src.id)
      assert copy.owner_id == copier.id
      assert copy.id != src.id

      assert {:ok, reloaded} = Themes.get_theme(src.id)
      assert reloaded.apply_count == 1
    end

    test "copying the same source twice dedups the name" do
      owner = user_fixture()
      copier = user_fixture()
      {:ok, src} = Themes.create_theme({:user, owner}, %{name: "Src", payload: valid_payload()})
      assert {:ok, first} = Themes.copy_theme({:user, copier}, src.id)
      assert {:ok, second} = Themes.copy_theme({:user, copier}, src.id)
      assert first.name != second.name
    end

    test "a visitor cannot copy" do
      owner = user_fixture()
      {:ok, src} = Themes.create_theme({:user, owner}, %{name: "Src", payload: valid_payload()})
      assert {:error, :forbidden} = Themes.copy_theme(visitor_subject(), src.id)
    end

    test "copying a missing theme is not_found" do
      copier = user_fixture()
      assert {:error, :not_found} = Themes.copy_theme({:user, copier}, 9_999_999)
    end
  end

  describe "list_owned/1" do
    test "returns only the caller's themes" do
      me = user_fixture()
      other = user_fixture()
      {:ok, mine} = Themes.create_theme({:user, me}, %{name: "Mine", payload: valid_payload()})
      {:ok, _} = Themes.create_theme({:user, other}, %{name: "Theirs", payload: valid_payload()})
      ids = Themes.list_owned({:user, me}) |> Enum.map(& &1.id)
      assert ids == [mine.id]
    end

    test "a visitor owns nothing" do
      assert Themes.list_owned(visitor_subject()) == []
    end
  end

  test "system_user/0 resolves the seeded reserved user" do
    assert Themes.system_user().name == Themes.system_user_name()
  end
end
