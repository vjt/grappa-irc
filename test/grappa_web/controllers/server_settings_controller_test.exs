defmodule GrappaWeb.ServerSettingsControllerTest do
  use GrappaWeb.ConnCase, async: false

  import Grappa.AuthFixtures

  alias Grappa.ServerSettings

  describe "GET /api/server-settings — gate" do
    test "401 without bearer", %{conn: conn} do
      conn = get(conn, "/api/server-settings")
      assert json_response(conn, 401) == %{"error" => "unauthorized"}
    end
  end

  describe "GET /api/server-settings — happy" do
    test "user gets the upload view", %{conn: conn} do
      {_, session} = user_and_session([])
      conn = conn |> put_bearer(session.id) |> get("/api/server-settings")
      assert %{"upload" => upload} = json_response(conn, 200)
      assert upload["active_host"] == "embedded"
      assert upload["image_per_file_cap_bytes"] == 10 * 1024 * 1024
      assert upload["video_per_file_cap_bytes"] == 50 * 1024 * 1024
      assert upload["document_per_file_cap_bytes"] == 10 * 1024 * 1024
      assert upload["audio_per_file_cap_bytes"] == 25 * 1024 * 1024
      assert upload["global_cap_bytes"] == 10 * 1024 * 1024 * 1024
    end

    test "visitor gets the upload view too (parity)", %{conn: conn} do
      {_, session} = visitor_and_session([])
      conn = conn |> put_bearer(session.id) |> get("/api/server-settings")
      assert %{"upload" => _} = json_response(conn, 200)
    end

    test "reflects current settings after a PUT", %{conn: conn} do
      :ok = ServerSettings.put_upload_active_host(:litterbox)

      {_, session} = user_and_session([])
      conn = conn |> put_bearer(session.id) |> get("/api/server-settings")
      assert %{"upload" => %{"active_host" => "litterbox"}} = json_response(conn, 200)
    end
  end
end
