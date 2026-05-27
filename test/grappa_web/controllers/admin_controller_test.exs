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

  `async: false` because the `cic-bundle-changed` tests register a
  fake socket pid against the application-wide `Grappa.WSPresence`
  singleton — concurrent tests would observe each other's
  registrations on the same `user_name`. The TI-1 `max_cases: 1` in
  `config/test.exs` already serializes the suite, but per the
  WSPresence moduledoc test-isolation paragraph this contract MUST
  be encoded at the test-file level so it survives any future
  faster-lane carve-out.
  """
  use GrappaWeb.ConnCase, async: false

  alias Grappa.Cic.Bundle

  describe "POST /admin/reload — loopback gate" do
    test "allows 127.0.0.1 with 200 JSON response listing reloaded modules", %{conn: conn} do
      # Post-CodeReloader-noop fix: response is JSON
      # `%{"reloaded" => [module_string, ...]}`. Reloaded list is
      # `:code.modified_modules/0` at request time → typically `[]` in
      # the test sandbox (committed code matches loaded BEAM), but
      # the shape is the contract.
      conn = post(conn, "/admin/reload")
      body = json_response(conn, 200)
      assert is_list(body["reloaded"])
      assert Enum.all?(body["reloaded"], &is_binary/1)
    end

    test "allows ::1 with 200 JSON response", %{conn: conn} do
      conn = post(%{conn | remote_ip: {0, 0, 0, 0, 0, 0, 0, 1}}, "/admin/reload")
      body = json_response(conn, 200)
      assert is_list(body["reloaded"])
    end

    test "denies non-loopback remote_ip with 403", %{conn: conn} do
      conn = post(%{conn | remote_ip: {192, 168, 1, 100}}, "/admin/reload")
      assert response(conn, 403) =~ "loopback_only"
    end

    test "denies LAN IPv6 with 403", %{conn: conn} do
      conn = post(%{conn | remote_ip: {0xFE80, 0, 0, 0, 0, 0, 0, 1}}, "/admin/reload")
      assert response(conn, 403) =~ "loopback_only"
    end

    # SECURITY: end-to-end proof that the `RemoteIpFromProxy` wrapper
    # protects the LoopbackOnly gate from container-shell spoofing.
    # The attack: `docker exec grappa curl -H "X-Forwarded-For: <ip>"
    # http://localhost:4000/admin/reload`. Bare `RemoteIp` would
    # rewrite `conn.remote_ip` from the header and (when the spoofed
    # value is loopback) silently grant access. The wrapper bypasses
    # the rewrite when the TCP peer is loopback, so the gate sees the
    # genuine loopback peer (allow) and the spoofed value is ignored.
    #
    # Tested at controller level (not unit) because the integration
    # of wrapper + LoopbackOnly + admin pipeline is the contract that
    # actually defends the surface — a wrapper-only unit test would
    # pass even if a future refactor removed the wrapper from the
    # endpoint.
    test "spoofed X-Forwarded-For from loopback peer is ignored, gate still passes (200)",
         %{conn: conn} do
      # Peer = 127.0.0.1 (ConnCase default), X-F-F spoofs a LAN IP.
      # Without the wrapper: bare RemoteIp rewrites to {192,168,1,100},
      # LoopbackOnly returns 403 (by coincidence the spoof self-DoSes).
      # WITH the wrapper: peer is loopback → wrapper bypasses → gate
      # sees {127,0,0,1} → 200.
      conn =
        conn
        |> Plug.Conn.put_req_header("x-forwarded-for", "192.168.1.100")
        |> post("/admin/reload")

      body = json_response(conn, 200)
      assert is_list(body["reloaded"])
    end

    test "spoofed X-Forwarded-For: 127.0.0.1 from non-loopback peer is denied (403)",
         %{conn: conn} do
      # The malicious case the wrapper exists to prevent: peer is a
      # LAN IP, attacker sets `X-Forwarded-For: 127.0.0.1` hoping to
      # masquerade as loopback. Wrapper bypass applies only to
      # loopback PEERS — a LAN peer still hits bare RemoteIp, which
      # walks the X-F-F chain and finds {127,0,0,1} as a reserved-
      # range hit. `RemoteIp` skips reserved entries during the walk,
      # so the rewrite falls back to... nothing in the chain, leaving
      # conn.remote_ip as the original peer {192,168,1,100}. The gate
      # sees a LAN IP and returns 403. (The attacker can't elevate.)
      conn =
        %{conn | remote_ip: {192, 168, 1, 100}}
        |> Plug.Conn.put_req_header("x-forwarded-for", "127.0.0.1")
        |> post("/admin/reload")

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

      case Bundle.current_hash() do
        nil ->
          assert response(conn, 204) == ""

        hash when is_binary(hash) ->
          assert response(conn, 200) == hash
      end
    end

    test "broadcasts bundle_hash to subscribed user-topics when bundle exists", %{conn: conn} do
      case Bundle.current_hash() do
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
      case Bundle.current_hash() do
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

    # HIGH-17 (no-silent-drops B6.9a 2026-05-14): per-target accounting
    # via summary telemetry. The fan-out used to discard each
    # broadcast_event/2 result; the controller returned 200 even if
    # zero of N targets received the push. Now the operator can wire a
    # PromEx alert on `[:grappa, :admin, :cic_bundle_fanout]` with
    # `failed > 0`.
    test "emits [:grappa, :admin, :cic_bundle_fanout] telemetry with attempted/succeeded/failed",
         %{conn: conn} do
      case Bundle.current_hash() do
        nil ->
          :ok

        expected_hash ->
          handler_id = "test-cic-bundle-fanout-#{System.unique_integer([:positive])}"
          parent = self()

          :telemetry.attach(
            handler_id,
            [:grappa, :admin, :cic_bundle_fanout],
            fn event, measurements, metadata, _ ->
              send(parent, {:telemetry, event, measurements, metadata})
            end,
            nil
          )

          try do
            user_name = "fanout-tel-#{System.unique_integer([:positive])}"
            :ok = Grappa.WSPresence.register(user_name, self())

            conn = post(conn, "/admin/cic-bundle-changed")
            assert response(conn, 200) == expected_hash

            assert_receive {:telemetry, [:grappa, :admin, :cic_bundle_fanout],
                            %{attempted: attempted, succeeded: succeeded, failed: failed}, %{hash: ^expected_hash}}

            assert is_integer(attempted) and attempted >= 1
            assert is_integer(succeeded) and succeeded >= 1
            assert is_integer(failed) and failed >= 0
            assert attempted == succeeded + failed
          after
            :telemetry.detach(handler_id)
          end
      end
    end
  end
end
