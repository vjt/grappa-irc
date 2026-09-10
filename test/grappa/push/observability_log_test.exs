defmodule Grappa.Push.ObservabilityLogTest do
  @moduledoc """
  issue 2067 — the two push paths that used to say nothing at all.

  A self-hoster with no push on iOS read an empty `journalctl -u grappa |
  grep push` as "the sender was never called". It had been called, and had
  delivered; what was missing was any line saying so. The sibling silence is
  the #182 foreground gate, which withholds a fan-out without recording that
  it did — making a WITHHELD push indistinguishable from one that never
  triggered.

  `async: false`, and it lowers the global Logger level, because both lines
  sit at `:info` while `config/test.exs` runs the suite at `:warning`. Same
  rationale — and the same own-file requirement — as
  `client_tls_posture_log_test.exs` and the `#1416` describe in
  `user_socket_test.exs`: the level is process-global, so a concurrent test
  would see it move under itself.

  This file owns only what the operator READS. The delivery and gate
  BEHAVIOUR stays in `sender_test.exs` / `triggers_test.exs`, and the
  suppression COUNTER is asserted there too, beside the send events it has
  to be told apart from.

  Asserting the RENDERED output rather than the call site is the whole
  point: the `config/config.exs` `:metadata` allowlist drops an undeclared
  key at FORMAT time, so a line can compile, fire, and still print bare.
  Only a capture can tell those two apart.
  """
  use Grappa.DataCase, async: false

  import ExUnit.CaptureLog
  import Grappa.AuthFixtures, only: [user_fixture: 0]

  alias Grappa.{Push, WSPresence}
  alias Grappa.Push.{Sender, Triggers}
  alias Grappa.Scrollback.Message

  # Real P-256 client public key + 16-byte auth secret (mirrors
  # `sender_test.exs`). The ECDH path raises on random bytes BEFORE the
  # POST, which would mask the very line under test.
  @client_p256dh "BCfaYE5dGabdzef68MI0SN24b4Gsf1t_N3ftUlWaFGzkuudjHLor0CRjosM3c7SLZ7PfFufpsFUh8vsO1t8wCHs"
  @client_auth "3aw2ceVFv0OIBXxAvkAlSA"

  @payload %{
    title: "vjt",
    body: "ping in #sbiffo",
    tag: "libera:#sbiffo",
    url: "/?network=libera&channel=%23sbiffo"
  }

  setup do
    original = Logger.level()
    Logger.configure(level: :info)
    on_exit(fn -> Logger.configure(level: original) end)
    :ok
  end

  defp mention_message do
    %Message{
      id: 1,
      channel: "#sniffo",
      sender: "alice",
      body: "vjt: ping",
      kind: :privmsg,
      server_time: 1_700_000_000_000
    }
  end

  defp attach_telemetry(events) do
    test_pid = self()
    handler_id = "push-observability-#{System.unique_integer([:positive])}"

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

  describe "Sender.send_to_subscription/2 — the delivered line" do
    test "a vendor 2xx leaves a log line naming the endpoint" do
      bypass = Bypass.open()
      endpoint = "http://localhost:#{bypass.port}/wp"
      Bypass.expect_once(bypass, "POST", "/wp", fn conn -> Plug.Conn.resp(conn, 201, "") end)

      user = user_fixture()

      {:ok, sub} =
        Push.create({:user, user.id}, %{
          endpoint: endpoint,
          p256dh_key: @client_p256dh,
          auth_key: @client_auth,
          user_agent: "Mozilla/5.0 observability-test"
        })

      log =
        capture_log(fn ->
          assert :ok = Sender.send_to_subscription(sub, @payload)
          Logger.flush()
        end)

      assert log =~ "push.send delivered"
      assert log =~ "endpoint=#{endpoint}"
    end
  end

  describe "Triggers — the suppression line" do
    setup do
      :ok = WSPresence.reset_for_test()
      :ok
    end

    # The dispatch runs in a detached Task, so the capture has to stay open
    # until the line is out. `report_suppressed/2` logs BEFORE it counts, so
    # observing the counter proves the Logger message is already sent and
    # `Logger.flush/0` can finish the job — no sleep, no poll.
    defp capture_suppression(fun) do
      attach_telemetry([[:grappa, :push, :suppressed]])

      capture_log(fn ->
        assert :ok = fun.()
        assert_receive {:telemetry, [:grappa, :push, :suppressed], _, _}, 2_000
        Logger.flush()
      end)
    end

    test "a withheld message fan-out names the reason and the subject" do
      user = user_fixture()
      subject = {:user, user.id}

      device = spawn(fn -> Process.sleep(:infinity) end)
      :ok = WSPresence.register(user.name, device)
      :ok = WSPresence.set_visibility(user.name, device, true)
      assert WSPresence.any_visible?(user.name)

      log =
        capture_suppression(fn ->
          Triggers.evaluate_and_dispatch(mention_message(), %{
            subject: subject,
            subject_label: user.name,
            network_slug: "libera",
            own_nick: "vjt"
          })
        end)

      assert log =~ "push.trigger suppressed"
      assert log =~ "reason=foreground_visible"
      assert log =~ "network=libera"
      assert log =~ "subject_kind=user"
      assert log =~ "user_id=#{user.id}"

      Process.exit(device, :kill)
    end

    test "a withheld presence push names the same reason and a visitor subject" do
      visitor = visitor_fixture()
      subject = {:visitor, visitor.id}
      label = "visitor:" <> visitor.id

      {:ok, _} =
        Grappa.UserSettings.put_notification_prefs(
          subject,
          Map.put(Grappa.UserSettings.default_notification_prefs(), :presence_online, true)
        )

      device = spawn(fn -> Process.sleep(:infinity) end)
      :ok = WSPresence.register(label, device)
      :ok = WSPresence.set_visibility(label, device, true)
      assert WSPresence.any_visible?(label)

      log =
        capture_suppression(fn ->
          Triggers.dispatch_presence("alice", :online, :transition, %{
            subject: subject,
            subject_label: label,
            network_slug: "azzurra",
            own_nick: "vjt"
          })
        end)

      assert log =~ "push.trigger suppressed"
      assert log =~ "reason=foreground_visible"
      assert log =~ "network=azzurra"
      assert log =~ "subject_kind=visitor"
      assert log =~ "visitor_id=#{visitor.id}"

      Process.exit(device, :kill)
    end
  end

  defp visitor_fixture do
    nick = "push-obs-visitor-#{System.unique_integer([:positive])}"
    {:ok, _} = Grappa.Networks.find_or_create_network(%{slug: "azzurra"})
    {:ok, v} = Grappa.Visitors.find_or_provision_anon(nick, "azzurra", "127.0.0.1")
    v
  end
end
