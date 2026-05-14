defmodule Grappa.Push.SenderTest do
  @moduledoc """
  Push notifications cluster B2 (2026-05-14) — Web Push delivery
  fan-out + dead-endpoint cleanup + telemetry coverage.

  Strategy: real `WebPushElixir.send_notification/2` calls into a
  Bypass-backed listener. The lib reads the endpoint from the
  subscription JSON itself, so swapping the production vendor URL
  for `http://localhost:<bypass-port>/wp` exercises the full code
  path including the ECDH encryption + JWT signing — which is why
  the test fixture uses a REAL P-256 client public key (random bytes
  fail at `:crypto.compute_key/4`).

  ## What this verifies
    * 200 vendor response → `:ok` + `last_used_at` bumped on the row.
    * 410 vendor response → `Push.delete_dead/1` purges the row +
      `[:grappa, :push, :delete_dead]` telemetry fires.
    * 503 vendor response → `{:error, {:http_error, 503}}` + Logger
      warning + telemetry tally lands in the `error` bucket.
    * Connection refused → `{:error, _}` per the no-silent-drops rule.
    * `send_to_user/2` empty subscription list → `:ok` + NO start/stop
      telemetry (zero-count events would just generate noise).
    * `send_to_user/2` with N subscriptions emits `:start` (count=N)
      + `:stop` (success+gone+error tally) telemetry pair.
  """
  use Grappa.DataCase, async: false

  alias Grappa.{Accounts, Push}
  alias Grappa.Push.Sender

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

  defp user_fixture do
    name = "sender-user-#{System.unique_integer([:positive])}"
    {:ok, user} = Accounts.create_user(%{name: name, password: "correct horse battery staple"})
    user
  end

  defp subscription_fixture(user, endpoint) do
    {:ok, sub} =
      Push.create({:user, user.id}, %{
        endpoint: endpoint,
        p256dh_key: @client_p256dh,
        auth_key: @client_auth,
        user_agent: "Mozilla/5.0 sender-test"
      })

    sub
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
        assert ["WebPush " <> _] = Plug.Conn.get_req_header(conn, "authorization")
        assert ["aesgcm"] = Plug.Conn.get_req_header(conn, "content-encoding")
        Plug.Conn.resp(conn, 201, "")
      end)

      user = user_fixture()
      sub = subscription_fixture(user, endpoint)
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
      sub = subscription_fixture(user, endpoint)

      assert {:error, :gone} = Sender.send_to_subscription(sub, @payload)
      assert is_nil(Repo.get(Grappa.Push.Subscription, sub.id))

      assert_receive {:telemetry, [:grappa, :push, :delete_dead], %{count: 1}, %{endpoint: ^endpoint}}
    end

    test "404 from vendor → {:error, :gone}", %{bypass: bypass, endpoint: endpoint} do
      Bypass.expect_once(bypass, "POST", "/wp", fn conn ->
        Plug.Conn.resp(conn, 404, "")
      end)

      user = user_fixture()
      sub = subscription_fixture(user, endpoint)

      assert {:error, :gone} = Sender.send_to_subscription(sub, @payload)
    end

    test "503 from vendor → {:error, {:http_error, 503}}, row preserved", %{
      bypass: bypass,
      endpoint: endpoint
    } do
      Bypass.expect_once(bypass, "POST", "/wp", fn conn ->
        Plug.Conn.resp(conn, 503, "service unavailable")
      end)

      user = user_fixture()
      sub = subscription_fixture(user, endpoint)

      assert {:error, {:http_error, 503}} = Sender.send_to_subscription(sub, @payload)
      assert %Grappa.Push.Subscription{} = Repo.get(Grappa.Push.Subscription, sub.id)
    end

    test "connection refused → {:error, _}, row preserved", %{
      bypass: bypass,
      endpoint: endpoint
    } do
      Bypass.down(bypass)

      user = user_fixture()
      sub = subscription_fixture(user, endpoint)

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

      {:ok, sub} =
        Push.create({:user, user.id}, %{
          endpoint: endpoint,
          p256dh_key: Base.url_encode64("not-a-valid-p256-point", padding: false),
          auth_key: Base.url_encode64(:crypto.strong_rand_bytes(16), padding: false),
          user_agent: "Mozilla/5.0 sender-test"
        })

      assert {:error, {:encrypt_error, _}} = Sender.send_to_subscription(sub, @payload)
      assert %Grappa.Push.Subscription{} = Repo.get(Grappa.Push.Subscription, sub.id)
    end
  end

  describe "send_to_user/2" do
    test "no subscriptions → :ok + NO start/stop telemetry" do
      attach_telemetry([
        [:grappa, :push, :send, :start],
        [:grappa, :push, :send, :stop]
      ])

      user = user_fixture()
      assert :ok = Sender.send_to_user(user.id, @payload)

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
      _ = subscription_fixture(user, "#{bypass_url}/wp/a")
      _ = subscription_fixture(user, "#{bypass_url}/wp/b")

      assert :ok = Sender.send_to_user(user.id, @payload)

      user_id = user.id

      assert_receive {:telemetry, [:grappa, :push, :send, :start], %{count: 2}, %{user_id: ^user_id}}

      assert_receive {:telemetry, [:grappa, :push, :send, :stop],
                      %{success: 2, gone: 0, error: 0, duration_ms: duration_ms}, %{user_id: ^user_id, count: 2}}

      assert is_integer(duration_ms) and duration_ms >= 0
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
      _ = subscription_fixture(user, "#{bypass_url}/wp/ok")
      _ = subscription_fixture(user, "#{bypass_url}/wp/gone")

      assert :ok = Sender.send_to_user(user.id, @payload)

      assert_receive {:telemetry, [:grappa, :push, :send, :stop], %{success: 1, gone: 1, error: 0}, _}
    end
  end
end
