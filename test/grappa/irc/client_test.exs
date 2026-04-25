defmodule Grappa.IRC.ClientTest do
  @moduledoc """
  Integration tests for `Grappa.IRC.Client` using `Grappa.IRCServer` —
  the in-process TCP fake — instead of mocking `:gen_tcp` directly.

  CLAUDE.md "Mock at boundaries (Mox), real dependencies inside.
  ... `Grappa.IRCServer` test helper is an in-process fake IRC server
  for session tests — use it, don't mock `:gen_tcp` directly."
  """
  use ExUnit.Case, async: true

  import ExUnit.CaptureLog

  alias Grappa.IRC.{Client, Message}
  alias Grappa.IRCServer

  # Default handler: ignore everything; tests that need scripted replies
  # supply their own.
  defp passthrough_handler, do: fn state, _ -> {:reply, nil, state} end

  defp start_server(handler \\ passthrough_handler()) do
    {:ok, server} = IRCServer.start_link(handler)
    {server, IRCServer.port(server)}
  end

  defp start_client(port, overrides \\ %{}) do
    opts =
      Map.merge(
        %{
          host: "127.0.0.1",
          port: port,
          tls: false,
          dispatch_to: self(),
          logger_metadata: []
        },
        overrides
      )

    {:ok, client} = Client.start_link(opts)
    client
  end

  describe "outbound: client → server" do
    test "send_line/2 writes the raw bytes to the server socket" do
      {server, port} = start_server()
      client = start_client(port)

      :ok = Client.send_line(client, "PING :foo\r\n")

      assert {:ok, "PING :foo\r\n"} =
               IRCServer.wait_for_line(server, &(&1 == "PING :foo\r\n"))
    end

    test "send_privmsg/3 emits the canonical PRIVMSG framing" do
      {server, port} = start_server()
      client = start_client(port)

      :ok = Client.send_privmsg(client, "#sniffo", "ciao raga")

      assert {:ok, "PRIVMSG #sniffo :ciao raga\r\n"} =
               IRCServer.wait_for_line(server, &String.starts_with?(&1, "PRIVMSG"))
    end

    test "send_join/2 emits JOIN with channel param" do
      {server, port} = start_server()
      client = start_client(port)

      :ok = Client.send_join(client, "#sniffo")

      assert {:ok, "JOIN #sniffo\r\n"} =
               IRCServer.wait_for_line(server, &String.starts_with?(&1, "JOIN"))
    end
  end

  describe "inbound: server → client → dispatch_to" do
    test "single PRIVMSG line dispatched as parsed Message struct" do
      {server, port} = start_server()
      _ = start_client(port)

      # Wait for the client to be connected before feeding (handshake race
      # safety — `feed` is a no-op on nil socket).
      Process.sleep(20)
      IRCServer.feed(server, ":alice!~a@host PRIVMSG #sniffo :hello\r\n")

      assert_receive {:irc,
                      %Message{
                        prefix: {:nick, "alice", "~a", "host"},
                        command: "PRIVMSG",
                        params: ["#sniffo", "hello"]
                      }},
                     1_000
    end

    test "burst of 50 server lines dispatched in order with no loss (active:once re-arm)" do
      {server, port} = start_server()
      _ = start_client(port)

      Process.sleep(20)

      Enum.each(1..50, fn i ->
        IRCServer.feed(server, ":a!~a@h PRIVMSG #x :msg #{i}\r\n")
      end)

      for i <- 1..50 do
        expected = "msg #{i}"

        assert_receive {:irc, %Message{command: "PRIVMSG", params: ["#x", ^expected]}},
                       2_000
      end
    end

    test "mid-line server write coalesced via OS-level packet:line buffering" do
      {server, port} = start_server()
      _ = start_client(port)

      Process.sleep(20)
      IRCServer.feed(server, "PING :fo")
      Process.sleep(50)
      IRCServer.feed(server, "o\r\n")

      assert_receive {:irc, %Message{command: "PING", params: ["foo"]}}, 1_000
    end

    test "malformed inbound line: parse error is logged, client stays alive" do
      {server, port} = start_server()
      client = start_client(port)

      Process.sleep(20)

      log =
        capture_log(fn ->
          IRCServer.feed(server, ":\r\n")
          Process.sleep(100)
        end)

      assert log =~ "irc parse failed"
      assert Process.alive?(client)
    end
  end

  describe "TLS warning" do
    test "tls: true emits Logger.warning about verify_none on init" do
      # We attempt TLS against a plain-TCP fake server. The handshake fails;
      # what we're verifying is that the warning was emitted BEFORE the
      # connection attempt completed. start_link returns `{:error, _}` here,
      # so we trap and ignore the exit.
      {_, port} = start_server()
      Process.flag(:trap_exit, true)

      log =
        capture_log(fn ->
          # The connection will fail or hang; allow either by passing a tiny
          # timeout indirectly via the spawned process death.
          spawn(fn ->
            Client.start_link(%{
              host: "127.0.0.1",
              port: port,
              tls: true,
              dispatch_to: self(),
              logger_metadata: []
            })
          end)

          Process.sleep(200)
        end)

      assert log =~ "verify_none"
    end
  end
end
