defmodule GrappaWeb.Admin.TestResetSubjectControllerTest do
  @moduledoc """
  Auth gate + happy-path + error-shape coverage for
  `POST /admin/test/reset-subject` (E2E-ROBUSTNESS bucket D, T9).

  The seeded user has NO `network_credentials` rows so
  `SubjectReset.reset!/1`'s respawn loop is empty — no real IRC
  fake needed for the 204 path. Per-credential reconnect-timeout
  + reconnect-failed surfaces (504, 500) are covered by the
  `SubjectReset` unit test; here we just verify the controller's
  status-code mapping for the shapes the empty-credential path
  exercises (200 → 204, missing user → 404, missing param → 422,
  auth → 401/403).

  ## Test isolation

  `async: false` because `SubjectReset.reset!/1` reaches into
  singleton ETS tables (NetworkCircuit, WSPresence) and the
  singleton `Grappa.SessionRegistry` — concurrent tests would
  cross-contaminate.
  """
  use GrappaWeb.ConnCase, async: false

  import Grappa.AuthFixtures

  setup do
    suffix = System.unique_integer([:positive])
    admin = user_fixture(name: "admin-vjt-#{suffix}", is_admin: true)
    user = user_fixture(name: "vjt-#{suffix}")

    admin_session = session_fixture(admin)
    user_session = session_fixture(user)

    %{
      admin_token: admin_session.id,
      user_token: user_session.id,
      user: user,
      admin: admin
    }
  end

  describe "POST /admin/test/reset-subject" do
    test "returns 204 with admin token + valid user_name", %{conn: conn, admin_token: tok, user: user} do
      conn =
        conn
        |> put_req_header("authorization", "Bearer " <> tok)
        |> put_req_header("content-type", "application/json")
        |> post("/admin/test/reset-subject", %{"user_name" => user.name})

      assert response(conn, 204) == ""
    end

    test "returns 403 with non-admin token", %{conn: conn, user_token: tok, user: user} do
      conn =
        conn
        |> put_req_header("authorization", "Bearer " <> tok)
        |> put_req_header("content-type", "application/json")
        |> post("/admin/test/reset-subject", %{"user_name" => user.name})

      assert json_response(conn, 403)
    end

    test "returns 401 without bearer", %{conn: conn, user: user} do
      conn = post(conn, "/admin/test/reset-subject", %{"user_name" => user.name})
      assert json_response(conn, 401)
    end

    test "returns 404 for unknown user_name", %{conn: conn, admin_token: tok} do
      ghost = "ghost-nonexistent-#{System.unique_integer([:positive])}"

      conn =
        conn
        |> put_req_header("authorization", "Bearer " <> tok)
        |> put_req_header("content-type", "application/json")
        |> post("/admin/test/reset-subject", %{"user_name" => ghost})

      assert %{"error" => "user_not_found"} = json_response(conn, 404)
    end

    test "returns 422 when user_name missing", %{conn: conn, admin_token: tok} do
      conn =
        conn
        |> put_req_header("authorization", "Bearer " <> tok)
        |> put_req_header("content-type", "application/json")
        |> post("/admin/test/reset-subject", %{})

      assert %{"error" => "user_name_required"} = json_response(conn, 422)
    end
  end
end
