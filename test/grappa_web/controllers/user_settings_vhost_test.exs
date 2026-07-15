defmodule GrappaWeb.UserSettingsVhostTest do
  @moduledoc """
  #228, #251 — `/me/settings/vhost` user self-service surface. GET returns
  the subject's allowed vhost set (each option marked in_pool + granted)
  plus the current selection; PUT persists a selection authz-clamped to the
  allowed set. Behind `[:api, :authn]`; both user + visitor subjects.
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
    test "returns generally-available + granted vhosts, marks in_pool, selection", %{conn: conn} do
      {user, session} = user_and_session()
      {:ok, ga} = Vhosts.create_vhost(%{address: addr(), generally_available: true, in_pool: true})
      {:ok, granted} = Vhosts.create_vhost(%{address: addr(), generally_available: false})
      {:ok, _} = Vhosts.grant_vhost(granted, {:user, user.id})
      {:ok, priv} = Vhosts.create_vhost(%{address: addr(), generally_available: false})

      conn = conn |> put_bearer(session.id) |> get("/me/settings/vhost")
      body = json_response(conn, 200)

      addrs = Enum.map(body["available"], & &1["address"])
      assert ga.address in addrs
      assert granted.address in addrs
      # a private, ungranted, non-pool vhost never appears
      refute priv.address in addrs

      ga_row = Enum.find(body["available"], &(&1["address"] == ga.address))
      assert ga_row["in_pool"] == true
      assert body["selection"] == []
      refute Map.has_key?(body, "pinned")
    end
  end

  describe "GET /me/settings/vhost — granted marker (#251)" do
    test "marks granted vhosts true and pool/general vhosts false", %{conn: conn} do
      {user, session} = user_and_session()
      {:ok, pool} = Vhosts.create_vhost(%{address: addr(), in_pool: true, generally_available: false})
      {:ok, granted} = Vhosts.create_vhost(%{address: addr(), generally_available: false})
      {:ok, _} = Vhosts.grant_vhost(granted, {:user, user.id})

      conn = conn |> put_bearer(session.id) |> get("/me/settings/vhost")
      body = json_response(conn, 200)

      pool_row = Enum.find(body["available"], &(&1["address"] == pool.address))
      granted_row = Enum.find(body["available"], &(&1["address"] == granted.address))

      # in_pool membership is NOT a grant row — granted must reflect a real grant.
      assert pool_row["granted"] == false
      assert granted_row["granted"] == true
      # pinned is gone from the wire.
      refute Map.has_key?(body, "pinned")
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

    # #251 — the P2 fix at the REST boundary: an in_pool vhost is now in the
    # allow-set for a no-grant subject, so PUT accepts it (was 403 before).
    test "accepts an in_pool address for a no-grant subject", %{conn: conn} do
      {_, session} = user_and_session()
      {:ok, pool} = Vhosts.create_vhost(%{address: addr(), in_pool: true, generally_available: false})

      conn = conn |> put_bearer(session.id) |> put("/me/settings/vhost", %{selection: [pool.address]})
      body = json_response(conn, 200)
      assert body["selection"] == [pool.address]
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
