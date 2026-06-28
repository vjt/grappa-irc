defmodule GrappaWeb.Admin.FeaturedChannelsControllerTest do
  use GrappaWeb.ConnCase, async: true

  import Grappa.AuthFixtures

  alias Grappa.{Accounts, Networks}
  alias Grappa.Networks.FeaturedChannels

  defp admin_session do
    {user, session} = user_and_session()
    {:ok, _} = Accounts.update_admin_flags(user, %{is_admin: true})
    session
  end

  defp fresh_network do
    {:ok, net} =
      Networks.find_or_create_network(%{slug: "fcc-#{System.unique_integer([:positive])}"})

    net
  end

  describe "POST /admin/networks/:id/featured_channels" do
    test "201 + lowercased body on happy path", %{conn: conn} do
      net = fresh_network()

      conn =
        conn
        |> put_bearer(admin_session().id)
        |> put_req_header("content-type", "application/json")
        |> post(
          "/admin/networks/#{net.id}/featured_channels",
          Jason.encode!(%{name: "#Sniffo", description: "blurb", position: 2})
        )

      body = json_response(conn, 201)
      assert body["name"] == "#sniffo"
      assert body["description"] == "blurb"
      assert body["position"] == 2
      assert body["enabled"] == true
      assert body["network_id"] == net.id
      assert is_integer(body["id"])
    end

    test "409 on duplicate", %{conn: conn} do
      net = fresh_network()
      {:ok, _} = FeaturedChannels.add_channel(net, %{name: "#dup"})

      conn =
        conn
        |> put_bearer(admin_session().id)
        |> put_req_header("content-type", "application/json")
        |> post("/admin/networks/#{net.id}/featured_channels", Jason.encode!(%{name: "#DUP"}))

      assert json_response(conn, 409)["error"] == "already_exists"
    end

    test "422 on invalid channel name", %{conn: conn} do
      net = fresh_network()

      conn =
        conn
        |> put_bearer(admin_session().id)
        |> put_req_header("content-type", "application/json")
        |> post("/admin/networks/#{net.id}/featured_channels", Jason.encode!(%{name: "nope"}))

      assert json_response(conn, 422)["error"] == "validation_failed"
    end

    test "400 on unknown attr key", %{conn: conn} do
      net = fresh_network()

      conn =
        conn
        |> put_bearer(admin_session().id)
        |> put_req_header("content-type", "application/json")
        |> post(
          "/admin/networks/#{net.id}/featured_channels",
          Jason.encode!(%{name: "#x", positon: 1})
        )

      assert json_response(conn, 400)["error"] == "bad_request"
    end
  end

  describe "GET /admin/networks/:id/featured_channels" do
    test "lists rows ordered by position", %{conn: conn} do
      net = fresh_network()
      {:ok, _} = FeaturedChannels.add_channel(net, %{name: "#b", position: 1})
      {:ok, _} = FeaturedChannels.add_channel(net, %{name: "#a", position: 0})

      conn =
        conn
        |> put_bearer(admin_session().id)
        |> get("/admin/networks/#{net.id}/featured_channels")

      assert ["#a", "#b"] = Enum.map(json_response(conn, 200)["featured_channels"], & &1["name"])
    end
  end

  describe "PUT/DELETE /admin/networks/:id/featured_channels/:id" do
    test "PUT toggles enabled", %{conn: conn} do
      net = fresh_network()
      {:ok, fc} = FeaturedChannels.add_channel(net, %{name: "#t"})

      conn =
        conn
        |> put_bearer(admin_session().id)
        |> put_req_header("content-type", "application/json")
        |> put(
          "/admin/networks/#{net.id}/featured_channels/#{fc.id}",
          Jason.encode!(%{enabled: false})
        )

      assert json_response(conn, 200)["enabled"] == false
    end

    test "DELETE removes the row -> 200 {}", %{conn: conn} do
      net = fresh_network()
      {:ok, fc} = FeaturedChannels.add_channel(net, %{name: "#d"})

      conn =
        conn
        |> put_bearer(admin_session().id)
        |> delete("/admin/networks/#{net.id}/featured_channels/#{fc.id}")

      assert json_response(conn, 200) == %{}
      assert FeaturedChannels.list_channels(net) == []
    end

    test "cross-network id 404s", %{conn: conn} do
      net = fresh_network()
      other = fresh_network()
      {:ok, fc} = FeaturedChannels.add_channel(net, %{name: "#z"})

      conn =
        conn
        |> put_bearer(admin_session().id)
        |> delete("/admin/networks/#{other.id}/featured_channels/#{fc.id}")

      assert json_response(conn, 404)
    end
  end

  describe "authz" do
    test "non-admin user 403s", %{conn: conn} do
      net = fresh_network()
      {_user, session} = user_and_session()

      conn =
        conn
        |> put_bearer(session.id)
        |> get("/admin/networks/#{net.id}/featured_channels")

      assert json_response(conn, 403)["error"] == "forbidden"
    end
  end
end
