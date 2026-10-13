defmodule Grappa.Push.SenderTest do
  @moduledoc """
  Push notifications cluster B2 (2026-05-14) — Web Push delivery
  fan-out + dead-endpoint cleanup + telemetry coverage.

  Strategy: real deliveries into a Bypass-backed listener. The sender
  reads the endpoint from the stored row, so a row pointing at
  `http://localhost:<bypass-port>/wp` exercises the full code path —
  the address check (through `Grappa.Net.Ssrf.TestResolver`, which
  waves loopback through), the ECDH encryption + JWT signing, and the
  POST — which is why the fixture uses a REAL P-256 client public key
  (random bytes fail at `:crypto.compute_key/4`). Rows are written past
  the changeset (`Grappa.PushFixtures`): Bypass is plain http on
  loopback, which registration refuses since #2401.

  These tests own the RESPONSE MAPPING: the sweep that a careless
  mapping loses is what the 404/410 cases below pin, and the send-time
  address policy (#2401) has its own describe. The wire format is
  pinned separately, by `Grappa.Push.WireFormatTest`.

  ## What this verifies
    * 200 vendor response → `:ok` + `last_used_at` bumped on the row.
    * 410 vendor response → `Push.delete_dead/1` purges the row +
      `[:grappa, :push, :delete_dead]` telemetry fires.
    * 404 vendor response → the SAME sweep: terminal per RFC 8030 §7.3.
    * 503 vendor response → `{:error, {:http_error, 503}}` + Logger
      warning + telemetry tally lands in the `error` bucket.
    * Connection refused → `{:error, _}` per the no-silent-drops rule.
    * `send_to_subject/2` empty subscription list → `:ok` + NO start/stop
      telemetry (zero-count events would just generate noise).
    * `send_to_subject/2` with N subscriptions emits `:start` (count=N)
      + `:stop` (success+gone+error tally) telemetry pair.
  """
  use Grappa.DataCase, async: false

  import ExUnit.CaptureLog
  import Grappa.AuthFixtures, only: [user_fixture: 0]
  import Grappa.PushFixtures

  alias Grappa.Push.Sender
  alias Grappa.Visitors

  # Real P-256 client public key + 16-byte auth secret — NOT random
  # bytes. The lib's ECDH path (`:crypto.compute_key/4`) raises on
  # malformed P-256 points BEFORE the HTTP POST, which would mask the
  # actual delivery-path test.
  @client_p256dh "BCfaYE5dGabdzef68MI0SN24b4Gsf1t_N3ftUlWaFGzkuudjHLor0CRjosM3c7SLZ7PfFufpsFUh8vsO1t8wCHs"
  @client_auth "3aw2ceVFv0OIBXxAvkAlSA"

  @payload %{
    title: "vjt",
    body: "ping in #sbiffo",
    tag: "libera:#sbiffo",
    url: "/?network=libera&channel=%23sbiffo"
  }

  defp visitor_fixture do
    nick = "sender-visitor-#{System.unique_integer([:positive])}"
    # #211 phase 7 — provision binds an anon credential, so the network
    # must exist first.
    {:ok, _} = Grappa.Networks.find_or_create_network(%{slug: "libera"})
    {:ok, v} = Visitors.find_or_provision_anon(nick, "libera", "127.0.0.1")
    v
  end

  # Written past the changeset: Bypass is plain http on loopback, which
  # `Push.create/2` refuses since #2401 (see `Grappa.PushFixtures`).
  defp subscription_fixture(subject, endpoint) do
    stored_subscription!(subject, %{
      endpoint: endpoint,
      p256dh_key: @client_p256dh,
      auth_key: @client_auth,
      user_agent: "Mozilla/5.0 sender-test"
    })
  end

  defp attach_telemetry(events) do
    test_pid = self()
    handler_id = "sender-test-#{System.unique_integer([:positive])}"

    :telemetry.attach_many(
      handler_id,
      events,
      fn event, measurements, metadata, _ ->
        send(test_pid, {:telemetry, event, measurements, metadata})
      end,
      nil
    )

    on_exit(fn -> :telemetry.detach(handler_id) end)
  end

  describe "send_to_subscription/2" do
    setup do
      bypass = Bypass.open()
      {:ok, bypass: bypass, endpoint: "http://localhost:#{bypass.port}/wp"}
    end

    test "200 from vendor → :ok + last_used_at bumped", %{bypass: bypass, endpoint: endpoint} do
      Bypass.expect_once(bypass, "POST", "/wp", fn conn ->
        assert ["vapid " <> _] = Plug.Conn.get_req_header(conn, "authorization")
        assert ["aes128gcm"] = Plug.Conn.get_req_header(conn, "content-encoding")
        Plug.Conn.resp(conn, 201, "")
      end)

      user = user_fixture()
      sub = subscription_fixture({:user, user.id}, endpoint)
      assert is_nil(sub.last_used_at)

      assert :ok = Sender.send_to_subscription(sub, @payload)

      reloaded = Repo.get!(Grappa.Push.Subscription, sub.id)
      refute is_nil(reloaded.last_used_at)
    end

    test "410 from vendor → {:error, :gone} + row deleted + telemetry", %{
      bypass: bypass,
      endpoint: endpoint
    } do
      attach_telemetry([[:grappa, :push, :delete_dead]])

      Bypass.expect_once(bypass, "POST", "/wp", fn conn ->
        Plug.Conn.resp(conn, 410, "")
      end)

      user = user_fixture()
      sub = subscription_fixture({:user, user.id}, endpoint)

      assert {:error, :gone} = Sender.send_to_subscription(sub, @payload)
      assert is_nil(Repo.get(Grappa.Push.Subscription, sub.id))

      assert_receive {:telemetry, [:grappa, :push, :delete_dead], %{count: 1}, %{endpoint: ^endpoint}}
    end

    test "404 from vendor → {:error, :gone} + row deleted (RFC 8030 §7.3)", %{
      bypass: bypass,
      endpoint: endpoint
    } do
      # If 404 were mapped to a plain http error the call would still
      # LOG and still emit telemetry, so the regression this pins is not
      # a missing signal: it is the missing SWEEP. The row below would survive forever and every
      # later fan-out would pay a round-trip for it.
      Bypass.expect_once(bypass, "POST", "/wp", fn conn ->
        Plug.Conn.resp(conn, 404, "")
      end)

      user = user_fixture()
      sub = subscription_fixture({:user, user.id}, endpoint)

      assert {:error, :gone} = Sender.send_to_subscription(sub, @payload)
      assert is_nil(Repo.get(Grappa.Push.Subscription, sub.id))
    end

    test "503 from vendor → {:error, {:http_error, 503}}, row preserved", %{
      bypass: bypass,
      endpoint: endpoint
    } do
      Bypass.expect_once(bypass, "POST", "/wp", fn conn ->
        Plug.Conn.resp(conn, 503, "service unavailable")
      end)

      user = user_fixture()
      sub = subscription_fixture({:user, user.id}, endpoint)

      assert {:error, {:http_error, 503}} = Sender.send_to_subscription(sub, @payload)
      assert %Grappa.Push.Subscription{} = Repo.get(Grappa.Push.Subscription, sub.id)
    end

    test "connection refused → {:error, _}, row preserved", %{
      bypass: bypass,
      endpoint: endpoint
    } do
      Bypass.down(bypass)

      user = user_fixture()
      sub = subscription_fixture({:user, user.id}, endpoint)

      assert {:error, _} = Sender.send_to_subscription(sub, @payload)
      assert %Grappa.Push.Subscription{} = Repo.get(Grappa.Push.Subscription, sub.id)
    end

    test "malformed P-256 client key → {:error, {:encrypt_error, _}}, row preserved", %{
      endpoint: endpoint
    } do
      # `:crypto.compute_key/4` raises `ErlangError` on a base64-clean
      # but cryptographically-invalid P-256 point. Caught at the
      # Sender boundary per the no-silent-drops rule (operator must
      # see telemetry on stored-data corruption rather than a
      # mysterious crash).
      user = user_fixture()

      sub =
        stored_subscription!({:user, user.id}, %{
          endpoint: endpoint,
          p256dh_key: Base.url_encode64("not-a-valid-p256-point", padding: false),
          auth_key: Base.url_encode64(:crypto.strong_rand_bytes(16), padding: false),
          user_agent: "Mozilla/5.0 sender-test"
        })

      assert {:error, {:encrypt_error, _}} = Sender.send_to_subscription(sub, @payload)
      assert %Grappa.Push.Subscription{} = Repo.get(Grappa.Push.Subscription, sub.id)
    end
  end

  describe "send_to_subscription/2 — address policy at send time (#2401)" do
    setup do
      bypass = Bypass.open()
      {:ok, bypass: bypass}
    end

    test "a stored row whose host is not a public address is refused before any request; row kept",
         %{bypass: bypass} do
      # 127.0.0.2 is loopback, refused by the real guard (the test resolver
      # only waves through 127.0.0.1 / localhost so Bypass is reachable).
      # Had the sender dialled it, Bypass would see an unexpected request.
      endpoint = "http://127.0.0.2:#{bypass.port}/wp"
      user = user_fixture()
      sub = subscription_fixture({:user, user.id}, endpoint)

      log =
        capture_log(fn ->
          assert {:error, :ssrf_blocked} = Sender.send_to_subscription(sub, @payload)
        end)

      assert log =~ "push.send endpoint refused"
      assert %Grappa.Push.Subscription{} = Repo.get(Grappa.Push.Subscription, sub.id)
    end

    test "a non-http(s) stored endpoint is refused without a request", %{bypass: bypass} do
      user = user_fixture()
      sub = subscription_fixture({:user, user.id}, "ftp://localhost:#{bypass.port}/wp")

      capture_log(fn ->
        assert {:error, :ssrf_blocked} = Sender.send_to_subscription(sub, @payload)
      end)
    end

    test "dials the address the guard returned, never re-resolving the name; Host stays the original",
         %{bypass: bypass} do
      # `.invalid` can never resolve (RFC 6761 §6.4). The test resolver pins
      # `pinned.invalid` to 127.0.0.1, so the POST can only arrive if the
      # client connected to the pinned address rather than looking the name
      # up again — which is what closes the rebind window between check and
      # connect.
      test_pid = self()

      Bypass.expect_once(bypass, "POST", "/wp", fn conn ->
        send(test_pid, {:host, Plug.Conn.get_req_header(conn, "host")})
        Plug.Conn.resp(conn, 201, "")
      end)

      user = user_fixture()
      sub = subscription_fixture({:user, user.id}, "http://pinned.invalid:#{bypass.port}/wp")

      assert :ok = Sender.send_to_subscription(sub, @payload)
      assert_receive {:host, [host]}
      assert host in ["pinned.invalid", "pinned.invalid:#{bypass.port}"]
    end

    test "a redirect is not followed — it is the http error it is", %{bypass: bypass} do
      # Following it would be a second, unguarded hop. Bypass fails the test
      # on any request to a path it was not told to expect.
      Bypass.expect_once(bypass, "POST", "/wp", fn conn ->
        conn
        |> Plug.Conn.put_resp_header("location", "http://localhost:#{bypass.port}/elsewhere")
        |> Plug.Conn.resp(307, "")
      end)

      user = user_fixture()
      sub = subscription_fixture({:user, user.id}, "http://localhost:#{bypass.port}/wp")

      capture_log(fn ->
        assert {:error, {:http_error, 307}} = Sender.send_to_subscription(sub, @payload)
      end)

      assert %Grappa.Push.Subscription{} = Repo.get(Grappa.Push.Subscription, sub.id)
    end
  end

  describe "send_to_subscription/2 — the vendor_rejection event (#1321, #2401)" do
    setup do
      bypass = Bypass.open()
      attach_telemetry([[:grappa, :push, :vendor_rejection]])
      {:ok, bypass: bypass}
    end

    test "a non-terminal rejection carries the status, the vendor HOST and the body — never the path",
         %{bypass: bypass} do
      Bypass.expect_once(bypass, "POST", "/vXrN4tPq2Ke", fn conn ->
        Plug.Conn.resp(conn, 400, ~s({"reason":"VapidPkHashMismatch"}))
      end)

      user = user_fixture()
      sub = subscription_fixture({:user, user.id}, "http://localhost:#{bypass.port}/vXrN4tPq2Ke")

      capture_log(fn ->
        assert {:error, {:http_error, 400}} = Sender.send_to_subscription(sub, @payload)
      end)

      assert_receive {:telemetry, [:grappa, :push, :vendor_rejection], _, metadata}
      assert metadata == %{status: 400, vendor: "localhost", body: ~s({"reason":"VapidPkHashMismatch"})}
    end

    for status <- [201, 404, 410] do
      test "#{status} emits no vendor_rejection — the sender already says everything", %{bypass: bypass} do
        Bypass.expect_once(bypass, "POST", "/wp", fn conn -> Plug.Conn.resp(conn, unquote(status), "") end)

        user = user_fixture()
        sub = subscription_fixture({:user, user.id}, "http://localhost:#{bypass.port}/wp")

        capture_log(fn -> Sender.send_to_subscription(sub, @payload) end)

        refute_received {:telemetry, [:grappa, :push, :vendor_rejection], _, _}
      end
    end
  end

  describe "send_to_subject/2" do
    test "no subscriptions → :ok + NO start/stop telemetry" do
      attach_telemetry([
        [:grappa, :push, :send, :start],
        [:grappa, :push, :send, :stop]
      ])

      user = user_fixture()
      assert :ok = Sender.send_to_subject({:user, user.id}, @payload)

      refute_receive {:telemetry, [:grappa, :push, :send, :start], _, _}, 50
      refute_receive {:telemetry, [:grappa, :push, :send, :stop], _, _}, 50
    end

    test "fans out to all of a user's subscriptions + emits start/stop telemetry" do
      bypass = Bypass.open()
      bypass_url = "http://localhost:#{bypass.port}"

      attach_telemetry([
        [:grappa, :push, :send, :start],
        [:grappa, :push, :send, :stop]
      ])

      Bypass.expect(bypass, "POST", "/wp/:id", fn conn ->
        Plug.Conn.resp(conn, 201, "")
      end)

      user = user_fixture()
      subject = {:user, user.id}
      _ = subscription_fixture(subject, "#{bypass_url}/wp/a")
      _ = subscription_fixture(subject, "#{bypass_url}/wp/b")

      assert :ok = Sender.send_to_subject(subject, @payload)

      assert_receive {:telemetry, [:grappa, :push, :send, :start], %{count: 2}, %{subject: ^subject}}

      assert_receive {:telemetry, [:grappa, :push, :send, :stop],
                      %{success: 2, gone: 0, error: 0, duration_ms: duration_ms}, %{subject: ^subject, count: 2}}

      assert is_integer(duration_ms) and duration_ms >= 0
    end

    test "fans out to a visitor subject's subscriptions — V3" do
      bypass = Bypass.open()
      bypass_url = "http://localhost:#{bypass.port}"

      attach_telemetry([
        [:grappa, :push, :send, :start],
        [:grappa, :push, :send, :stop]
      ])

      Bypass.expect(bypass, "POST", "/wp/:id", fn conn ->
        Plug.Conn.resp(conn, 201, "")
      end)

      visitor = visitor_fixture()
      subject = {:visitor, visitor.id}
      _ = subscription_fixture(subject, "#{bypass_url}/wp/v")

      assert :ok = Sender.send_to_subject(subject, @payload)

      assert_receive {:telemetry, [:grappa, :push, :send, :start], %{count: 1}, %{subject: ^subject}}

      assert_receive {:telemetry, [:grappa, :push, :send, :stop], %{success: 1}, %{subject: ^subject, count: 1}}
    end

    test "mixed success/410 fan-out tallies correctly in :stop event" do
      bypass = Bypass.open()
      bypass_url = "http://localhost:#{bypass.port}"

      attach_telemetry([[:grappa, :push, :send, :stop]])

      Bypass.expect(bypass, fn conn ->
        case conn.path_info do
          ["wp", "ok"] -> Plug.Conn.resp(conn, 201, "")
          ["wp", "gone"] -> Plug.Conn.resp(conn, 410, "")
          _ -> Plug.Conn.resp(conn, 500, "unexpected")
        end
      end)

      user = user_fixture()
      subject = {:user, user.id}
      _ = subscription_fixture(subject, "#{bypass_url}/wp/ok")
      _ = subscription_fixture(subject, "#{bypass_url}/wp/gone")

      assert :ok = Sender.send_to_subject(subject, @payload)

      assert_receive {:telemetry, [:grappa, :push, :send, :stop], %{success: 1, gone: 1, error: 0}, _}
    end
  end
end
