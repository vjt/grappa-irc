defmodule GrappaWeb.MeThemeControllerTest do
  @moduledoc """
  Active-theme surface (#75 fork-1) — server-persisted per-subject pointer.

    * `GET /me/theme` — resolved theme wire, or `null` when none / dangling.
    * `PUT /me/theme` — set the active theme id (404 on an unknown id).
  """
  use GrappaWeb.ConnCase, async: true

  import Grappa.AuthFixtures

  alias Grappa.Themes
  alias Grappa.Themes.TokenModel

  defp valid_payload do
    %{
      "colors" => Map.new(TokenModel.color_keys(), fn k -> {k, "#123456"} end),
      "font_family" => "mono-default",
      "background" => %{"image_id" => nil, "builtin" => nil, "size" => "cover", "opacity" => 0.3}
    }
  end

  setup %{conn: conn} do
    {user, session} = user_and_session()
    {:ok, conn: put_bearer(conn, session.id), user: user}
  end

  test "401 without a bearer", %{} do
    assert json_response(get(build_conn(), "/me/theme"), 401) == %{"error" => "unauthorized"}
  end

  test "GET returns null when no active theme is set", %{conn: conn} do
    assert json_response(get(conn, "/me/theme"), 200) == nil
  end

  test "PUT sets the active theme, GET resolves it", %{conn: conn, user: user} do
    {:ok, theme} = Themes.create_theme({:user, user}, %{name: "Mine", payload: valid_payload()})

    put_body = json_response(put(conn, "/me/theme", %{"id" => theme.id}), 200)
    assert put_body["id"] == theme.id

    get_body = json_response(get(conn, "/me/theme"), 200)
    assert get_body["id"] == theme.id
    assert get_body["payload"] == valid_payload()
  end

  test "PUT with an unknown id → 404", %{conn: conn} do
    assert json_response(put(conn, "/me/theme", %{"id" => 9_999_999}), 404) ==
             %{"error" => "not_found"}
  end
end
