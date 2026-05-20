defmodule GrappaWeb.Admin.SettingsControllerTest do
  use GrappaWeb.ConnCase, async: false

  import Grappa.AuthFixtures

  alias Grappa.ServerSettings

  describe "GET /admin/settings — gate" do
    test "401 without bearer", %{conn: conn} do
      conn = get(conn, "/admin/settings")
      assert json_response(conn, 401) == %{"error" => "unauthorized"}
    end

    test "403 for non-admin user", %{conn: conn} do
      {_, session} = user_and_session([])

      conn =
        conn
        |> put_bearer(session.id)
        |> get("/admin/settings")

      assert json_response(conn, 403) == %{"error" => "forbidden"}
    end

    test "403 for visitor", %{conn: conn} do
      {_, session} = visitor_and_session([])

      conn =
        conn
        |> put_bearer(session.id)
        |> get("/admin/settings")

      assert json_response(conn, 403) == %{"error" => "forbidden"}
    end
  end

  describe "GET /admin/settings — happy" do
    setup do
      {admin, session} = user_and_session(is_admin: true)
      %{admin: admin, session: session}
    end

    test "returns current settings", %{conn: conn, session: session} do
      conn = conn |> put_bearer(session.id) |> get("/admin/settings")
      assert %{"settings" => %{"upload" => upload}} = json_response(conn, 200)
      assert upload["active_host"] == "embedded"
      assert upload["per_file_cap_bytes"] == 10 * 1024 * 1024
      assert upload["global_cap_bytes"] == 10 * 1024 * 1024 * 1024
    end
  end

  describe "PUT /admin/settings — happy" do
    setup do
      {admin, session} = user_and_session(is_admin: true)
      %{admin: admin, session: session}
    end

    test "updates upload.active_host", %{conn: conn, session: session} do
      conn =
        conn
        |> put_bearer(session.id)
        |> put("/admin/settings", %{"upload" => %{"active_host" => "litterbox"}})

      assert %{"settings" => %{"upload" => %{"active_host" => "litterbox"}}} =
               json_response(conn, 200)

      assert ServerSettings.get_upload_active_host() == :litterbox
    end

    test "updates per_file_cap_bytes", %{conn: conn, session: session} do
      conn =
        conn
        |> put_bearer(session.id)
        |> put("/admin/settings", %{"upload" => %{"per_file_cap_bytes" => 5_000_000}})

      assert %{"settings" => %{"upload" => %{"per_file_cap_bytes" => 5_000_000}}} =
               json_response(conn, 200)
    end

    test "updates global_cap_bytes", %{conn: conn, session: session} do
      conn =
        conn
        |> put_bearer(session.id)
        |> put("/admin/settings", %{"upload" => %{"global_cap_bytes" => 999_999}})

      assert %{"settings" => %{"upload" => %{"global_cap_bytes" => 999_999}}} =
               json_response(conn, 200)
    end

    test "ignores empty body", %{conn: conn, session: session} do
      conn = conn |> put_bearer(session.id) |> put("/admin/settings", %{})
      assert %{"settings" => _} = json_response(conn, 200)
    end

    test "ignores unknown keys", %{conn: conn, session: session} do
      conn =
        conn
        |> put_bearer(session.id)
        |> put("/admin/settings", %{"upload" => %{"unknown_key" => "foo"}})

      assert %{"settings" => _} = json_response(conn, 200)
    end
  end

  describe "PUT /admin/settings — validation" do
    setup do
      {_, session} = user_and_session(is_admin: true)
      %{session: session}
    end

    test "422 invalid_setting for unknown active_host", %{conn: conn, session: session} do
      conn =
        conn
        |> put_bearer(session.id)
        |> put("/admin/settings", %{"upload" => %{"active_host" => "imgbb"}})

      assert json_response(conn, 422) == %{
               "error" => "invalid_setting",
               "field" => "upload.active_host"
             }
    end

    test "422 invalid_setting for non-positive per_file_cap_bytes", %{conn: conn, session: session} do
      conn =
        conn
        |> put_bearer(session.id)
        |> put("/admin/settings", %{"upload" => %{"per_file_cap_bytes" => 0}})

      assert json_response(conn, 422) == %{
               "error" => "invalid_setting",
               "field" => "upload.per_file_cap_bytes"
             }
    end

    test "422 invalid_setting for string per_file_cap_bytes", %{conn: conn, session: session} do
      conn =
        conn
        |> put_bearer(session.id)
        |> put("/admin/settings", %{"upload" => %{"per_file_cap_bytes" => "5000000"}})

      assert json_response(conn, 422) == %{
               "error" => "invalid_setting",
               "field" => "upload.per_file_cap_bytes"
             }
    end
  end
end
