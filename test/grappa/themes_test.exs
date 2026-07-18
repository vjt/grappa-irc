defmodule Grappa.ThemesTest do
  use Grappa.DataCase, async: true

  import Grappa.AuthFixtures
  import Grappa.UploadFixtures, only: [bytes: 1]

  alias Grappa.{Repo, Themes, Themes.Theme, Themes.TokenModel, Uploads, Visitors.Visitor}

  defp valid_payload do
    %{
      "colors" => Map.new(TokenModel.color_keys(), fn k -> {k, "#123456"} end),
      "font_family" => "mono-default",
      "background" => %{"image_id" => nil, "opacity" => 0.3}
    }
  end

  # A REAL persisted visitor — visitor-owned themes carry a visitor_id FK, so
  # an unpersisted %Visitor{} would trip the FK on insert.
  defp visitor_subject, do: {:visitor, visitor_fixture()}

  # Seed N themes owned by `visitor` directly (bypasses the create-path quota)
  # so the total-cap boundary can be exercised without the daily quota firing.
  defp seed_visitor_themes(%Visitor{id: visitor_id}, n) do
    for i <- 1..n do
      {:ok, _} =
        %Theme{}
        |> Theme.changeset(%{name: "seed-#{i}", visitor_id: visitor_id, payload: valid_payload()})
        |> Repo.insert()
    end
  end

  # A system-owned, published built-in inserted directly (bypasses the
  # user-facing create path, mirroring the seed task).
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

    theme
  end

  describe "create_theme/2" do
    test "a user persists an owned, unpublished theme" do
      user = user_fixture()
      assert {:ok, theme} = Themes.create_theme({:user, user}, %{name: "Mine", payload: valid_payload()})
      assert theme.user_id == user.id
      refute theme.published
      assert theme.apply_count == 0
    end

    test "a visitor persists an owned, unpublished theme (#299 item 8)" do
      visitor = visitor_fixture()

      assert {:ok, theme} =
               Themes.create_theme({:visitor, visitor}, %{name: "Guest", payload: valid_payload()})

      assert theme.visitor_id == visitor.id
      assert theme.user_id == nil
      refute theme.published
    end

    test "a visitor is capped at 50 total owned themes (#299 item 8)" do
      visitor = visitor_fixture()
      seed_visitor_themes(visitor, 50)

      assert {:error, :theme_cap_reached} =
               Themes.create_theme({:visitor, visitor}, %{name: "51", payload: valid_payload()})
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
      assert got.user.id == user.id
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

      ids = Enum.map(Themes.list_gallery(), & &1.id)
      assert pub.id in ids
      assert builtin.id in ids
      refute draft.id in ids
    end

    test "unpublish removes a theme from the gallery" do
      owner = user_fixture()
      {:ok, pub} = Themes.create_theme({:user, owner}, %{name: "Pub", payload: valid_payload()})
      {:ok, _} = Themes.publish_theme({:user, owner}, pub.id)
      {:ok, _} = Themes.unpublish_theme({:user, owner}, pub.id)
      refute pub.id in Enum.map(Themes.list_gallery(), & &1.id)
    end
  end

  describe "copy_theme/2" do
    test "creates an owned copy and bumps the source apply_count" do
      owner = user_fixture()
      copier = user_fixture()
      {:ok, src} = Themes.create_theme({:user, owner}, %{name: "Src", payload: valid_payload()})

      assert {:ok, copy} = Themes.copy_theme({:user, copier}, src.id)
      assert copy.user_id == copier.id
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

    test "a visitor copies a gallery theme into their own library (#299 item 8)" do
      owner = user_fixture()
      visitor = visitor_fixture()
      {:ok, src} = Themes.create_theme({:user, owner}, %{name: "Src", payload: valid_payload()})

      assert {:ok, copy} = Themes.copy_theme({:visitor, visitor}, src.id)
      assert copy.visitor_id == visitor.id
      assert copy.user_id == nil

      assert {:ok, reloaded} = Themes.get_theme(src.id)
      assert reloaded.apply_count == 1
    end

    test "a visitor copy is capped at 50 total owned themes (#299 item 8)" do
      owner = user_fixture()
      visitor = visitor_fixture()
      {:ok, src} = Themes.create_theme({:user, owner}, %{name: "Src", payload: valid_payload()})
      seed_visitor_themes(visitor, 50)

      assert {:error, :theme_cap_reached} = Themes.copy_theme({:visitor, visitor}, src.id)
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
      ids = Enum.map(Themes.list_owned({:user, me}), & &1.id)
      assert ids == [mine.id]
    end

    test "a visitor's owned list returns only their themes (#299 item 8)" do
      visitor = visitor_fixture()
      other = user_fixture()
      {:ok, mine} = Themes.create_theme({:visitor, visitor}, %{name: "Mine", payload: valid_payload()})
      {:ok, _} = Themes.create_theme({:user, other}, %{name: "Theirs", payload: valid_payload()})

      ids = Enum.map(Themes.list_owned({:visitor, visitor}), & &1.id)
      assert ids == [mine.id]
    end
  end

  describe "visitor authz (#299 item 8)" do
    test "a visitor can edit their own theme" do
      visitor = visitor_fixture()
      {:ok, theme} = Themes.create_theme({:visitor, visitor}, %{name: "A", payload: valid_payload()})
      assert {:ok, %{name: "B"}} = Themes.update_theme({:visitor, visitor}, theme.id, %{name: "B"})
    end

    test "a visitor can delete their own theme" do
      visitor = visitor_fixture()
      {:ok, theme} = Themes.create_theme({:visitor, visitor}, %{name: "A", payload: valid_payload()})
      assert :ok = Themes.delete_theme({:visitor, visitor}, theme.id)
      assert {:error, :not_found} = Themes.get_theme(theme.id)
    end

    test "a visitor can publish their own theme into the gallery" do
      visitor = visitor_fixture()
      {:ok, theme} = Themes.create_theme({:visitor, visitor}, %{name: "A", payload: valid_payload()})
      assert {:ok, %{published: true}} = Themes.publish_theme({:visitor, visitor}, theme.id)
      assert theme.id in Enum.map(Themes.list_gallery(), & &1.id)
    end

    test "a visitor cannot edit another visitor's theme" do
      owner = visitor_fixture()
      other = visitor_fixture()
      {:ok, theme} = Themes.create_theme({:visitor, owner}, %{name: "A", payload: valid_payload()})
      assert {:error, :forbidden} = Themes.update_theme({:visitor, other}, theme.id, %{name: "B"})
    end

    test "a visitor cannot edit a user's theme" do
      owner = user_fixture()
      visitor = visitor_fixture()
      {:ok, theme} = Themes.create_theme({:user, owner}, %{name: "A", payload: valid_payload()})
      assert {:error, :forbidden} = Themes.update_theme({:visitor, visitor}, theme.id, %{name: "B"})
    end
  end

  describe "rehome_visitor_published_to_system/1 (#299 reaping)" do
    test "re-homes a reaped visitor's PUBLISHED themes to the system user" do
      visitor = visitor_fixture()
      {:ok, pub} = Themes.create_theme({:visitor, visitor}, %{name: "Pub", payload: valid_payload()})
      {:ok, _} = Themes.publish_theme({:visitor, visitor}, pub.id)
      {:ok, priv} = Themes.create_theme({:visitor, visitor}, %{name: "Priv", payload: valid_payload()})

      assert Themes.rehome_visitor_published_to_system(visitor.id) == 1

      {:ok, rehomed} = Themes.get_theme(pub.id)
      assert rehomed.user_id == Themes.system_user().id
      assert rehomed.visitor_id == nil

      # The private draft is untouched (still the visitor's) — it dies later
      # via the visitor_id ON DELETE CASCADE, not here.
      {:ok, still_priv} = Themes.get_theme(priv.id)
      assert still_priv.visitor_id == visitor.id
    end

    test "renames on collision with an existing system theme name" do
      visitor = visitor_fixture()
      builtin = seed_builtin()
      {:ok, clash} = Themes.create_theme({:visitor, visitor}, %{name: builtin.name, payload: valid_payload()})
      {:ok, _} = Themes.publish_theme({:visitor, visitor}, clash.id)

      assert Themes.rehome_visitor_published_to_system(visitor.id) == 1

      {:ok, rehomed} = Themes.get_theme(clash.id)
      assert rehomed.user_id == Themes.system_user().id
      assert rehomed.name != builtin.name
    end

    test "returns 0 when the visitor published nothing" do
      visitor = visitor_fixture()
      {:ok, _} = Themes.create_theme({:visitor, visitor}, %{name: "Priv", payload: valid_payload()})
      assert Themes.rehome_visitor_published_to_system(visitor.id) == 0
    end
  end

  describe "list_unpublished_builtins/1 (#299 — admin un-stranding)" do
    test "an admin sees system-owned UNPUBLISHED built-ins, not published ones" do
      admin = user_fixture(is_admin: true)
      published_builtin = seed_builtin()
      stranded = seed_builtin()
      {:ok, _} = Themes.unpublish_theme({:user, admin}, stranded.id)

      ids = Enum.map(Themes.list_unpublished_builtins({:user, admin}), & &1.id)
      assert stranded.id in ids
      refute published_builtin.id in ids
    end

    test "excludes a user's own unpublished draft (not system-owned — rides list_owned)" do
      admin = user_fixture(is_admin: true)
      owner = user_fixture()
      {:ok, draft} = Themes.create_theme({:user, owner}, %{name: "Draft", payload: valid_payload()})

      refute draft.id in Enum.map(Themes.list_unpublished_builtins({:user, admin}), & &1.id)
    end

    test "preloads the owner so the wire's author/built_in resolve" do
      admin = user_fixture(is_admin: true)
      stranded = seed_builtin()
      {:ok, _} = Themes.unpublish_theme({:user, admin}, stranded.id)

      [theme] = Themes.list_unpublished_builtins({:user, admin})
      assert theme.user.name == Themes.system_user_name()
    end

    test "a non-admin user gets an empty list (own drafts ride list_owned)" do
      admin = user_fixture(is_admin: true)
      user = user_fixture()
      stranded = seed_builtin()
      {:ok, _} = Themes.unpublish_theme({:user, admin}, stranded.id)

      assert Themes.list_unpublished_builtins({:user, user}) == []
    end

    test "a visitor gets an empty list" do
      assert Themes.list_unpublished_builtins(visitor_subject()) == []
    end
  end

  describe "get_active_theme/1 + set_active_theme/2" do
    test "get_active_theme returns nil when the subject has no active theme" do
      user = user_fixture()
      assert Themes.get_active_theme({:user, user.id}) == nil
    end

    test "set_active_theme persists the pointer and get resolves it" do
      user = user_fixture()
      {:ok, theme} = Themes.create_theme({:user, user}, %{name: "Mine", payload: valid_payload()})

      assert {:ok, set} = Themes.set_active_theme({:user, user.id}, theme.id)
      assert set.id == theme.id
      assert Themes.get_active_theme({:user, user.id}).id == theme.id
    end

    test "set_active_theme returns :not_found for a missing id (no pointer stored)" do
      user = user_fixture()
      assert {:error, :not_found} = Themes.set_active_theme({:user, user.id}, 9_999_999)
      assert Themes.get_active_theme({:user, user.id}) == nil
    end

    test "get_active_theme returns nil when the stored pointer dangles" do
      user = user_fixture()
      {:ok, theme} = Themes.create_theme({:user, user}, %{name: "Mine", payload: valid_payload()})
      {:ok, _} = Themes.set_active_theme({:user, user.id}, theme.id)
      :ok = Themes.delete_theme({:user, user}, theme.id)

      assert Themes.get_active_theme({:user, user.id}) == nil
    end
  end

  describe "store_background/2" do
    test "delegates to the background pipeline and returns an uploads slug" do
      user = user_fixture()
      path = Path.join(System.tmp_dir!(), "themetest-" <> Uploads.mint_slug())
      File.write!(path, bytes(:gps_png))
      on_exit(fn -> File.rm(path) end)
      upload = %Plug.Upload{path: path, content_type: "image/png", filename: "bg.png"}

      assert {:ok, slug} = Themes.store_background({:user, user.id}, {:upload, upload})
      assert slug =~ ~r/\A[a-z2-7]{26}\z/
    end

    test "propagates a non-raster rejection" do
      user = user_fixture()
      path = Path.join(System.tmp_dir!(), "themetest-" <> Uploads.mint_slug())
      File.write!(path, "hi")
      on_exit(fn -> File.rm(path) end)
      upload = %Plug.Upload{path: path, content_type: "text/plain", filename: "x.txt"}

      assert {:error, :not_raster} = Themes.store_background({:user, user.id}, {:upload, upload})
    end
  end

  test "system_user/0 resolves the seeded reserved user" do
    assert Themes.system_user().name == Themes.system_user_name()
  end
end
