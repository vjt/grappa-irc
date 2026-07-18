defmodule GrappaWeb.Admin.WSPresenceControllerTest do
  @moduledoc """
  `GET /admin/ws_presence` (#318) — read-only live snapshot of the
  per-user / per-pid WS presence + freshness. The diagnostic backing the
  on-device efficacy verification for the iOS stale-`:visible` push bug:
  a reporter backgrounds the PWA and the operator reads back whether the
  socket goes stale/hidden (fix working) or stays fresh-visible (fix not
  yet effective). Behind `:admin_authn`: visitor + non-admin collapse to
  403 upstream of the action.

  `async: false` — reads `Grappa.WSPresence`, an app-wide singleton
  (config `max_cases: 1`); concurrent tests would collide on its state.
  """
  use GrappaWeb.ConnCase, async: false

  import Grappa.AuthFixtures

  alias Grappa.{Accounts, WSPresence}

  setup do
    :ok = WSPresence.reset_for_test()
    :ok
  end

  defp admin_session do
    {user, session} = user_and_session()
    {:ok, _} = Accounts.update_admin_flags(user, %{is_admin: true})
    session
  end

  defp live_pid do
    spawn(fn -> Process.sleep(:infinity) end)
  end

  describe "GET /admin/ws_presence — auth gate" do
    test "no bearer returns 401", %{conn: conn} do
      assert conn |> get("/admin/ws_presence") |> json_response(401) ==
               %{"error" => "unauthorized"}
    end

    test "visitor subject returns 403", %{conn: conn} do
      {_, session} = visitor_and_session()

      assert conn |> put_bearer(session.id) |> get("/admin/ws_presence") |> json_response(403) ==
               %{"error" => "forbidden"}
    end

    test "non-admin user returns 403", %{conn: conn} do
      {_, session} = user_and_session()

      assert conn |> put_bearer(session.id) |> get("/admin/ws_presence") |> json_response(403) ==
               %{"error" => "forbidden"}
    end
  end

  describe "GET /admin/ws_presence — admin snapshot" do
    test "200 exposes stale_ms and an empty user list when nobody is connected",
         %{conn: conn} do
      session = admin_session()
      body = conn |> put_bearer(session.id) |> get("/admin/ws_presence") |> json_response(200)

      assert %{"stale_ms" => stale_ms, "users" => []} = body
      assert is_integer(stale_ms) and stale_ms > 0
    end

    test "200 reports a fresh visible pid as present", %{conn: conn} do
      device = live_pid()
      :ok = WSPresence.register("vjt", device)
      :ok = WSPresence.set_visibility("vjt", device, true)

      session = admin_session()
      body = conn |> put_bearer(session.id) |> get("/admin/ws_presence") |> json_response(200)

      assert [user] = body["users"]
      assert user["user_name"] == "vjt"
      assert user["any_visible"] == true
      assert [socket] = user["sockets"]
      assert socket["visibility"] == "visible"
      assert socket["fresh"] == true
      assert is_integer(socket["age_ms"])

      Process.exit(device, :kill)
    end

    test "200 reports a stale visible pid as not-fresh + user not present", %{conn: conn} do
      device = live_pid()
      :ok = WSPresence.register("vjt", device)
      :ok = WSPresence.set_visibility("vjt", device, true)
      :ok = WSPresence.mark_stale_for_test("vjt", device)

      session = admin_session()
      body = conn |> put_bearer(session.id) |> get("/admin/ws_presence") |> json_response(200)

      assert [user] = body["users"]
      assert user["any_visible"] == false
      assert [socket] = user["sockets"]
      assert socket["visibility"] == "visible"
      assert socket["fresh"] == false

      Process.exit(device, :kill)
    end
  end
end
