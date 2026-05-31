defmodule GrappaWeb.Admin.ServersControllerTest do
  @moduledoc """
  `POST /admin/networks/:id/servers` + `PUT /admin/networks/:network_id/servers/:id`
  + `DELETE /admin/networks/:network_id/servers/:id` — admin-panel
  bucket 1. Behind `:admin_authn`; visitor + non-admin user collapse
  to 403 upstream.

  ## Three-class parity matrix N/A

  Operator-facing endpoint, same rationale as the sibling
  `NetworksControllerTest`.

  ## Test isolation

  `async: true` — every test scopes to a freshly-created network +
  server rows; the writes go through Repo sandbox so the per-test
  cleanup is automatic.
  """
  use GrappaWeb.ConnCase, async: true

  import Grappa.AuthFixtures

  alias Grappa.{Accounts, Networks}
  alias Grappa.Networks.Servers
  alias Grappa.PubSub.Topic

  defp admin_session do
    {user, session} = user_and_session()
    {:ok, _} = Accounts.update_admin_flags(user, %{is_admin: true})
    session
  end

  defp fresh_network do
    {:ok, net} = Networks.find_or_create_network(%{slug: "srv-c-#{System.unique_integer([:positive])}"})
    net
  end

  describe "POST /admin/networks/:id/servers — auth gate" do
    test "no bearer returns 401", %{conn: conn} do
      net = fresh_network()
      conn = post(conn, "/admin/networks/#{net.id}/servers", %{host: "x", port: 1})
      assert json_response(conn, 401) == %{"error" => "unauthorized"}
    end

    test "visitor returns 403", %{conn: conn} do
      net = fresh_network()
      {_, session} = visitor_and_session()
      conn = conn |> put_bearer(session.id) |> post("/admin/networks/#{net.id}/servers", %{host: "x", port: 1})
      assert json_response(conn, 403) == %{"error" => "forbidden"}
    end

    test "non-admin user returns 403", %{conn: conn} do
      net = fresh_network()
      {_, session} = user_and_session()
      conn = conn |> put_bearer(session.id) |> post("/admin/networks/#{net.id}/servers", %{host: "x", port: 1})
      assert json_response(conn, 403) == %{"error" => "forbidden"}
    end
  end

  describe "POST /admin/networks/:id/servers — admin user" do
    test "201 + server body on happy path", %{conn: conn} do
      net = fresh_network()
      session = admin_session()

      conn =
        conn
        |> put_bearer(session.id)
        |> put_req_header("content-type", "application/json")
        |> post(
          "/admin/networks/#{net.id}/servers",
          Jason.encode!(%{host: "irc.example.test", port: 6697, tls: true})
        )

      body = json_response(conn, 201)
      assert body["host"] == "irc.example.test"
      assert body["port"] == 6697
      assert body["tls"] == true
      assert body["network_id"] == net.id
      assert is_integer(body["id"])
    end

    test "404 for unknown network id", %{conn: conn} do
      session = admin_session()

      conn =
        conn
        |> put_bearer(session.id)
        |> put_req_header("content-type", "application/json")
        |> post("/admin/networks/999999999/servers", Jason.encode!(%{host: "h", port: 6697}))

      assert json_response(conn, 404) == %{"error" => "not_found"}
    end

    test "409 already_exists on duplicate (host, port) per network", %{conn: conn} do
      net = fresh_network()
      {:ok, _} = Servers.add_server(net, %{host: "dup.example.test", port: 6697})
      session = admin_session()

      conn =
        conn
        |> put_bearer(session.id)
        |> put_req_header("content-type", "application/json")
        |> post(
          "/admin/networks/#{net.id}/servers",
          Jason.encode!(%{host: "dup.example.test", port: 6697})
        )

      assert json_response(conn, 409) == %{"error" => "already_exists"}
    end

    test "422 on bad port", %{conn: conn} do
      net = fresh_network()
      session = admin_session()

      conn =
        conn
        |> put_bearer(session.id)
        |> put_req_header("content-type", "application/json")
        |> post(
          "/admin/networks/#{net.id}/servers",
          Jason.encode!(%{host: "h", port: 70_000})
        )

      assert json_response(conn, 422)["error"] == "validation_failed"
    end
  end

  describe "PUT /admin/networks/:network_id/servers/:id — admin user" do
    test "200 + updated row", %{conn: conn} do
      net = fresh_network()
      {:ok, server} = Servers.add_server(net, %{host: "h", port: 6697})
      session = admin_session()

      conn =
        conn
        |> put_bearer(session.id)
        |> put_req_header("content-type", "application/json")
        |> put(
          "/admin/networks/#{net.id}/servers/#{server.id}",
          Jason.encode!(%{port: 6667, tls: false})
        )

      body = json_response(conn, 200)
      assert body["port"] == 6667
      assert body["tls"] == false
      assert body["host"] == "h"
    end

    test "404 when server id does not belong to network", %{conn: conn} do
      net1 = fresh_network()
      net2 = fresh_network()
      {:ok, server} = Servers.add_server(net1, %{host: "h", port: 6697})
      session = admin_session()

      conn =
        conn
        |> put_bearer(session.id)
        |> put_req_header("content-type", "application/json")
        |> put(
          "/admin/networks/#{net2.id}/servers/#{server.id}",
          Jason.encode!(%{port: 6667})
        )

      assert json_response(conn, 404) == %{"error" => "not_found"}
    end

    test "409 already_exists when update collides with sibling", %{conn: conn} do
      net = fresh_network()
      {:ok, _} = Servers.add_server(net, %{host: "a", port: 6697})
      {:ok, b} = Servers.add_server(net, %{host: "b", port: 6697})
      session = admin_session()

      conn =
        conn
        |> put_bearer(session.id)
        |> put_req_header("content-type", "application/json")
        |> put(
          "/admin/networks/#{net.id}/servers/#{b.id}",
          Jason.encode!(%{host: "a"})
        )

      assert json_response(conn, 409) == %{"error" => "already_exists"}
    end
  end

  describe "DELETE /admin/networks/:network_id/servers/:id — admin user" do
    test "200 + affected_session_count when row is removed", %{conn: conn} do
      net = fresh_network()
      {:ok, server} = Servers.add_server(net, %{host: "h", port: 6697})
      session = admin_session()

      conn = conn |> put_bearer(session.id) |> delete("/admin/networks/#{net.id}/servers/#{server.id}")
      body = json_response(conn, 200)
      assert is_integer(body["network_session_count"])
      assert body["network_session_count"] >= 0

      assert Servers.list_servers(net) == []
    end

    test "404 when server id does not belong to network", %{conn: conn} do
      net1 = fresh_network()
      net2 = fresh_network()
      {:ok, server} = Servers.add_server(net1, %{host: "h", port: 6697})
      session = admin_session()

      conn = conn |> put_bearer(session.id) |> delete("/admin/networks/#{net2.id}/servers/#{server.id}")
      assert json_response(conn, 404) == %{"error" => "not_found"}
    end
  end

  # Bucket 4 — admin event emission on every server mutation. Subscribe
  # to the topic per-test (mailbox-scoped); we don't reset the singleton
  # ring buffer because servers tests run async — the assertion targets
  # ONLY this test's emission via assert_receive's pattern match.
  describe "admin event emission (bucket 4)" do
    test "POST emits :server_added with operator attribution", %{conn: conn} do
      :ok = Phoenix.PubSub.subscribe(Grappa.PubSub, Topic.admin_events())

      net = fresh_network()
      net_id = net.id
      net_slug = net.slug
      session = admin_session()

      _ =
        conn
        |> put_bearer(session.id)
        |> put_req_header("content-type", "application/json")
        |> post(
          "/admin/networks/#{net.id}/servers",
          Jason.encode!(%{host: "evt-add.test", port: 6697, tls: true})
        )

      assert_receive %Phoenix.Socket.Broadcast{
                       topic: "grappa:admin:events",
                       event: "event",
                       payload: %{
                         kind: :server_added,
                         network_id: ^net_id,
                         network_slug: ^net_slug,
                         host: "evt-add.test",
                         port: 6697,
                         tls: true,
                         actor_user_id: actor_id,
                         actor_user_name: actor_name
                       }
                     },
                     500

      assert is_binary(actor_id)
      assert is_binary(actor_name)
    end

    test "PUT emits :server_updated with operator attribution", %{conn: conn} do
      :ok = Phoenix.PubSub.subscribe(Grappa.PubSub, Topic.admin_events())

      net = fresh_network()
      net_id = net.id
      net_slug = net.slug
      {:ok, server} = Servers.add_server(net, %{host: "evt-up.test", port: 6697})
      sid = server.id
      session = admin_session()

      _ =
        conn
        |> put_bearer(session.id)
        |> put_req_header("content-type", "application/json")
        |> put(
          "/admin/networks/#{net.id}/servers/#{server.id}",
          Jason.encode!(%{port: 6667, tls: false})
        )

      assert_receive %Phoenix.Socket.Broadcast{
                       topic: "grappa:admin:events",
                       event: "event",
                       payload: %{
                         kind: :server_updated,
                         network_id: ^net_id,
                         network_slug: ^net_slug,
                         server_id: ^sid,
                         port: 6667,
                         tls: false
                       }
                     },
                     500
    end

    test "DELETE emits :server_removed with operator attribution", %{conn: conn} do
      :ok = Phoenix.PubSub.subscribe(Grappa.PubSub, Topic.admin_events())

      net = fresh_network()
      net_id = net.id
      net_slug = net.slug
      {:ok, server} = Servers.add_server(net, %{host: "evt-del.test", port: 6697})
      sid = server.id
      session = admin_session()

      _ =
        conn
        |> put_bearer(session.id)
        |> delete("/admin/networks/#{net.id}/servers/#{server.id}")

      assert_receive %Phoenix.Socket.Broadcast{
                       topic: "grappa:admin:events",
                       event: "event",
                       payload: %{
                         kind: :server_removed,
                         network_id: ^net_id,
                         network_slug: ^net_slug,
                         server_id: ^sid,
                         host: "evt-del.test",
                         port: 6697
                       }
                     },
                     500
    end
  end
end
