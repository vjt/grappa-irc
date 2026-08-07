defmodule GrappaWeb.AdminControllerTest do
  @moduledoc """
  `POST /admin/reload` is gated on the request having reached the BEAM
  directly from inside the box (loopback transport peer AND no forwarded
  header) and triggers `Phoenix.CodeReloader.reload/1` on success.

  That gate is the load-bearing security check — the tests exercise the
  allow path (default ConnCase peer is `127.0.0.1`, bare) and every deny
  path: a non-loopback peer, and a loopback peer carrying a forwarded
  header (i.e. one that came through a proxy). The gate never reads the
  RESOLVED client IP; see `GrappaWeb.Plugs.LoopbackOnly`.

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

    test "success body carries the literal \"failed\":[] both deploy paths grep for", %{
      conn: conn
    } do
      # Both scripts/deploy.sh (#364 docker S6) and infra/freebsd/deploy.sh
      # discriminate a successful hot reload with the byte-exact glob
      # `*'"failed":[]'*` against this raw response. Jason emits compact
      # JSON (no space after the colon) and no committed code changed in the
      # sandbox, so `failed` is empty — pin the exact substring so a future
      # encoder/whitespace change that would break both shell paths reddens
      # HERE instead of aborting every clean deploy.
      conn = post(conn, "/admin/reload")
      assert conn.status == 200
      assert conn.resp_body =~ ~s("failed":[])
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

    # SECURITY: the presence of ANY forwarded header disqualifies a
    # request from the gate, loopback transport peer or not. A forwarded
    # header means some proxy handled this request, and the operator
    # shape the gate exists for never goes through one.
    #
    # This case USED to return 200, and for the wrong reason: the header
    # named only a reserved address, the resolver therefore found no
    # client, fell back to the transport peer, and the gate — which read
    # the resolved value — saw loopback. The 200 was the fallback
    # showing through, not a deliberate allowance.
    #
    # Tested at controller level (not unit) because the integration of
    # wrapper + LoopbackOnly + admin pipeline is the contract that
    # actually defends the surface — a wrapper-only unit test would pass
    # even if a future refactor removed the wrapper from the endpoint.
    test "loopback peer carrying a forwarded header is denied (403)", %{conn: conn} do
      conn =
        conn
        |> Plug.Conn.put_req_header("x-forwarded-for", "192.168.1.100")
        |> post("/admin/reload")

      assert response(conn, 403) =~ "loopback_only"
    end

    test "X-Real-IP also disqualifies a loopback peer (403)", %{conn: conn} do
      # Both headers in the allowlist must disqualify, or the gate's
      # tightness would depend on which one the fronting proxy sets —
      # the shipped snippets set BOTH, an operator's own proxy may set
      # either.
      conn =
        conn
        |> Plug.Conn.put_req_header("x-real-ip", "192.168.1.100")
        |> post("/admin/reload")

      assert response(conn, 403) =~ "loopback_only"
    end

    test "forwarded header naming loopback, from a non-loopback peer, is denied (403)",
         %{conn: conn} do
      # A caller on a LAN peer claiming to be loopback. Denied twice
      # over: the peer is not loopback, and a forwarded header is
      # present. The gate never consults what the header claims.
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
            payload: %{kind: :bundle_hash, hash: ^expected_hash}
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
            payload: %{kind: :bundle_hash, hash: ^expected_hash}
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
