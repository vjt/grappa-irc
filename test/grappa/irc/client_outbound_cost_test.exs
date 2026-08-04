defmodule Grappa.IRC.ClientOutboundCostTest do
  @moduledoc """
  #800 S7 — the per-frame outbound-cost line `Grappa.IRC.Client` emits.

  This is the diagnostic's only user-visible surface: the measurement is
  taken by reading these lines off a running stack, so a missing field is
  the whole instrument failing silently. It notably pins the
  `config/config.exs` `:metadata` allowlist — a key that is not listed is
  dropped at FORMAT time, which means the code looks right, the test
  looks right, and the operator gets a blank line.

  `async: false` because it lowers the global Logger level to observe a
  :debug line (the test env runs at :warning) — same rationale as
  `Grappa.Accounts.SessionLogHygieneTest`. It lives apart from
  `Grappa.IRC.ClientTest` for exactly that reason: that suite is
  `async: true` and must stay that way.
  """
  use ExUnit.Case, async: false

  import ExUnit.CaptureLog

  alias Grappa.IRC.Client
  alias Grappa.IRCServer

  setup do
    original = Logger.level()
    Logger.configure(level: :debug)
    on_exit(fn -> Logger.configure(level: original) end)
    :ok
  end

  defp start_pair do
    {:ok, server} = IRCServer.start_link(fn state, _ -> {:reply, nil, state} end)

    {:ok, client} =
      Client.start_link(%{
        host: "127.0.0.1",
        port: IRCServer.port(server),
        tls: false,
        dispatch_to: self(),
        logger_metadata: [],
        nick: "grappa-test",
        ident: "grappa-test",
        realname: "grappa-test",
        sasl_user: "grappa-test",
        auth_method: :none
      })

    {server, client}
  end

  test "reports the modelled bank AND the distance from the drain gate" do
    # Two numbers, not one. #800 claims the cost bites only on a
    # connection already near the ceiling — that is a claim about the
    # HEADROOM, and a bank printed on its own cannot settle it either way.
    {server, client} = start_pair()

    log =
      capture_log(fn ->
        :ok = Client.send_line(client, "PING :probe\r\n")
        {:ok, _} = IRCServer.wait_for_line(server, &(&1 == "PING :probe\r\n"), 1_000)
      end)

    assert log =~ "upstream send"
    assert log =~ "command=PING"
    assert log =~ "sent_bytes=13"
    assert log =~ "commands_10s="
    assert log =~ "penalty_10s_s="
    assert log =~ "bank_model_s="
    assert log =~ "headroom_s="
  end

  test "counts the handshake frames too, so the bank is not read off a fresh slate" do
    # The registration burst is on the same connection and costs the same
    # bank. A model that starts counting at the session's first command
    # would under-report, and an under-report is what would retire the
    # fake-lag hypothesis for the wrong reason.
    log =
      capture_log(fn ->
        {server, _} = start_pair()
        {:ok, _} = IRCServer.wait_for_line(server, &String.starts_with?(&1, "USER "), 1_000)
      end)

    assert log =~ "command=NICK"
    assert log =~ "command=USER"
  end

  test "never puts the parameters of a frame on the log line" do
    {server, client} = start_pair()

    log =
      capture_log(fn ->
        :ok = Client.send_line(client, "PRIVMSG #chan :sensitive body\r\n")
        {:ok, _} = IRCServer.wait_for_line(server, &String.starts_with?(&1, "PRIVMSG"), 1_000)
      end)

    assert log =~ "command=PRIVMSG"
    refute log =~ "sensitive body"
    refute log =~ "#chan"
  end
end
