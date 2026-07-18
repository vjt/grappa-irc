defmodule GrappaWeb.ThemesControllerTest do
  @moduledoc """
  REST surface for `Grappa.Themes` (#75). All routes behind `[:api, :authn]`.

  Coverage: gallery listing (published + built-ins only), owned library,
  single-theme read (public by id, 404 on miss), create (201, rate-limit 429,
  invalid-payload 422), owner/admin authz on update+delete, publish/unpublish,
  copy (201 + apply_count bump), background upload (re-hosted slug), and the
  401 auth gate.
  """
  use GrappaWeb.ConnCase, async: true

  import Grappa.AuthFixtures
  import Grappa.UploadFixtures, only: [bytes: 1]

  alias Grappa.{Repo, Themes, Themes.Theme, Themes.TokenModel, Uploads}

  defp valid_payload do
    %{
      "colors" => Map.new(TokenModel.color_keys(), fn k -> {k, "#123456"} end),
      "font_family" => "mono-default",
      "background" => %{"image_id" => nil, "builtin" => nil, "size" => "cover", "opacity" => 0.3}
    }
  end

  # A system-owned, published built-in inserted directly (mirrors the seed task).
  defp seed_builtin do
    {:ok, theme} =
      %Theme{}
      |> Theme.changeset(%{
        name: "builtin-#{System.unique_integer([:positive])}",
        user_id: Themes.system_user().id,
        payload: valid_payload(),
        published: true
      })
      |> Repo.insert()

    theme
  end

  describe "auth gate" do
    test "401 without a bearer", %{conn: conn} do
      assert json_response(get(conn, "/themes"), 401) == %{"error" => "unauthorized"}
    end
  end

  describe "GET /themes (gallery)" do
    setup %{conn: conn} do
      {user, session} = user_and_session()
      {:ok, conn: put_bearer(conn, session.id), user: user}
    end

    test "lists published themes, excludes drafts", %{conn: conn, user: user} do
      {:ok, draft} = Themes.create_theme({:user, user}, %{name: "Draft", payload: valid_payload()})
      {:ok, pub} = Themes.create_theme({:user, user}, %{name: "Pub", payload: valid_payload()})
      {:ok, _} = Themes.publish_theme({:user, user}, pub.id)

      assert %{"themes" => themes} = json_response(get(conn, "/themes"), 200)
      ids = Enum.map(themes, & &1["id"])
      assert pub.id in ids
      refute draft.id in ids
    end
  end

  describe "GET /me/themes (owned library)" do
    setup %{conn: conn} do
      {user, session} = user_and_session()
      {:ok, conn: put_bearer(conn, session.id), user: user}
    end

    test "returns only the caller's themes with mine=true", %{conn: conn, user: user} do
      other = user_fixture()
      {:ok, mine} = Themes.create_theme({:user, user}, %{name: "Mine", payload: valid_payload()})
      {:ok, _} = Themes.create_theme({:user, other}, %{name: "Theirs", payload: valid_payload()})

      assert %{"themes" => [theme]} = json_response(get(conn, "/me/themes"), 200)
      assert theme["id"] == mine.id
      assert theme["mine"] == true
    end
  end

  describe "GET /themes/unpublished (#299 admin un-stranding)" do
    test "an admin sees stranded (unpublished) system built-ins", %{conn: conn} do
      {admin, session} = user_and_session(is_admin: true)
      conn = put_bearer(conn, session.id)
      stranded = seed_builtin()
      {:ok, _} = Themes.unpublish_theme({:user, admin}, stranded.id)

      assert %{"themes" => [theme]} = json_response(get(conn, "/themes/unpublished"), 200)
      assert theme["id"] == stranded.id
      assert theme["published"] == false
      assert theme["built_in"] == true
    end

    test "a non-admin user gets an empty list", %{conn: conn} do
      {_, session} = user_and_session()
      conn = put_bearer(conn, session.id)
      {admin, _} = user_and_session(is_admin: true)
      stranded = seed_builtin()
      {:ok, _} = Themes.unpublish_theme({:user, admin}, stranded.id)

      assert %{"themes" => []} = json_response(get(conn, "/themes/unpublished"), 200)
    end
  end

  describe "GET /themes/:id" do
    setup %{conn: conn} do
      {user, session} = user_and_session()
      {:ok, conn: put_bearer(conn, session.id), user: user}
    end

    test "returns the theme wire shape", %{conn: conn, user: user} do
      {:ok, theme} = Themes.create_theme({:user, user}, %{name: "N", payload: valid_payload()})
      body = json_response(get(conn, "/themes/#{theme.id}"), 200)
      assert body["id"] == theme.id
      assert body["author"] == user.name
      assert body["payload"] == valid_payload()
    end

    test "404 for a missing id", %{conn: conn} do
      assert json_response(get(conn, "/themes/9999999"), 404) == %{"error" => "not_found"}
    end
  end

  describe "POST /themes (create)" do
    setup %{conn: conn} do
      {user, session} = user_and_session()
      {:ok, conn: put_bearer(conn, session.id), user: user}
    end

    test "201 persists an owned theme", %{conn: conn, user: user} do
      conn = post(conn, "/themes", %{"name" => "New", "payload" => valid_payload()})
      body = json_response(conn, 201)
      assert body["name"] == "New"
      assert body["author"] == user.name
      assert body["mine"] == true
    end

    test "422 on an invalid payload", %{conn: conn} do
      bad = put_in(valid_payload(), ["colors", "bg"], "not-a-color")
      conn = post(conn, "/themes", %{"name" => "X", "payload" => bad})
      assert %{"error" => "validation_failed"} = json_response(conn, 422)
    end

    test "429 once the daily quota is exhausted", %{conn: conn} do
      for n <- 1..5 do
        assert json_response(
                 post(conn, "/themes", %{"name" => "T#{n}", "payload" => valid_payload()}),
                 201
               )
      end

      conn = post(conn, "/themes", %{"name" => "T6", "payload" => valid_payload()})
      assert json_response(conn, 429) == %{"error" => "rate_limited"}
    end
  end

  describe "PATCH /themes/:id + DELETE /themes/:id (authz)" do
    setup %{conn: conn} do
      {user, session} = user_and_session()
      {:ok, conn: put_bearer(conn, session.id), user: user}
    end

    test "owner edits their own theme", %{conn: conn, user: user} do
      {:ok, theme} = Themes.create_theme({:user, user}, %{name: "A", payload: valid_payload()})
      body = json_response(patch(conn, "/themes/#{theme.id}", %{"name" => "B"}), 200)
      assert body["name"] == "B"
    end

    test "403 for a non-owner", %{conn: conn} do
      owner = user_fixture()
      {:ok, theme} = Themes.create_theme({:user, owner}, %{name: "A", payload: valid_payload()})

      assert json_response(patch(conn, "/themes/#{theme.id}", %{"name" => "B"}), 403) ==
               %{"error" => "forbidden"}
    end

    test "owner deletes their own theme → 204", %{conn: conn, user: user} do
      {:ok, theme} = Themes.create_theme({:user, user}, %{name: "A", payload: valid_payload()})
      assert response(delete(conn, "/themes/#{theme.id}"), 204)
      assert {:error, :not_found} = Themes.get_theme(theme.id)
    end
  end

  describe "publish / unpublish / copy" do
    setup %{conn: conn} do
      {user, session} = user_and_session()
      {:ok, conn: put_bearer(conn, session.id), user: user}
    end

    test "publish then unpublish toggles gallery membership", %{conn: conn, user: user} do
      {:ok, theme} = Themes.create_theme({:user, user}, %{name: "P", payload: valid_payload()})

      assert json_response(post(conn, "/themes/#{theme.id}/publish"), 200)["published"] == true
      assert json_response(post(conn, "/themes/#{theme.id}/unpublish"), 200)["published"] == false
    end

    test "copy creates an owned copy and bumps the source apply_count", %{conn: conn} do
      owner = user_fixture()
      {:ok, src} = Themes.create_theme({:user, owner}, %{name: "Src", payload: valid_payload()})

      body = json_response(post(conn, "/themes/#{src.id}/copy"), 201)
      assert body["mine"] == true
      assert body["id"] != src.id

      assert {:ok, reloaded} = Themes.get_theme(src.id)
      assert reloaded.apply_count == 1
    end
  end

  describe "POST /themes/background" do
    setup %{conn: conn} do
      {_, session} = user_and_session()
      {:ok, conn: put_bearer(conn, session.id)}
    end

    test "re-hosts an uploaded raster and returns the slug", %{conn: conn} do
      path = Path.join(System.tmp_dir!(), "bgctl-" <> Uploads.mint_slug())
      File.write!(path, bytes(:gps_png))
      on_exit(fn -> File.rm(path) end)
      upload = %Plug.Upload{path: path, content_type: "image/png", filename: "bg.png"}

      body = json_response(post(conn, "/themes/background", %{"file" => upload}), 200)
      assert body["image_id"] =~ ~r/\A[a-z2-7]{26}\z/
    end

    test "415 on a non-raster upload", %{conn: conn} do
      path = Path.join(System.tmp_dir!(), "bgctl-" <> Uploads.mint_slug())
      File.write!(path, "nope")
      on_exit(fn -> File.rm(path) end)
      upload = %Plug.Upload{path: path, content_type: "text/plain", filename: "x.txt"}

      assert json_response(post(conn, "/themes/background", %{"file" => upload}), 415) ==
               %{"error" => "not_raster"}
    end
  end

  # #294 — the built-in background catalog the picker consumes. Server-owned so
  # cic never hard-codes the closed set (would drift from the sanitizer).
  describe "GET /themes/backgrounds (built-in catalog)" do
    setup %{conn: conn} do
      {user, session} = user_and_session()
      {:ok, conn: put_bearer(conn, session.id), user: user}
    end

    test "returns the closed built-in background catalog", %{conn: conn} do
      assert %{"backgrounds" => bgs} = json_response(get(conn, "/themes/backgrounds"), 200)
      assert length(bgs) == length(Themes.builtin_backgrounds())

      first = hd(bgs)
      assert Enum.sort(Map.keys(first)) == ~w(key name path variant)
      assert first["variant"] in ["dark", "light"]
      assert first["path"] == "/backgrounds/#{first["key"]}.webp"
    end

    test "does NOT collide with GET /themes/:id (literal route wins)", %{conn: conn} do
      # If the /themes/:id route matched first, "backgrounds" → 404 not_found.
      assert %{"backgrounds" => _} = json_response(get(conn, "/themes/backgrounds"), 200)
    end

    test "401 without a bearer" do
      assert json_response(get(build_conn(), "/themes/backgrounds"), 401) ==
               %{"error" => "unauthorized"}
    end
  end
end
