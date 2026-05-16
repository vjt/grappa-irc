defmodule GrappaWeb.Admin.ReaperControllerTest do
  @moduledoc """
  `POST /admin/reaper/run` — admin-gated on-demand Reaper trigger
  (M-cluster M-5). Behind `:admin_authn`; visitor + non-admin user
  collapse to 403 upstream.

  ## Why three-class parity matrix is N/A

  Operator-facing endpoint, admin-gated. Per
  `feedback_e2e_user_class_parity_matrix`: USER-FACING IRC
  functions need the cross-class parity spec; this verb is
  operator-only and the gate is M-2's surface (covered by
  `MeControllerTest`). Same shape as other M-cluster admin tests.
  """
  use GrappaWeb.ConnCase, async: false

  import Grappa.AuthFixtures

  alias Grappa.Accounts
  alias Grappa.Visitors.Visitor

  defp admin_session do
    {user, session} = user_and_session()
    {:ok, _} = Accounts.update_admin_flags(user, %{is_admin: true})
    session
  end

  describe "POST /admin/reaper/run — auth gate" do
    test "no bearer returns 401", %{conn: conn} do
      conn = post(conn, "/admin/reaper/run")
      assert json_response(conn, 401) == %{"error" => "unauthorized"}
    end

    test "visitor subject returns 403", %{conn: conn} do
      {_, session} = visitor_and_session()
      conn = conn |> put_bearer(session.id) |> post("/admin/reaper/run")
      assert json_response(conn, 403) == %{"error" => "forbidden"}
    end

    test "non-admin user returns 403", %{conn: conn} do
      {_, session} = user_and_session()
      conn = conn |> put_bearer(session.id) |> post("/admin/reaper/run")
      assert json_response(conn, 403) == %{"error" => "forbidden"}
    end
  end

  describe "POST /admin/reaper/run — admin user" do
    test "202 + swept_count + swept_at after reaping an expired visitor", %{conn: conn} do
      expired_at = DateTime.add(DateTime.utc_now(), -1, :hour)
      slug = "reaper-http-#{System.unique_integer([:positive])}"
      {:ok, _} = Grappa.Networks.find_or_create_network(%{slug: slug})
      visitor = visitor_fixture(network_slug: slug, expires_at: expired_at)

      session = admin_session()
      conn = conn |> put_bearer(session.id) |> post("/admin/reaper/run")

      body = json_response(conn, 202)
      assert body["swept_count"] >= 1
      assert is_binary(body["swept_at"])

      # And the expired row really is gone.
      assert Grappa.Repo.get(Visitor, visitor.id) == nil
    end

    test "202 + swept_count=0 when nothing to reap", %{conn: conn} do
      # No expired visitors planted; the sweep is a no-op count.
      session = admin_session()
      conn = conn |> put_bearer(session.id) |> post("/admin/reaper/run")

      body = json_response(conn, 202)
      assert body["swept_count"] == 0
    end
  end
end
