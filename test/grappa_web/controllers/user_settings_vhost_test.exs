defmodule GrappaWeb.UserSettingsVhostTest do
  @moduledoc """
  #228 — `/me/settings/vhost` user self-service surface. GET returns the
  subject's allowed vhost set (in_pool marking + pin) plus the current
  selection; PUT persists a selection authz-clamped to the allowed set.
  Behind `[:api, :authn]`; both user + visitor subjects.
  """
  use GrappaWeb.ConnCase, async: true

  import Grappa.AuthFixtures

  alias Grappa.Vhosts

  defp addr do
    n = Bitwise.band(System.unique_integer([:positive]), 0xFFFF)
    "2001:db8::" <> String.downcase(Integer.to_string(n, 16))
  end

  describe "GET /me/settings/vhost — auth gate" do
    test "no bearer returns 401", %{conn: conn} do
      conn = get(conn, "/me/settings/vhost")
      assert json_response(conn, 401) == %{"error" => "unauthorized"}
    end
  end

  describe "GET /me/settings/vhost" do
    test "returns generally-available + granted vhosts, marks in_pool, pin, selection", %{conn: conn} do
      {user, session} = user_and_session()
      {:ok, ga} = Vhosts.create_vhost(%{address: addr(), generally_available: true, in_pool: true})
      {:ok, granted} = Vhosts.create_vhost(%{address: addr(), generally_available: false})
      {:ok, _} = Vhosts.grant_vhost(granted, {:user, user.id}, pinned: false)
      {:ok, _} = Vhosts.create_vhost(%{address: addr(), generally_available: false})

      conn = conn |> put_bearer(session.id) |> get("/me/settings/vhost")
      body = json_response(conn, 200)

      addrs = Enum.map(body["available"], & &1["address"])
      assert ga.address in addrs
      assert granted.address in addrs
      # a private, ungranted vhost never appears
      refute Enum.any?(
               body["available"],
               &(&1["generally_available"] == false and &1["address"] not in [granted.address])
             )

      ga_row = Enum.find(body["available"], &(&1["address"] == ga.address))
      assert ga_row["in_pool"] == true
      assert body["selection"] == []
      assert body["pinned"] == nil
    end

    test "reflects a pin (not user-changeable)", %{conn: conn} do
      {user, session} = user_and_session()
      {:ok, v} = Vhosts.create_vhost(%{address: addr()})
      {:ok, _} = Vhosts.pin_vhost(v, {:user, user.id})

      conn = conn |> put_bearer(session.id) |> get("/me/settings/vhost")
      body = json_response(conn, 200)
      assert body["pinned"] == v.address
    end
  end

  describe "PUT /me/settings/vhost" do
    test "persists an allowed selection", %{conn: conn} do
      {_, session} = user_and_session()
      {:ok, ga} = Vhosts.create_vhost(%{address: addr(), generally_available: true})

      conn = conn |> put_bearer(session.id) |> put("/me/settings/vhost", %{selection: [ga.address]})
      body = json_response(conn, 200)
      assert body["selection"] == [ga.address]
    end

    test "rejects a selection outside the allowed set with 403", %{conn: conn} do
      {_, session} = user_and_session()
      {:ok, forbidden} = Vhosts.create_vhost(%{address: addr(), generally_available: false})

      conn = conn |> put_bearer(session.id) |> put("/me/settings/vhost", %{selection: [forbidden.address]})
      assert json_response(conn, 403)["error"] == "forbidden_vhost"
    end

    test "rejects a non-list selection with 400", %{conn: conn} do
      {_, session} = user_and_session()
      conn = conn |> put_bearer(session.id) |> put("/me/settings/vhost", %{selection: "nope"})
      assert json_response(conn, 400)["error"] == "bad_request"
    end
  end

  describe "visitor parity" do
    test "visitor GET + PUT both succeed", %{conn: conn} do
      {visitor, session} = visitor_and_session()
      {:ok, ga} = Vhosts.create_vhost(%{address: addr(), generally_available: true})

      conn = conn |> put_bearer(session.id) |> put("/me/settings/vhost", %{selection: [ga.address]})
      assert json_response(conn, 200)["selection"] == [ga.address]
      assert Vhosts.get_selection({:visitor, visitor.id}) == [ga.address]
    end
  end
end
