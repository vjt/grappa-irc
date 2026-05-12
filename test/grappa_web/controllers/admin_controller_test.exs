defmodule GrappaWeb.AdminControllerTest do
  @moduledoc """
  `POST /admin/reload` is loopback-gated (only `127.0.0.1` / `::1`)
  and triggers `Phoenix.CodeReloader.reload/1` on success.

  The loopback gate is the load-bearing security check — the test
  exercises both the allow path (default ConnCase remote_ip is
  `127.0.0.1`) and the deny path (manually rewritten remote_ip).

  The reload itself is a no-op against committed code in the test
  sandbox (Mix is loaded, so reload! runs; nothing changed on disk).
  Verifying the controller wires the wrapper correctly is the
  contract under test, not the reload semantics themselves (those
  belong to Phoenix).

  `async: true` — no shared state.
  """
  use GrappaWeb.ConnCase, async: true

  describe "POST /admin/reload — loopback gate" do
    test "allows 127.0.0.1 with 200 ok body", %{conn: conn} do
      conn = post(conn, "/admin/reload")
      assert response(conn, 200) == "ok"
    end

    test "allows ::1 with 200 ok body", %{conn: conn} do
      conn = post(%{conn | remote_ip: {0, 0, 0, 0, 0, 0, 0, 1}}, "/admin/reload")
      assert response(conn, 200) == "ok"
    end

    test "denies non-loopback remote_ip with 403", %{conn: conn} do
      conn = post(%{conn | remote_ip: {192, 168, 1, 100}}, "/admin/reload")
      assert response(conn, 403) =~ "loopback_only"
    end

    test "denies LAN IPv6 with 403", %{conn: conn} do
      conn = post(%{conn | remote_ip: {0xFE80, 0, 0, 0, 0, 0, 0, 1}}, "/admin/reload")
      assert response(conn, 403) =~ "loopback_only"
    end
  end

  describe "POST /admin/cic-bundle-changed" do
    test "denies non-loopback remote_ip with 403", %{conn: conn} do
      conn =
        post(%{conn | remote_ip: {192, 168, 1, 100}}, "/admin/cic-bundle-changed")

      assert response(conn, 403) =~ "loopback_only"
    end

    test "returns the live bundle hash (or 204 if no bundle on disk)", %{conn: conn} do
      conn = post(conn, "/admin/cic-bundle-changed")

      case Grappa.Cic.Bundle.current_hash() do
        nil ->
          assert response(conn, 204) == ""

        hash when is_binary(hash) ->
          assert response(conn, 200) == hash
      end
    end

    test "broadcasts bundle_hash to subscribed user-topics when bundle exists", %{conn: conn} do
      case Grappa.Cic.Bundle.current_hash() do
        nil ->
          # No bundle, no broadcast — covered by the 204 test above.
          :ok

        expected_hash ->
          # Register a fake socket pid so list_user_names returns this user,
          # then subscribe a test process to the user-topic so we can
          # observe the fan-out broadcast.
          user_name = "bundlebcast-#{System.unique_integer([:positive])}"
          fake_socket = self()
          :ok = Grappa.WSPresence.register(user_name, fake_socket)

          topic = Grappa.PubSub.Topic.user(user_name)
          :ok = Phoenix.PubSub.subscribe(Grappa.PubSub, topic)

          conn = post(conn, "/admin/cic-bundle-changed")
          assert response(conn, 200) == expected_hash

          assert_receive %Phoenix.Socket.Broadcast{
            event: "event",
            payload: %{kind: "bundle_hash", hash: ^expected_hash}
          }
      end
    end

    # CP24 bucket E web/S5: visitor sockets must also receive the
    # cic_bundle_changed broadcast. Pre-fix `WSPresence.register/2`
    # was skipped for visitor sockets in `UserSocket.connect/3` (kept
    # auto-away machinery user-only) — so visitors with long-lived
    # tabs never saw the live bundle-hash refresh banner trigger,
    # leaving them silently stale until manual reload.
    test "broadcasts bundle_hash to subscribed VISITOR-topics when bundle exists", %{conn: conn} do
      case Grappa.Cic.Bundle.current_hash() do
        nil ->
          :ok

        expected_hash ->
          visitor_name = "visitor:#{Ecto.UUID.generate()}"
          fake_socket = self()
          :ok = Grappa.WSPresence.register(visitor_name, fake_socket)

          topic = Grappa.PubSub.Topic.user(visitor_name)
          :ok = Phoenix.PubSub.subscribe(Grappa.PubSub, topic)

          conn = post(conn, "/admin/cic-bundle-changed")
          assert response(conn, 200) == expected_hash

          assert_receive %Phoenix.Socket.Broadcast{
            event: "event",
            payload: %{kind: "bundle_hash", hash: ^expected_hash}
          }
      end
    end
  end
end
