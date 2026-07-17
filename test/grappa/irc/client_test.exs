defmodule Grappa.IRC.ClientTest do
  @moduledoc """
  Integration tests for `Grappa.IRC.Client` using `Grappa.IRCServer` —
  the in-process TCP fake — instead of mocking `:gen_tcp` directly.

  CLAUDE.md "Mock at boundaries (Mox), real dependencies inside.
  ... `Grappa.IRCServer` test helper is an in-process fake IRC server
  for session tests — use it, don't mock `:gen_tcp` directly."

  ## Sub-task 2f: auth state machine

  `Client.init/1` now drives the full upstream handshake (PASS, CAP LS,
  NICK, USER, AUTHENTICATE, CAP END) per the per-credential
  `auth_method` ∈ `:auto | :sasl | :server_pass | :nickserv_identify |
  :none`. The 8 auth-path tests below cover each branch + the
  Bahamut/Azzurra PASS-handoff case (CAP unsupported on legacy ircd) +
  the very-old-ircd case where `001` arrives before any CAP reply.
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

  # Bind ephemeral port, capture number, release immediately. The kernel
  # may eventually reuse it; the C2 non-blocking-init test only needs the
  # port to be unbound for the ~10ms it takes the connect to refuse.
  defp pick_unused_port do
    {:ok, l} = :gen_tcp.listen(0, [])
    {:ok, port} = :inet.port(l)
    :gen_tcp.close(l)
    port
  end

  defp start_client(port, overrides \\ %{}) do
    opts =
      Map.merge(
        %{
          host: "127.0.0.1",
          port: port,
          tls: false,
          dispatch_to: self(),
          logger_metadata: [],
          nick: "grappa-test",
          ident: "grappa-test",
          realname: "grappa-test",
          sasl_user: "grappa-test",
          auth_method: :none
        },
        overrides
      )

    {:ok, client} = Client.start_link(opts)
    client
  end

  # Synchronisation helper: blocks until the Client has finished its
  # initial handshake (NICK/USER guaranteed to be the last lines of
  # the always-sent prefix). Eliminates the `Process.sleep(20)` pattern
  # that races on the IRCServer's accept-loop sock assignment.
  defp await_handshake(server) do
    {:ok, _} = IRCServer.wait_for_line(server, &String.starts_with?(&1, "USER "), 1_000)
    :ok
  end

  # Handler that replies CAP * LS :sasl=PLAIN to a CAP LS, ACKs the
  # CAP REQ :sasl, prompts AUTHENTICATE PLAIN with `+`, and answers
  # the base64 payload with the configured numeric (903 by default).
  defp sasl_handler(numeric \\ "903 grappa-test :SASL ok") do
    fn state, line ->
      cond do
        String.starts_with?(line, "CAP LS") ->
          {:reply, ":server CAP * LS :sasl=PLAIN\r\n", state}

        String.starts_with?(line, "CAP REQ") ->
          {:reply, ":server CAP * ACK :sasl\r\n", state}

        line == "AUTHENTICATE PLAIN\r\n" ->
          {:reply, "AUTHENTICATE +\r\n", state}

        String.starts_with?(line, "AUTHENTICATE ") ->
          {:reply, ":server #{numeric}\r\n", state}

        String.starts_with?(line, "CAP END") ->
          # Pretend registration completes after CAP END.
          {:reply, ":server 001 grappa-test :Welcome\r\n", state}

        true ->
          {:reply, nil, state}
      end
    end
  end

  # Bahamut/Azzurra: legacy ircd that doesn't grok CAP. Server replies
  # 421 and proceeds to register the client (PASS already consumed at
  # registration time triggers server-side NickServ IDENTIFY).
  defp bahamut_handler do
    fn state, line ->
      cond do
        String.starts_with?(line, "CAP LS") ->
          {:reply, ":server 421 * CAP :Unknown command\r\n", state}

        String.starts_with?(line, "USER ") ->
          {:reply, ":server 001 grappa-test :Welcome\r\n", state}

        true ->
          {:reply, nil, state}
      end
    end
  end

  # Plain RFC 2812 server: no CAP, fires 001 once USER arrives.
  defp rfc_handler do
    fn state, line ->
      if String.starts_with?(line, "USER ") do
        {:reply, ":server 001 grappa-test :Welcome\r\n", state}
      else
        {:reply, nil, state}
      end
    end
  end

  describe "outbound: client → server" do
    test "send_line/2 writes the raw bytes to the server socket" do
      {server, port} = start_server()
      client = start_client(port)

      :ok = Client.send_line(client, "PING :foo\r\n")

      assert {:ok, "PING :foo\r\n"} =
               IRCServer.wait_for_line(server, &(&1 == "PING :foo\r\n"), 1_000)
    end

    test "send_line/2 appends CRLF when caller forgot it" do
      # CP23 cluster `code-reload` lesson: the CTCP VERSION reply effect
      # shipped a NOTICE without a trailing \r\n; the second outbound
      # frame concatenated and corrupted the wire. ensure_crlf at the
      # transport boundary makes the helper safe-by-default — every line
      # that hits the socket has CRLF, regardless of caller hygiene.
      {server, port} = start_server()
      client = start_client(port)

      :ok = Client.send_line(client, "PING :no-crlf")

      assert {:ok, "PING :no-crlf\r\n"} =
               IRCServer.wait_for_line(server, &String.starts_with?(&1, "PING"), 1_000)
    end

    test "send_line/2 normalises bare LF to CRLF" do
      # Some sources (HTTP-derived headers, hand-typed payloads) end with
      # bare \n. IRC framing requires \r\n; the transport boundary fixes
      # the LF→CRLF mismatch instead of writing a malformed frame.
      {server, port} = start_server()
      client = start_client(port)

      :ok = Client.send_line(client, "PING :bare-lf\n")

      assert {:ok, "PING :bare-lf\r\n"} =
               IRCServer.wait_for_line(server, &String.starts_with?(&1, "PING"), 1_000)
    end

    test "send_privmsg/3 emits the canonical PRIVMSG framing" do
      {server, port} = start_server()
      client = start_client(port)

      :ok = Client.send_privmsg(client, "#sniffo", "ciao raga")

      assert {:ok, "PRIVMSG #sniffo :ciao raga\r\n"} =
               IRCServer.wait_for_line(server, &String.starts_with?(&1, "PRIVMSG"), 1_000)
    end

    test "send_join/3 emits JOIN with channel param (no key)" do
      {server, port} = start_server()
      client = start_client(port)

      :ok = Client.send_join(client, "#sniffo", nil)

      assert {:ok, "JOIN #sniffo\r\n"} =
               IRCServer.wait_for_line(server, &String.starts_with?(&1, "JOIN"), 1_000)
    end

    # UX-4 bucket F: +k channel-key support.
    test "send_join/3 emits JOIN with channel + key when key is non-nil" do
      {server, port} = start_server()
      client = start_client(port)

      :ok = Client.send_join(client, "#sniffo", "secret")

      assert {:ok, "JOIN #sniffo secret\r\n"} =
               IRCServer.wait_for_line(server, &String.starts_with?(&1, "JOIN"), 1_000)
    end

    test "send_join/3 with empty-string key emits the no-key form" do
      {server, port} = start_server()
      client = start_client(port)

      :ok = Client.send_join(client, "#sniffo", "")

      assert {:ok, "JOIN #sniffo\r\n"} =
               IRCServer.wait_for_line(server, &String.starts_with?(&1, "JOIN"), 1_000)
    end

    test "send_topic/3 emits TOPIC #chan :body framing" do
      {server, port} = start_server()
      client = start_client(port)

      :ok = Client.send_topic(client, "#italia", "ciao mondo")

      assert {:ok, "TOPIC #italia :ciao mondo\r\n"} =
               IRCServer.wait_for_line(server, &String.starts_with?(&1, "TOPIC "), 1_000)
    end

    test "send_nick/2 emits NICK new\\r\\n" do
      {server, port} = start_server()
      client = start_client(port)
      :ok = await_handshake(server)

      :ok = Client.send_nick(client, "vjt-away")

      assert {:ok, "NICK vjt-away\r\n"} =
               IRCServer.wait_for_line(server, &(&1 == "NICK vjt-away\r\n"), 1_000)
    end

    # cluster #9 (resp-A4 close): typed helpers for KICK / INVITE /
    # banlist-query / umode / topic-clear. Each helper validates its
    # identifier args via `Grappa.IRC.Identifier` predicates and
    # returns `{:error, :invalid_line}` on rejection — same boundary
    # discipline as the helpers above. Mirrors the
    # `Grappa.Session.Server` arms that previously open-coded
    # `Client.send_line(client, "<RAW>\r\n")`.

    test "send_kick/4 emits KICK #chan nick :reason framing" do
      {server, port} = start_server()
      client = start_client(port)

      :ok = Client.send_kick(client, "#sniffo", "alice", "bad behaviour")

      assert {:ok, "KICK #sniffo alice :bad behaviour\r\n"} =
               IRCServer.wait_for_line(server, &String.starts_with?(&1, "KICK"), 1_000)
    end

    test "send_kick/4 rejects malformed channel with {:error, :invalid_line}" do
      {_, port} = start_server()
      client = start_client(port)

      assert {:error, :invalid_line} =
               Client.send_kick(client, "no-prefix", "alice", "reason")
    end

    test "send_kick/4 rejects malformed nick with {:error, :invalid_line}" do
      {_, port} = start_server()
      client = start_client(port)

      assert {:error, :invalid_line} =
               Client.send_kick(client, "#sniffo", "bad nick with space", "reason")
    end

    test "send_kick/4 rejects CR/LF/NUL in reason with {:error, :invalid_line}" do
      {_, port} = start_server()
      client = start_client(port)

      assert {:error, :invalid_line} =
               Client.send_kick(client, "#sniffo", "alice", "reason\r\nQUIT")
    end

    test "send_invite/3 emits INVITE nick #chan framing (RFC 2812 order)" do
      {server, port} = start_server()
      client = start_client(port)

      :ok = Client.send_invite(client, "#sniffo", "alice")

      assert {:ok, "INVITE alice #sniffo\r\n"} =
               IRCServer.wait_for_line(server, &String.starts_with?(&1, "INVITE"), 1_000)
    end

    test "send_invite/3 rejects malformed channel with {:error, :invalid_line}" do
      {_, port} = start_server()
      client = start_client(port)

      assert {:error, :invalid_line} =
               Client.send_invite(client, "no-prefix", "alice")
    end

    test "send_invite/3 rejects malformed nick with {:error, :invalid_line}" do
      {_, port} = start_server()
      client = start_client(port)

      assert {:error, :invalid_line} =
               Client.send_invite(client, "#sniffo", "bad nick")
    end

    test "send_banlist/2 emits MODE #chan b framing" do
      {server, port} = start_server()
      client = start_client(port)

      :ok = Client.send_banlist(client, "#sniffo")

      assert {:ok, "MODE #sniffo b\r\n"} =
               IRCServer.wait_for_line(server, &(&1 == "MODE #sniffo b\r\n"), 1_000)
    end

    test "send_banlist/2 rejects malformed channel with {:error, :invalid_line}" do
      {_, port} = start_server()
      client = start_client(port)

      assert {:error, :invalid_line} = Client.send_banlist(client, "no-prefix")
    end

    test "send_channel_modes/2 emits bare MODE #chan query framing" do
      {server, port} = start_server()
      client = start_client(port)

      :ok = Client.send_channel_modes(client, "#sniffo")

      assert {:ok, "MODE #sniffo\r\n"} =
               IRCServer.wait_for_line(server, &(&1 == "MODE #sniffo\r\n"), 1_000)
    end

    test "send_channel_modes/2 rejects malformed channel with {:error, :invalid_line}" do
      {_, port} = start_server()
      client = start_client(port)

      assert {:error, :invalid_line} = Client.send_channel_modes(client, "no-prefix")
    end

    test "send_umode/3 emits MODE nick modes framing" do
      {server, port} = start_server()
      client = start_client(port)

      :ok = Client.send_umode(client, "vjt", "+i")

      assert {:ok, "MODE vjt +i\r\n"} =
               IRCServer.wait_for_line(server, &(&1 == "MODE vjt +i\r\n"), 1_000)
    end

    test "send_umode/3 rejects malformed nick with {:error, :invalid_line}" do
      {_, port} = start_server()
      client = start_client(port)

      assert {:error, :invalid_line} = Client.send_umode(client, "bad nick", "+i")
    end

    test "send_umode/3 rejects CR/LF/NUL in modes with {:error, :invalid_line}" do
      {_, port} = start_server()
      client = start_client(port)

      assert {:error, :invalid_line} = Client.send_umode(client, "vjt", "+i\r\nQUIT")
    end

    test "send_umode_query/2 emits bare MODE nick query framing (#229)" do
      {server, port} = start_server()
      client = start_client(port)

      :ok = Client.send_umode_query(client, "vjt")

      assert {:ok, "MODE vjt\r\n"} =
               IRCServer.wait_for_line(server, &(&1 == "MODE vjt\r\n"), 1_000)
    end

    test "send_umode_query/2 rejects malformed nick with {:error, :invalid_line}" do
      {_, port} = start_server()
      client = start_client(port)

      assert {:error, :invalid_line} = Client.send_umode_query(client, "bad nick")
    end

    test "send_names/2 emits NAMES #chan framing" do
      {server, port} = start_server()
      client = start_client(port)

      :ok = Client.send_names(client, "#sniffo")

      assert {:ok, "NAMES #sniffo\r\n"} =
               IRCServer.wait_for_line(server, &(&1 == "NAMES #sniffo\r\n"), 1_000)
    end

    test "send_names/2 rejects malformed channel with {:error, :invalid_line}" do
      {_, port} = start_server()
      client = start_client(port)

      assert {:error, :invalid_line} = Client.send_names(client, "no-prefix")
    end

    # #221 — /who <mask>. WHO accepts a channel OR a host/nick mask (RFC 2812
    # §3.6.1). Pre-#221 send_who gated on valid_channel?, so a mask was
    # rejected outbound and never reached upstream — the first break in the
    # "total silence" chain. The gate is now safe_oper_token? (single wire
    # token, no whitespace/CRLF/NUL) so a mask forwards but injection can't.
    test "send_who/2 emits WHO #chan framing (channel target)" do
      {server, port} = start_server()
      client = start_client(port)

      :ok = Client.send_who(client, "#sniffo")

      assert {:ok, "WHO #sniffo\r\n"} =
               IRCServer.wait_for_line(server, &(&1 == "WHO #sniffo\r\n"), 1_000)
    end

    test "send_who/2 emits WHO framing for a host mask (#221)" do
      {server, port} = start_server()
      client = start_client(port)

      :ok = Client.send_who(client, "*!*@*.libera.chat")

      assert {:ok, "WHO *!*@*.libera.chat\r\n"} =
               IRCServer.wait_for_line(server, &(&1 == "WHO *!*@*.libera.chat\r\n"), 1_000)
    end

    test "send_who/2 rejects a whitespace-splicing mask with {:error, :invalid_line}" do
      {_, port} = start_server()
      client = start_client(port)

      # A space would splice extra WHO wire slots; CRLF would inject a
      # follow-up command. Both rejected by the single-token gate.
      assert {:error, :invalid_line} = Client.send_who(client, "*!*@x y")
      assert {:error, :invalid_line} = Client.send_who(client, "#chan\r\nQUIT")
    end

    test "send_who/2 rejects an empty target with {:error, :invalid_line}" do
      {_, port} = start_server()
      client = start_client(port)

      assert {:error, :invalid_line} = Client.send_who(client, "")
    end

    test "send_topic_clear/2 emits TOPIC #chan : framing (empty trailing param)" do
      {server, port} = start_server()
      client = start_client(port)

      :ok = Client.send_topic_clear(client, "#italia")

      assert {:ok, "TOPIC #italia :\r\n"} =
               IRCServer.wait_for_line(server, &(&1 == "TOPIC #italia :\r\n"), 1_000)
    end

    test "send_topic_clear/2 rejects malformed channel with {:error, :invalid_line}" do
      {_, port} = start_server()
      client = start_client(port)

      assert {:error, :invalid_line} = Client.send_topic_clear(client, "no-prefix")
    end

    # U cluster cleanup: dead-socket SEND must NOT raise. Pre-fix
    # `handle_call({:send, _}, _, state)` did `:ok = transport_send(state, ...)`
    # which raises `MatchError` on `{:error, :closed}` from a closed-non-nil
    # socket, and `transport_send` itself raised `FunctionClauseError` from
    # `:gen_tcp.send/2` on a nil socket. Either crash cascaded into the
    # caller (`Session.Server.terminate/2`), whose narrow exit-catch list
    # at lib/grappa/session/server.ex:660-677 missed the wrapped
    # `MatchError` shape — so terminate/2 propagated, the supervisor
    # blocked for 5s per dying child, and CI's
    # `AdmissionStateHelpers.reset_session_supervisor` exhausted its 15s
    # registry-clear budget. Origin: U-5 CI failure on commit 010054d,
    # run 25975442301, BootstrapTest:506 + class siblings.
    test "send_line/2 returns {:error, :closed} when socket is closed-but-not-nil (no raise)" do
      {server, port} = start_server()
      client = start_client(port)
      :ok = await_handshake(server)

      # Snapshot the live socket, close it underneath the Client, then
      # send. handle_call({:send, _}, _, state) hands the closed-but-
      # non-nil socket to `:gen_tcp.send/2`, which returns
      # `{:error, :closed}`. Pre-fix the `:ok = transport_send(...)`
      # pattern in handle_call raised MatchError on this; post-fix the
      # honest error tuple comes back to the caller.
      state = :sys.get_state(client)
      :ok = :gen_tcp.close(state.socket)

      result =
        try do
          Client.send_line(client, "PING :should-not-raise\r\n")
        catch
          kind, payload -> {:caught, kind, payload}
        end

      assert match?({:error, _}, result),
             "expected {:error, _}, got #{inspect(result)}"

      assert Process.alive?(client),
             "IRC.Client crashed instead of returning {:error, _}"
    end

    test "send_quit/2 returns {:error, _} when socket is nil (no raise)" do
      # Reproduces the BootstrapTest CI flake mechanism: a
      # Session.Server's terminate/2 calls Client.send_quit on a
      # Client whose `state.socket` was already nilled by a prior
      # `:tcp_closed` info message (connect succeeded, then the
      # upstream went away). The Client must return {:error, _}, NOT
      # raise — otherwise Session.Server.terminate/2's caller exit
      # blocks the supervisor for 5s per child under load.
      #
      # We inject `socket: nil` via `:sys.replace_state` rather than
      # racing connect_failed (which would crash the linked Client
      # before we could send anything).
      {server, port} = start_server()
      client = start_client(port)
      :ok = await_handshake(server)

      :sys.replace_state(client, fn state -> %{state | socket: nil} end)

      result =
        try do
          Client.send_quit(client, "test shutting down")
        catch
          kind, payload -> {:caught, kind, payload}
        end

      assert match?({:error, _}, result),
             "expected {:error, _}, got #{inspect(result)}"

      assert Process.alive?(client),
             "IRC.Client crashed instead of returning {:error, _}"
    end

    # Bundle C (#20 follow-up)
    test "send_oper/3 emits OPER <name> <password>\\r\\n" do
      {server, port} = start_server()
      client = start_client(port)

      :ok = Client.send_oper(client, "vjt", "s3cret")

      assert {:ok, "OPER vjt s3cret\r\n"} =
               IRCServer.wait_for_line(server, &String.starts_with?(&1, "OPER"), 1_000)
    end

    test "send_raw/2 ships the line verbatim with trailing CRLF" do
      {server, port} = start_server()
      client = start_client(port)

      :ok = Client.send_raw(client, "PING :foo.bar")

      assert {:ok, "PING :foo.bar\r\n"} =
               IRCServer.wait_for_line(server, &String.starts_with?(&1, "PING"), 1_000)
    end
  end

  describe "outbound source-address bind" do
    test "binds a v4 source — server observes the bound peer, not the default" do
      # Source 127.0.0.2 is a distinct loopback address from the default
      # 127.0.0.1, so the observed peer proves the ifaddr bind took effect.
      # Assumes 127.0.0.2 is loopback-bindable (Linux/RPi: all 127/8 is
      # loopback; a non-Linux host would fail legibly with :eaddrnotavail).
      {:ok, server} = IRCServer.start_link(fn state, _ -> {:reply, nil, state} end)
      port = IRCServer.port(server)

      _ = start_client(port, %{source_address: "127.0.0.2"})
      :ok = await_handshake(server)

      assert {:ok, {{127, 0, 0, 2}, _}} = IRCServer.peername(server)
    end

    test "NULL source still connects via the pool/kernel-default path" do
      {:ok, server} = IRCServer.start_link(fn state, _ -> {:reply, nil, state} end)
      port = IRCServer.port(server)

      _ = start_client(port, %{source_address: nil})
      :ok = await_handshake(server)

      assert {:ok, {{127, 0, 0, 1}, _}} = IRCServer.peername(server)
    end

    test "source_bind/2: v4 source yields inet family + ifaddr tuple" do
      assert {:ok, {[ifaddr: {127, 0, 0, 2}], :inet}} =
               Client.__source_bind_for_test__(~c"127.0.0.1", "127.0.0.2")
    end

    test "source_bind/2: v6 source yields inet6 family + ifaddr tuple" do
      assert {:ok, {[ifaddr: {0, 0, 0, 0, 0, 0, 0, 1}], :inet6}} =
               Client.__source_bind_for_test__(~c"::1", "::1")
    end

    test "source_bind/2: source family vs upstream-only-other-family is a clear error" do
      assert {:error, {:source_family_mismatch, "::1", "127.0.0.1", :inet6}} =
               Client.__source_bind_for_test__(~c"127.0.0.1", "::1")
    end

    test "source_bind/2: NULL source delegates to the pool path (inet, no ifaddr)" do
      assert {:ok, {[], :inet}} = Client.__source_bind_for_test__(~c"127.0.0.1", nil)
    end
  end

  describe "inbound: server → client → dispatch_to" do
    test "single PRIVMSG line dispatched as parsed Message struct" do
      {server, port} = start_server()
      _ = start_client(port)
      :ok = await_handshake(server)

      IRCServer.feed(server, ":alice!~a@host PRIVMSG #sniffo :hello\r\n")

      assert_receive {:irc,
                      %Message{
                        prefix: {:nick, "alice", "~a", "host"},
                        command: :privmsg,
                        params: ["#sniffo", "hello"]
                      }},
                     1_000
    end

    test "burst of 50 server lines dispatched in order with no loss (active:once re-arm)" do
      {server, port} = start_server()
      _ = start_client(port)
      :ok = await_handshake(server)

      Enum.each(1..50, fn i ->
        IRCServer.feed(server, ":a!~a@h PRIVMSG #x :msg #{i}\r\n")
      end)

      for i <- 1..50 do
        expected = "msg #{i}"

        assert_receive {:irc, %Message{command: :privmsg, params: ["#x", ^expected]}},
                       2_000
      end
    end

    test "mid-line server write coalesced via OS-level packet:line buffering" do
      {server, port} = start_server()
      _ = start_client(port)
      :ok = await_handshake(server)

      IRCServer.feed(server, "PING :fo")
      # Intentional sleep: half a line in, force the OS-level packet:line
      # buffer to coalesce across two TCP segments. Replacing this would
      # defeat the point of the test (the framing race we're checking is
      # specifically time-separated bytes on the same logical line).
      Process.sleep(50)
      IRCServer.feed(server, "o\r\n")

      assert_receive {:irc, %Message{command: :ping, params: ["foo"]}}, 1_000
    end

    test "malformed inbound line: parse error is logged, client stays alive" do
      {server, port} = start_server()
      client = start_client(port)
      :ok = await_handshake(server)

      log =
        capture_log(fn ->
          IRCServer.feed(server, ":\r\n")
          Process.sleep(100)
        end)

      assert log =~ "irc parse failed"
      assert Process.alive?(client)
    end
  end

  describe "TLS posture (#89 verify_peer)" do
    # #89 replaced the Phase-1 `verify: :verify_none` expedient with full
    # CA-chain verification. These tests pin the ssl opts SHAPE via the
    # `__tls_connect_opts_for_test__/1` seam (mirrors
    # `__source_bind_for_test__/2`). A real verify_peer handshake to
    # azzurra was proven out-of-band against the live prod node before the
    # flip (issue #89 cert-probe comment) — the certs chain to a public CA
    # (Let's Encrypt → ISRG Root) with `irc.azzurra.chat` in every
    # round-robin member's SAN.
    test "TLS opts carry verify_peer against the system CA store" do
      opts = Client.__tls_connect_opts_for_test__(~c"irc.azzurra.chat")

      assert Keyword.fetch!(opts, :verify) == :verify_peer
      # System trust store loaded via OTP's :public_key.cacerts_get/0 — a
      # non-empty anchor list is the honest signal the store resolved.
      cacerts = Keyword.fetch!(opts, :cacerts)
      assert is_list(cacerts) and cacerts != []
      # NEVER ship verify_none — that was the Phase-1 lockout-free expedient
      # this issue closes.
      refute Keyword.get(opts, :verify) == :verify_none
    end

    test "TLS opts pin SNI + hostname check to the connect host" do
      opts = Client.__tls_connect_opts_for_test__(~c"irc.azzurra.chat")

      # SNI must be the host we dialed so the round-robin pool serves the
      # cert whose SAN covers irc.azzurra.chat.
      assert Keyword.fetch!(opts, :server_name_indication) == ~c"irc.azzurra.chat"

      # Hostname verification is mandatory — a valid-but-wrong-host cert
      # (MITM with any CA-signed leaf) must be rejected. The https match_fun
      # does SAN/CN matching per RFC 6125. Assert the value IS the 2-arity
      # match fun, not merely that the key exists — a `match_fun: nil` or a
      # swap away from the :https fun would slip past a key-presence check.
      match = Keyword.fetch!(opts, :customize_hostname_check)
      assert is_function(Keyword.fetch!(match, :match_fun), 2)
    end

    test "TLS opts bound chain depth" do
      opts = Client.__tls_connect_opts_for_test__(~c"irc.azzurra.chat")
      # Pin the exact depth — azzurra's chain is leaf → LE intermediate →
      # ISRG root (depth 2); a regression that loosened this (e.g. the OTP
      # default 10, or 100) would pass an `is_integer/1` check but widen the
      # accepted chain length. `== 3` is the contract.
      assert Keyword.fetch!(opts, :depth) == 3
    end
  end

  describe "auth_method: :none" do
    test "sends only NICK + USER; no PASS, no CAP, no IDENTIFY" do
      {server, port} = start_server(rfc_handler())
      _ = start_client(port, %{auth_method: :none})

      assert {:ok, _} =
               IRCServer.wait_for_line(server, &String.starts_with?(&1, "USER "), 1_000)

      lines = IRCServer.sent_lines(server)
      refute Enum.any?(lines, &String.starts_with?(&1, "PASS"))
      refute Enum.any?(lines, &String.starts_with?(&1, "CAP"))
      refute Enum.any?(lines, &String.starts_with?(&1, "AUTHENTICATE"))
    end
  end

  describe "auth_method: :server_pass" do
    test "sends PASS BEFORE NICK + USER; no CAP" do
      {server, port} = start_server(rfc_handler())

      _ =
        start_client(port, %{
          auth_method: :server_pass,
          password: "swordfish"
        })

      assert {:ok, _} =
               IRCServer.wait_for_line(server, &String.starts_with?(&1, "USER "), 1_000)

      lines = IRCServer.sent_lines(server)
      pass_idx = Enum.find_index(lines, &String.starts_with?(&1, "PASS"))
      nick_idx = Enum.find_index(lines, &String.starts_with?(&1, "NICK"))
      user_idx = Enum.find_index(lines, &String.starts_with?(&1, "USER"))

      assert pass_idx != nil
      assert pass_idx < nick_idx
      assert nick_idx < user_idx
      assert Enum.at(lines, pass_idx) == "PASS swordfish\r\n"
      refute Enum.any?(lines, &String.starts_with?(&1, "CAP"))
    end
  end

  describe "auth_method: :nickserv_identify" do
    test "sends NICK + USER with no CAP; on 001 sends PRIVMSG NickServ :IDENTIFY pwd" do
      {server, port} = start_server(rfc_handler())

      _ =
        start_client(port, %{
          auth_method: :nickserv_identify,
          password: "swordfish"
        })

      assert {:ok, _} =
               IRCServer.wait_for_line(
                 server,
                 &(&1 == "PRIVMSG NickServ :IDENTIFY swordfish\r\n"),
                 1_000
               )

      lines = IRCServer.sent_lines(server)
      refute Enum.any?(lines, &String.starts_with?(&1, "PASS"))
      refute Enum.any?(lines, &String.starts_with?(&1, "CAP"))
      refute Enum.any?(lines, &String.starts_with?(&1, "AUTHENTICATE"))
    end
  end

  describe "auth_method: :sasl" do
    test "sasl-supported: CAP REQ :sasl + AUTHENTICATE PLAIN + base64 payload + CAP END on 903" do
      {server, port} = start_server(sasl_handler())

      _ =
        start_client(port, %{
          auth_method: :sasl,
          password: "swordfish",
          sasl_user: "vjt"
        })

      assert {:ok, _} =
               IRCServer.wait_for_line(server, &(&1 == "CAP END\r\n"), 1_000)

      lines = IRCServer.sent_lines(server)

      # Order: CAP LS → NICK → USER → CAP REQ → AUTHENTICATE PLAIN →
      # AUTHENTICATE <base64> → CAP END. NICK/USER may interleave with
      # CAP REQ; we assert relative ordering of the SASL chain.
      cap_ls = Enum.find_index(lines, &String.starts_with?(&1, "CAP LS"))
      cap_req = Enum.find_index(lines, &String.starts_with?(&1, "CAP REQ"))

      auth_plain =
        Enum.find_index(lines, &(&1 == "AUTHENTICATE PLAIN\r\n"))

      auth_payload =
        Enum.find_index(
          lines,
          fn line ->
            String.starts_with?(line, "AUTHENTICATE ") and
              line != "AUTHENTICATE PLAIN\r\n"
          end
        )

      cap_end = Enum.find_index(lines, &(&1 == "CAP END\r\n"))

      assert cap_ls != nil
      assert cap_ls < cap_req
      assert cap_req < auth_plain
      assert auth_plain < auth_payload
      assert auth_payload < cap_end

      payload_line = Enum.at(lines, auth_payload)
      "AUTHENTICATE " <> b64 = String.trim_trailing(payload_line, "\r\n")
      decoded = Base.decode64!(b64)
      # PLAIN: \0authzid\0authcid\0password — we use authzid=authcid=sasl_user
      assert decoded == <<0, "vjt", 0, "vjt", 0, "swordfish">>
    end

    test "sasl-failed: 904 from server crashes the client (let it crash)" do
      {server, port} =
        start_server(sasl_handler("904 grappa-test :SASL auth failed"))

      Process.flag(:trap_exit, true)

      {:ok, client} =
        Client.start_link(%{
          host: "127.0.0.1",
          port: port,
          tls: false,
          dispatch_to: self(),
          logger_metadata: [],
          nick: "grappa-test",
          ident: "grappa-test",
          realname: "grappa-test",
          sasl_user: "vjt",
          password: "wrong",
          auth_method: :sasl
        })

      assert_receive {:EXIT, ^client, {:sasl_failed, 904}}, 1_000

      lines = IRCServer.sent_lines(server)
      assert Enum.any?(lines, &(&1 == "AUTHENTICATE PLAIN\r\n"))
      assert Enum.any?(lines, &String.starts_with?(&1, "AUTHENTICATE "))
    end
  end

  describe "auth_method: :auto" do
    test "sasl-supported: behaves identically to :sasl on a SASL-capable server" do
      {server, port} = start_server(sasl_handler())

      _ =
        start_client(port, %{
          auth_method: :auto,
          password: "swordfish",
          sasl_user: "vjt"
        })

      assert {:ok, _} =
               IRCServer.wait_for_line(server, &(&1 == "CAP END\r\n"), 1_000)

      lines = IRCServer.sent_lines(server)
      assert Enum.any?(lines, &(&1 == "AUTHENTICATE PLAIN\r\n"))
    end

    test "sasl-not-supported (Bahamut/Azzurra sim): PASS+CAP LS+NICK/USER, server 421s the CAP, registration proceeds" do
      {server, port} = start_server(bahamut_handler())

      # auto + password sends PASS at register-time; server processes
      # PASS and triggers NickServ IDENTIFY internally (the Bahamut
      # PASS-handoff convention). 421 :Unknown command CAP from the
      # server doesn't stall the client.
      _ =
        start_client(port, %{
          auth_method: :auto,
          password: "swordfish"
        })

      # Client should have sent: PASS, CAP LS, NICK, USER. Then on 421,
      # no further action. No PRIVMSG NickServ from the client side
      # (server-side handoff handles it).
      :ok = await_handshake(server)

      # 421 :Unknown command CAP arrives in the dispatch_to mailbox AFTER
      # the client has parsed it — deterministic synchronisation point.
      assert_receive {:irc, %Message{command: {:numeric, 421}}}, 1_000

      lines = IRCServer.sent_lines(server)
      assert "PASS swordfish\r\n" in lines
      assert Enum.any?(lines, &String.starts_with?(&1, "CAP LS"))
      assert Enum.any?(lines, &String.starts_with?(&1, "NICK "))
      assert Enum.any?(lines, &String.starts_with?(&1, "USER "))
      refute Enum.any?(lines, &String.starts_with?(&1, "PRIVMSG NickServ"))
      refute Enum.any?(lines, &String.starts_with?(&1, "AUTHENTICATE"))
    end

    test "very-old-ircd: 001 arrives before any CAP reply, client does not stall" do
      # Server fires 001 immediately on USER (rfc_handler) and IGNORES
      # CAP LS entirely. Without the registered-state transition on 001,
      # the client would sit forever waiting for a CAP LS reply.
      {server, port} = start_server(rfc_handler())

      _ =
        start_client(port, %{
          auth_method: :auto,
          password: "swordfish"
        })

      # The client signals it reached :registered by no longer being
      # blocked on CAP — we observe this indirectly via `001` having
      # been delivered (dispatch_to receives `{:irc, %Message{command:
      # {:numeric, 1}}}` only after the state machine handled it).
      assert_receive {:irc, %Message{command: {:numeric, 1}}}, 1_000

      lines = IRCServer.sent_lines(server)
      assert "PASS swordfish\r\n" in lines
      assert Enum.any?(lines, &String.starts_with?(&1, "CAP LS"))
      assert Enum.any?(lines, &String.starts_with?(&1, "USER "))
    end
  end

  describe "CAP NAK + IRCv3.2 multi-line CAP LS + 432/433 NICK rejection" do
    test "CAP NAK :sasl with auth_method=:sasl crashes :sasl_unavailable" do
      # Strict ircd that advertises sasl in LS but NAKs the REQ — the
      # SASL contract under :sasl is "must succeed or die". The CAP
      # ACK/NAK round-trip is the IRCv3-spec-correct gate (cf. C1):
      # AUTHENTICATE PLAIN must NOT have been sent yet at NAK time.
      naking_handler = fn state, line ->
        cond do
          String.starts_with?(line, "CAP LS") ->
            {:reply, ":server CAP * LS :sasl=PLAIN\r\n", state}

          String.starts_with?(line, "CAP REQ") ->
            {:reply, ":server CAP * NAK :sasl\r\n", state}

          true ->
            {:reply, nil, state}
        end
      end

      {server, port} = start_server(naking_handler)
      Process.flag(:trap_exit, true)

      {:ok, client} =
        Client.start_link(%{
          host: "127.0.0.1",
          port: port,
          tls: false,
          dispatch_to: self(),
          logger_metadata: [],
          nick: "grappa-test",
          ident: "grappa-test",
          realname: "grappa-test",
          sasl_user: "vjt",
          password: "swordfish",
          auth_method: :sasl
        })

      assert_receive {:EXIT, ^client, :sasl_unavailable}, 1_000

      lines = IRCServer.sent_lines(server)
      assert Enum.any?(lines, &String.starts_with?(&1, "CAP REQ"))
      refute Enum.any?(lines, &String.starts_with?(&1, "AUTHENTICATE"))
    end

    test "multi-line CAP LS continuation: sasl on the SECOND line is recognised" do
      # IRCv3.2 splits long cap lists with `*` as the second-to-last
      # param. Without C2's accumulator, the first line's mismatch
      # (no sasl) would already fall through to cap_unavailable and
      # crash :sasl. This test pins the accumulator behavior.
      multi_line_handler = fn state, line ->
        cond do
          String.starts_with?(line, "CAP LS") ->
            # Reply with TWO lines: continuation marker + final.
            {:reply,
             ":server CAP * LS * :multi-prefix away-notify chghost\r\n" <>
               ":server CAP * LS :extended-join sasl=PLAIN\r\n", state}

          String.starts_with?(line, "CAP REQ") ->
            {:reply, ":server CAP * ACK :sasl\r\n", state}

          line == "AUTHENTICATE PLAIN\r\n" ->
            {:reply, "AUTHENTICATE +\r\n", state}

          String.starts_with?(line, "AUTHENTICATE ") ->
            {:reply, ":server 903 grappa-test :SASL ok\r\n", state}

          String.starts_with?(line, "CAP END") ->
            {:reply, ":server 001 grappa-test :Welcome\r\n", state}

          true ->
            {:reply, nil, state}
        end
      end

      {server, port} = start_server(multi_line_handler)

      _ =
        start_client(port, %{
          auth_method: :sasl,
          password: "swordfish",
          sasl_user: "vjt"
        })

      assert {:ok, _} =
               IRCServer.wait_for_line(server, &(&1 == "CAP END\r\n"), 1_000)

      lines = IRCServer.sent_lines(server)
      assert Enum.any?(lines, &(&1 == "AUTHENTICATE PLAIN\r\n"))
    end

    test "stray CAP LS post-registration is absorbed and does not grow caps_buffer" do
      # F1 (S29 carryover): a buggy/hostile upstream emitting
      # `:server CAP nick LS * :junk` AFTER 001 must NOT mutate
      # caps_buffer — without the phase guard on the LS continuation
      # clauses the buffer grows unbounded until OOM. `finalize_cap_ls`
      # already gated on `:awaiting_cap_ls`; the LS clauses must too,
      # so the stray is absorbed by handle_cap's catch-all.
      registered_then_spam = fn state, line ->
        cond do
          String.starts_with?(line, "CAP LS") ->
            {:reply, ":server CAP * LS :sasl=PLAIN\r\n", state}

          String.starts_with?(line, "CAP REQ") ->
            {:reply, ":server CAP * ACK :sasl\r\n", state}

          line == "AUTHENTICATE PLAIN\r\n" ->
            {:reply, "AUTHENTICATE +\r\n", state}

          String.starts_with?(line, "AUTHENTICATE ") ->
            {:reply, ":server 903 grappa-test :SASL ok\r\n", state}

          String.starts_with?(line, "CAP END") ->
            {:reply, ":server 001 grappa-test :Welcome\r\n", state}

          true ->
            {:reply, nil, state}
        end
      end

      {server, port} = start_server(registered_then_spam)

      client =
        start_client(port, %{
          auth_method: :sasl,
          password: "swordfish",
          sasl_user: "vjt"
        })

      {:ok, _} = IRCServer.wait_for_line(server, &(&1 == "CAP END\r\n"), 1_000)
      # Wait for 001 to be processed by tailing into the registered phase.
      Process.sleep(50)
      assert %{fsm: %{phase: :registered, caps_buffer: []}} = :sys.get_state(client)

      # Now spam stray CAP LS continuations — would have grown the
      # buffer unbounded prior to the F1 phase guard.
      for _ <- 1..50 do
        IRCServer.feed(
          server,
          ":server CAP grappa-test LS * :stray-cap-1 stray-cap-2 stray-cap-3\r\n"
        )
      end

      IRCServer.feed(server, ":server CAP grappa-test LS :tail-cap\r\n")
      Process.sleep(50)

      assert %{fsm: %{phase: :registered, caps_buffer: []}} = :sys.get_state(client)
    end

    test "001 during awaiting_cap_ls clears caps_buffer (C6 / S6)" do
      # Latent bug pre-fix: a server emitting `001` while the client is
      # still in `:awaiting_cap_ls` (mid-continuation, partial caps
      # buffered) leaves `state.caps_buffer` non-empty after the phase
      # transitions to `:registered`. Today nothing re-enters
      # `:awaiting_cap_ls`, so the residue is harmless; Phase 5
      # reconnect-with-backoff would reuse the same Client GenServer
      # state, and the next negotiation would inherit stale chunks.
      # The fix: "leaving CAP negotiation" is one function that owns
      # both `:phase` and `:caps_buffer` — mid-continuation state
      # cannot survive any phase exit.
      direct_001_handler = fn state, line ->
        cond do
          String.starts_with?(line, "CAP LS") ->
            # Continuation marker `*` — accumulate, don't finalize.
            {:reply, ":server CAP * LS * :extended-join chghost away-notify\r\n", state}

          String.starts_with?(line, "USER ") ->
            # Server skips the LS finalize AND CAP END; jumps to 001.
            {:reply, ":server 001 grappa-test :Welcome\r\n", state}

          true ->
            {:reply, nil, state}
        end
      end

      {server, port} = start_server(direct_001_handler)

      client =
        start_client(port, %{
          auth_method: :auto,
          password: "swordfish",
          sasl_user: "vjt"
        })

      # Wait for the server to have written the 001; then poll for the
      # phase transition (no CAP END is sent — handshake is one-sided).
      {:ok, _} = IRCServer.wait_for_line(server, &String.starts_with?(&1, "USER "), 1_000)
      Process.sleep(50)

      assert %{fsm: %{phase: :registered, caps_buffer: []}} = :sys.get_state(client)
    end

    test "433 ERR_NICKNAMEINUSE during registration crashes {:nick_rejected, 433, nick}" do
      nick_clash_handler = fn state, line ->
        if String.starts_with?(line, "USER ") do
          {:reply, ":server 433 * grappa-test :Nickname is already in use\r\n", state}
        else
          {:reply, nil, state}
        end
      end

      {_, port} = start_server(nick_clash_handler)
      Process.flag(:trap_exit, true)

      {:ok, client} =
        Client.start_link(%{
          host: "127.0.0.1",
          port: port,
          tls: false,
          dispatch_to: self(),
          logger_metadata: [],
          nick: "grappa-test",
          ident: "grappa-test",
          realname: "grappa-test",
          sasl_user: "grappa-test",
          auth_method: :none
        })

      assert_receive {:EXIT, ^client, {:nick_rejected, 433, "grappa-test"}}, 1_000
    end
  end

  describe "outbound CRLF guard (S29 C1)" do
    # The IRC framing is one command per CRLF-terminated line. A caller
    # that injects an embedded \r or \n into the target or body smuggles
    # an arbitrary IRC command onto the wire (PRIVMSG #chan :hi\r\nQUIT
    # :pwn → the server sees both PRIVMSG and QUIT). The public send_*
    # helpers reject control bytes early with {:error, :invalid_line};
    # only the raw send_line/2 escape hatch is unguarded by design (it
    # is the SASL chain's bytes-in/bytes-out contract).
    setup do
      {server, port} = start_server()
      client = start_client(port)
      {:ok, server: server, client: client}
    end

    test "send_privmsg/3 rejects \\r\\n in body", %{client: client} do
      assert {:error, :invalid_line} = Client.send_privmsg(client, "#chan", "hi\r\nQUIT :pwn")
    end

    test "send_privmsg/3 rejects \\r\\n in target", %{client: client} do
      assert {:error, :invalid_line} = Client.send_privmsg(client, "#chan\r\nQUIT", "hi")
    end

    test "send_privmsg/3 rejects bare \\n in body", %{client: client} do
      assert {:error, :invalid_line} = Client.send_privmsg(client, "#chan", "hi\nQUIT")
    end

    test "send_privmsg/3 rejects NUL byte in body", %{client: client} do
      assert {:error, :invalid_line} = Client.send_privmsg(client, "#chan", "hi\x00bye")
    end

    test "send_join/3 rejects \\r\\n in channel", %{client: client} do
      assert {:error, :invalid_line} = Client.send_join(client, "#chan\r\nQUIT", nil)
    end

    test "send_part/2 rejects \\r\\n in channel", %{client: client} do
      assert {:error, :invalid_line} = Client.send_part(client, "#chan\r\nQUIT")
    end

    # UX-4 bucket F: key field also runs through safe_line_token? — CRLF
    # or space in the key would let a caller smuggle bytes into the
    # wire frame. Reject at the same boundary as the channel.
    test "send_join/3 rejects \\r\\n in key", %{client: client} do
      assert {:error, :invalid_line} = Client.send_join(client, "#chan", "k\r\nQUIT")
    end

    test "send_join/3 rejects NUL byte in key", %{client: client} do
      assert {:error, :invalid_line} = Client.send_join(client, "#chan", "k\x00ey")
    end

    test "send_join/3 rejects key with embedded space (would shift wire param)",
         %{client: client} do
      assert {:error, :invalid_line} = Client.send_join(client, "#chan", "key with space")
    end

    # Codebase review 2026-05-12 irc/S2: pre-fix `send_join` / `send_part`
    # only enforced `safe_line_token?` — a target without the RFC 2812
    # `#&+!` prefix slipped through, creating a `:pending` window-state
    # entry on a channel name the server can never JOIN. The pending
    # window never resolves because the upstream replies with a 403
    # ERR_NOSUCHCHANNEL whose `params[1]` may not even match what we
    # think we sent. Reject at the boundary like `send_topic` already
    # does — `valid_channel?/1` catches missing-prefix + embedded-whitespace
    # + comma + BELL + length>50 in one regex.
    test "send_join/3 rejects malformed channel (missing #/&/+/!) (irc/S2)", %{client: client} do
      assert {:error, :invalid_line} = Client.send_join(client, "no-hash", nil)
    end

    test "send_join/3 rejects empty channel (irc/S2)", %{client: client} do
      assert {:error, :invalid_line} = Client.send_join(client, "", nil)
    end

    test "send_part/2 rejects malformed channel (missing #/&/+/!) (irc/S2)", %{client: client} do
      assert {:error, :invalid_line} = Client.send_part(client, "no-hash")
    end

    test "send_part/2 rejects empty channel (irc/S2)", %{client: client} do
      assert {:error, :invalid_line} = Client.send_part(client, "")
    end

    # Codebase review 2026-05-12 irc/S3: an empty target makes the wire
    # frame `PRIVMSG  :body\r\n` (double space, no recipient) — the
    # server quietly drops it and the operator sees a no-op, no error.
    # Mirrors send_pong's empty-token guard (S9): non-empty + safe_line
    # at the boundary so the silent failure surfaces as `:invalid_line`.
    test "send_privmsg/3 rejects empty target (irc/S3)", %{client: client} do
      assert {:error, :invalid_line} = Client.send_privmsg(client, "", "hi raga")
    end

    test "send_quit/2 rejects \\r\\n in reason", %{client: client} do
      assert {:error, :invalid_line} = Client.send_quit(client, "bye\r\nNICK pwn")
    end

    test "send_topic/3 rejects \\r\\n in body", %{client: client} do
      assert {:error, :invalid_line} =
               Client.send_topic(client, "#italia", "evil\r\nINJECTION")
    end

    test "send_topic/3 rejects malformed channel (missing #/&/+/!)", %{client: client} do
      assert {:error, :invalid_line} = Client.send_topic(client, "no-hash", "body")
    end

    test "send_nick/2 rejects spaces / CRLF in nick", %{client: client} do
      assert {:error, :invalid_line} = Client.send_nick(client, "vjt away")
      assert {:error, :invalid_line} = Client.send_nick(client, "vjt\r\nQUIT")
    end

    # Bundle C (#20 follow-up)
    test "send_oper/3 rejects CRLF in either field", %{client: client} do
      assert {:error, :invalid_line} = Client.send_oper(client, "vjt\r\nKILL", "pw")
      assert {:error, :invalid_line} = Client.send_oper(client, "vjt", "pw\r\nKILL me")
    end

    # Stricter `safe_oper_token?` boundary — empty fields and embedded
    # whitespace are rejected at the Client layer so a non-cic caller
    # (test harness, Phase 6 listener facade) can't slip a malformed
    # OPER frame past this door even if the Session facade is bypassed.
    test "send_oper/3 rejects empty name or password", %{client: client} do
      assert {:error, :invalid_line} = Client.send_oper(client, "", "pw")
      assert {:error, :invalid_line} = Client.send_oper(client, "vjt", "")
    end

    test "send_oper/3 rejects whitespace in either field", %{client: client} do
      assert {:error, :invalid_line} = Client.send_oper(client, "vjt extra", "pw")
      assert {:error, :invalid_line} = Client.send_oper(client, "vjt", "pw with spaces")
      assert {:error, :invalid_line} = Client.send_oper(client, "vjt\textra", "pw")
    end

    test "send_raw/2 rejects embedded CRLF (no frame-smuggling)", %{client: client} do
      assert {:error, :invalid_line} = Client.send_raw(client, "PING foo\r\nQUIT :pwn")
    end

    test "send_raw/2 rejects empty line", %{client: client} do
      assert {:error, :invalid_line} = Client.send_raw(client, "")
    end

    # An empty reason frames `AWAY :\r\n` — the bare-AWAY un-away line
    # (RFC 2812 §4.6). Accepting it would emit a CLEAR when the caller
    # asked to SET. Mirrors send_pong/send_raw's empty guard at the byte
    # boundary so a non-cic caller (Phase 6 listener facade) can't slip
    # the silent-clear frame past this door even if the Session facade
    # is bypassed. To clear, callers use send_away_unset/1.
    test "send_away/2 rejects empty reason", %{client: client} do
      assert {:error, :invalid_line} = Client.send_away(client, "")
    end

    test "send_away/2 rejects CR/LF/NUL in reason", %{client: client} do
      assert {:error, :invalid_line} = Client.send_away(client, "afk\r\nQUIT :pwn")
      assert {:error, :invalid_line} = Client.send_away(client, "afk\x00")
    end

    # send_pong/2 PING token is parser-supplied; `Grappa.IRC.Parser`
    # strips all `\r`/`\n`/`\x00` from inbound bytes, so the token
    # cannot carry control chars by the time it reaches send_pong.
    # The parser invariant is pinned in `Grappa.IRC.ParserTest` under
    # "CR/LF stripping invariant (C6 / S5)". S9 (audit row irc S9) adds
    # an empty-token + safe_line_token?/1 guard at the helper boundary
    # so a malformed `PONG :\r\n` (no token) cannot leave the bouncer
    # if a future caller bypasses the parser path.

    test "send_pong/2 rejects empty token (S9)", %{client: client} do
      assert {:error, :invalid_line} = Client.send_pong(client, "")
    end

    test "send_pong/2 rejects unsafe-byte token (S9 defensive)", %{client: client} do
      assert {:error, :invalid_line} = Client.send_pong(client, "tok\r\nQUIT")
      assert {:error, :invalid_line} = Client.send_pong(client, "tok\x00")
    end

    test "rejected lines never reach the server socket", %{server: server, client: client} do
      :ok = await_handshake(server)
      lines_before = IRCServer.sent_lines(server)

      _ = Client.send_privmsg(client, "#chan", "hi\r\nQUIT :pwn")
      _ = Client.send_join(client, "#chan\r\nQUIT", nil)

      # No new line lands; if the guard leaks the bytes through, the
      # server would see PRIVMSG / QUIT / JOIN with embedded CR/LF.
      Process.sleep(50)
      lines_after = IRCServer.sent_lines(server)
      assert lines_after == lines_before
    end

    # S10 (audit row irc S10): every send_* helper that returns
    # {:error, :invalid_line} must emit a Logger.warning carrying the
    # verb tag + reason so silent rejections are operator-greppable.
    # The exact message string is structured ("rejected outbound IRC
    # verb at byte boundary") — we assert the substring + verb tag in
    # the captured log line.
    test "send_privmsg rejection emits Logger.warning with verb tag (S10)", %{client: client} do
      log =
        capture_log(fn ->
          assert {:error, :invalid_line} = Client.send_privmsg(client, "#chan", "hi\r\nQUIT")
        end)

      assert log =~ "rejected outbound IRC verb"
      assert log =~ "verb=privmsg"
      assert log =~ "reason=invalid_line"
    end

    test "send_pong empty-token rejection emits Logger.warning (S9+S10)", %{client: client} do
      log =
        capture_log(fn ->
          assert {:error, :invalid_line} = Client.send_pong(client, "")
        end)

      assert log =~ "rejected outbound IRC verb"
      assert log =~ "verb=pong"
    end
  end

  describe "init/1 non-blocking (C2)" do
    # C2 cluster — `init/1` must NOT call `:gen_tcp.connect`/`:ssl.connect`
    # synchronously. Connect + handshake live in `handle_continue(:connect, _)`
    # so a flapping/black-holed upstream cannot freeze the supervisor or
    # serialize Bootstrap's per-credential start_child loop.

    test "start_link returns {:ok, pid} BEFORE TCP connect resolves; failure surfaces async" do
      # Pre-fix: init/1 calls do_connect synchronously; an unused localhost
      # port refuses fast → init returns {:stop, {:connect_failed, :econnrefused}}
      # → start_link returns {:error, _}. Pinning the {:ok, pid} contract is
      # the load-bearing assertion: it can only hold once the connect moves
      # into handle_continue.
      port = pick_unused_port()
      Process.flag(:trap_exit, true)

      assert {:ok, client} =
               Client.start_link(%{
                 host: "127.0.0.1",
                 port: port,
                 tls: false,
                 dispatch_to: self(),
                 logger_metadata: [],
                 nick: "grappa-test",
                 ident: "grappa-test",
                 realname: "grappa-test",
                 sasl_user: "grappa-test",
                 auth_method: :none
               })

      assert is_pid(client)

      # Connect failure now arrives via process EXIT (handle_continue → :stop).
      assert_receive {:EXIT, ^client, {:connect_failed, :econnrefused}}, 1_000
    end

    # H1 (S17 review) — connect-fail throttle uses Process.send_after +
    # deferred-stop instead of inline Process.sleep, so the GenServer
    # mailbox stays responsive during the throttle window. Pre-H1 a
    # `DynamicSupervisor.terminate_child` waited up to the full sleep
    # per child; the new pattern lets the exit signal terminate the
    # process immediately.
    test "mailbox responds during connect-fail throttle window (H1)" do
      port = pick_unused_port()
      Process.flag(:trap_exit, true)

      assert {:ok, client} =
               Client.start_link(%{
                 host: "127.0.0.1",
                 port: port,
                 tls: false,
                 dispatch_to: self(),
                 logger_metadata: [],
                 nick: "grappa-test",
                 ident: "grappa-test",
                 realname: "grappa-test",
                 sasl_user: "grappa-test",
                 auth_method: :none
               })

      # `:sys.get_state/2` proves the mailbox is reachable: pre-H1 the
      # call would queue behind Process.sleep and return only after the
      # throttle ended. Post-H1 it returns immediately while the
      # send_after timer is pending.
      assert %Grappa.IRC.Client{socket: nil} = :sys.get_state(client, 1_000)

      # The deferred {:stop, ...} still arrives once the timer fires.
      assert_receive {:EXIT, ^client, {:connect_failed, :econnrefused}}, 1_000
    end
  end

  describe "init/1 contract enforcement" do
    test ":sasl without password returns {:error, {:missing_password, :sasl}} via :stop" do
      {_, port} = start_server()
      Process.flag(:trap_exit, true)

      assert {:error, {:missing_password, :sasl}} =
               Client.start_link(%{
                 host: "127.0.0.1",
                 port: port,
                 tls: false,
                 dispatch_to: self(),
                 logger_metadata: [],
                 nick: "grappa-test",
                 ident: "grappa-test",
                 realname: "grappa-test",
                 sasl_user: "grappa-test",
                 auth_method: :sasl
               })
    end

    test ":nickserv_identify without password is rejected at boot, NOT mid-001" do
      {_, port} = start_server()
      Process.flag(:trap_exit, true)

      assert {:error, {:missing_password, :nickserv_identify}} =
               Client.start_link(%{
                 host: "127.0.0.1",
                 port: port,
                 tls: false,
                 dispatch_to: self(),
                 logger_metadata: [],
                 nick: "grappa-test",
                 ident: "grappa-test",
                 realname: "grappa-test",
                 sasl_user: "grappa-test",
                 auth_method: :nickserv_identify
               })
    end

    test ":none with no password is allowed (the only no-secret branch)" do
      {server, port} = start_server(rfc_handler())

      _ =
        start_client(port, %{
          auth_method: :none
        })

      assert {:ok, _} =
               IRCServer.wait_for_line(server, &String.starts_with?(&1, "USER "), 1_000)
    end
  end

  describe "IRCServer.start_link/2 (S11): initial handler state" do
    # S11 (audit row irc S11): pre-cluster the only arity was
    # `start_link(handler)` which seeded handler_state to `%{}`. A
    # handler that needed scripted state from the start (e.g. a
    # multi-step counter) had to encode it via Process dict tricks.
    # The two-arity form makes the seed explicit at the test boundary.

    test "passes initial_state through to first handler invocation" do
      # Counter handler: expects state to start at 41, increments per
      # inbound line, replies with the current counter value as a
      # bogus PING token. Without S11 the handler would see %{} and
      # crash on Map.update!(/:counter, ...).
      counter_handler = fn state, _ ->
        next = Map.update!(state, :counter, &(&1 + 1))
        {:reply, "PING :#{next.counter}\r\n", next}
      end

      {:ok, server} = IRCServer.start_link(counter_handler, %{counter: 41})

      port = IRCServer.port(server)
      _ = start_client(port)

      # First inbound line is the handshake's CAP LS or NICK; the handler
      # bumps the counter to 42 and writes back PING :42. We don't care
      # about the exact line — only that the seeded state was visible.
      assert {:ok, _} =
               IRCServer.wait_for_line(server, &String.starts_with?(&1, "USER "), 1_000)
    end

    test "start_link/1 still works (no-state delegate to start_link/2)" do
      # The /1 arity is the existing legacy contract — every existing
      # caller in the test suite uses it. S11 must not break it.
      {:ok, server} = IRCServer.start_link(passthrough_handler())
      port = IRCServer.port(server)
      _ = start_client(port)

      assert {:ok, _} =
               IRCServer.wait_for_line(server, &String.starts_with?(&1, "USER "), 1_000)
    end
  end

  describe "IRCServer wait_for_line drain on tcp_closed (S7)" do
    # S7 (audit row irc S7): pre-S7 a wait_for_line/3 caller blocked on
    # a predicate that would NEVER match because the socket had closed
    # spent its full timeout window before resolving. Post-S7 the
    # `{:tcp_closed, _}` handler drains every pending waiter with
    # `{:error, :tcp_closed}` so the caller distinguishes a genuine
    # upstream close from a deadline miss.

    test "tcp_closed drains pending waiters with {:error, :tcp_closed}" do
      {:ok, server} = IRCServer.start_link(passthrough_handler())
      port = IRCServer.port(server)
      client = start_client(port)

      # Register a long-deadline waiter for a line the client will
      # never send — without S7 we'd wait ~10s for the timer to fire.
      task =
        Task.async(fn ->
          IRCServer.wait_for_line(server, &(&1 == "NEVER\r\n"), 10_000)
        end)

      # Yield so the task GenServer.calls and the waiter lands in state.
      Process.sleep(50)

      # Force a socket close by stopping the client (link severs the
      # accepted socket; the server's `:tcp_closed` lands in handle_info).
      Process.flag(:trap_exit, true)
      Process.exit(client, :kill)

      # The waiter resolves promptly with :tcp_closed, NOT after the
      # 10s deadline. Cap the assertion at 2s — the drain is a single
      # GenServer.reply per waiter, microseconds.
      assert {:error, :tcp_closed} = Task.await(task, 2_000)
    end
  end

  describe "liveness watchdog (#100): self-PING + timeout" do
    # #100 — the ONE genuinely-absent drop trigger. A half-open socket
    # (mobile radio drop / NAT idle-eviction with no FIN) is invisible to
    # {:tcp_closed}/{:ssl_closed} and would hang until the ~2h OS TCP
    # keepalive. The watchdog closes it: after `liveness_idle_ms` of
    # INBOUND silence the client sends its own PING; if `liveness_timeout_ms`
    # elapses with STILL no inbound, the connection is declared dead and the
    # client stops with `:ping_timeout` — which propagates as a link EXIT to
    # `Session.Server` and drives the EXISTING respawn/backoff chain (no new
    # reconnect path). Any inbound line (the server's PONG, a channel line,
    # a server-originated PING) resets the cycle, so a healthy-but-quiet
    # connection can never false-trigger.
    #
    # Timers are opts-overridable (default 60s idle / 30s timeout in
    # config); these tests inject tiny values so the cycle runs in ms.

    # Server that answers our self-PING with a PONG — models a live upstream.
    # The inbound PONG resets the liveness cycle every round.
    defp liveness_pong_handler do
      fn state, line ->
        if String.starts_with?(line, "PING") do
          {:reply, ":server PONG grappa-test :grappa-liveness\r\n", state}
        else
          {:reply, nil, state}
        end
      end
    end

    test "dead upstream (self-PING unanswered) trips :ping_timeout → link EXIT" do
      # passthrough server: accepts the connection, buffers our PING, never
      # replies. No inbound ever reaches the client → idle fires → self-PING
      # → still no inbound → timeout fires → {:stop, :ping_timeout, _}.
      {server, port} = start_server()
      Process.flag(:trap_exit, true)

      client = start_client(port, %{liveness_idle_ms: 100, liveness_timeout_ms: 200})

      # The self-PING is on the wire after ~idle ms — proves the probe fired.
      assert {:ok, _} =
               IRCServer.wait_for_line(server, &String.starts_with?(&1, "PING"), 1_000)

      # No PONG (no inbound at all) → timeout fires → the client stops with
      # the reconnect-triggering reason. This is the link EXIT the linked
      # Session.Server converts into a Backoff-paced respawn.
      assert_receive {:EXIT, ^client, :ping_timeout}, 1_000
    end

    test "healthy upstream answering PING does NOT trip liveness (no false positive)" do
      # The server PONGs every self-PING; each inbound PONG resets the cycle,
      # so the timeout timer is cancelled before it can fire. The client must
      # survive well past idle+timeout. This is the load-bearing "don't kill a
      # healthy-but-quiet connection" assertion.
      {server, port} = start_server(liveness_pong_handler())
      Process.flag(:trap_exit, true)

      client = start_client(port, %{liveness_idle_ms: 100, liveness_timeout_ms: 200})

      # Prove ≥2 full liveness cycles ran (the probe keeps firing on a quiet
      # link) — a single PING could pass by luck; two means the reset→re-arm
      # loop is working.
      assert {:ok, _} =
               IRCServer.wait_for_line(server, &String.starts_with?(&1, "PING"), 1_000)

      # Sleep past several (idle + timeout) windows. If liveness incorrectly
      # fired, the client would already be dead by now. Intentional sleep:
      # asserting a NEGATIVE (nothing killed it) over a window that comfortably
      # exceeds 2×(idle+timeout) = 600ms.
      Process.sleep(700)

      assert Process.alive?(client),
             "healthy upstream answering PING must NOT be declared dead"

      refute_received {:EXIT, ^client, :ping_timeout}

      pings = Enum.count(IRCServer.sent_lines(server), &String.starts_with?(&1, "PING"))
      assert pings >= 2, "expected the liveness probe to keep firing on a quiet link, saw #{pings}"
    end

    test "inbound traffic (not just PONG) resets the idle timer" do
      # Any inbound line proves liveness — a busy channel keeps the socket
      # alive without the client ever needing to self-PING. Server feeds a
      # PRIVMSG every 40ms (< the 100ms idle) so the idle timer never elapses.
      {server, port} = start_server()
      Process.flag(:trap_exit, true)

      client = start_client(port, %{liveness_idle_ms: 100, liveness_timeout_ms: 200})

      # Feed 6 lines at 40ms spacing (240ms total) — each resets the idle
      # timer before it reaches 100ms, so no self-PING should ever be sent.
      Enum.each(1..6, fn i ->
        IRCServer.feed(server, ":a!~a@h PRIVMSG #x :keepalive #{i}\r\n")
        Process.sleep(40)
      end)

      assert Process.alive?(client)
      refute_received {:EXIT, ^client, :ping_timeout}

      pings = Enum.count(IRCServer.sent_lines(server), &String.starts_with?(&1, "PING"))
      assert pings == 0, "steady inbound traffic must reset idle before the probe fires, saw #{pings}"
    end
  end

  describe "outbound leaf selection + rotation (#271)" do
    # #271 — a multi-AAAA (round-robin) upstream hostname must NOT pin one
    # leaf. Pre-fix grappa handed the HOSTNAME to :ssl.connect/:gen_tcp.connect,
    # so the OS getaddrinfo RFC-6724 destination-address sort picked the same
    # leaf on every connect (~40 sessions on one leaf; a single leaf down took
    # every session with it). The fix: grappa resolves the full RR set itself
    # (:inet_res.lookup), shuffles, and dials the IP TUPLE — bypassing the
    # deterministic getaddrinfo sort so it OWNS the leaf choice.
    #
    # Two realistic azzurra AAAA leaves (from the issue) + one synthetic so the
    # rotation assertion has >1 candidate.
    @azzurra_aaaa [
      {0x2A01, 0x4F8, 0x201, 0x2281, 0x11, 0, 0, 0x22},
      {0x2603, 0xC027, 0x17, 0xF145, 0, 0, 0, 0xF35},
      {0x2A03, 0x4000, 0x2, 0x33C, 0, 0, 0, 0x42}
    ]

    # (a) full set considered + rotation: resolve_targets returns every member
    # (a permutation of the whole RR set) and the leaf actually dialed (the head
    # of the shuffle) is NOT always the same one across many calls.
    test "resolve_targets returns the full AAAA set as a shuffled permutation (RR, not pinned)" do
      resolver = fn ~c"irc.azzurra.chat", :in, :aaaa -> @azzurra_aaaa end

      # Every call yields all members — no leaf is silently dropped from the pool.
      for _ <- 1..20 do
        got = Client.__resolve_targets_for_test__(~c"irc.azzurra.chat", :inet6, resolver)
        assert Enum.sort(got) == Enum.sort(@azzurra_aaaa)
      end

      # Rotation: across many calls the first-picked leaf varies. With ≥2
      # members over 64 rolls, an all-identical head is astronomically unlikely
      # (≤ (1/3)^63) — a stable head means the RR pin is still there.
      heads = for _ <- 1..64, do: hd(Client.__resolve_targets_for_test__(~c"irc.azzurra.chat", :inet6, resolver))

      assert heads |> Enum.uniq() |> length() > 1,
             "leaf pick never rotated across 64 resolves — RR still pinned"
    end

    # The v6 path (source pool active) must query AAAA; the v4 path must query A.
    test "resolve_targets queries A records for the :inet family" do
      a_set = [{1, 2, 3, 4}, {5, 6, 7, 8}]
      resolver = fn ~c"irc.example.org", :in, :a -> a_set end

      got = Client.__resolve_targets_for_test__(~c"irc.example.org", :inet, resolver)
      assert Enum.sort(got) == Enum.sort(a_set)
    end

    # An IP-literal host has nothing to rotate: dial it directly, no DNS. This
    # is what keeps the IRCServer integration tests (host "127.0.0.1") dialing a
    # v4 tuple with no resolver round-trip.
    test "resolve_targets short-circuits an IP-literal host (no DNS, dial the literal)" do
      # The resolver must NOT be consulted for a literal.
      resolver = fn _, _, _ -> raise "resolver must not run for an IP literal" end

      assert Client.__resolve_targets_for_test__(~c"127.0.0.1", :inet, resolver) == [{127, 0, 0, 1}]
      assert Client.__resolve_targets_for_test__(~c"::1", :inet6, resolver) == [{0, 0, 0, 0, 0, 0, 0, 1}]
    end

    # Resolution gap (empty answer for a real name) falls back to handing the
    # hostname to the connect fun — no worse than the pre-#271 behavior for a
    # host with no records in the chosen family.
    test "resolve_targets falls back to the hostname when resolution is empty" do
      resolver = fn ~c"irc.nowhere.invalid", :in, :aaaa -> [] end

      assert Client.__resolve_targets_for_test__(~c"irc.nowhere.invalid", :inet6, resolver) ==
               [~c"irc.nowhere.invalid"]
    end

    # (b) IP-tuple connect target + (c) SNI/hostname-check anchored to the
    # ORIGINAL hostname after the IP-tuple switch — the #89 regression guard vjt
    # explicitly demanded. connect_fun is injected so no real socket is opened;
    # we inspect exactly what the connect boundary was handed.
    test "TLS connect dials an IP tuple while SNI + hostname-check stay the hostname (#89 guard)" do
      resolver = fn ~c"irc.azzurra.chat", :in, :aaaa -> @azzurra_aaaa end
      parent = self()

      connect_fun = fn transport, target, port, opts, _ ->
        send(parent, {:dial, transport, target, port, opts})
        {:ok, :fake_socket}
      end

      assert {:ok, :fake_socket} =
               Client.__connect_with_rotation_for_test__(
                 ~c"irc.azzurra.chat",
                 6697,
                 true,
                 [],
                 :inet6,
                 resolver,
                 connect_fun
               )

      assert_received {:dial, :ssl, target, 6697, opts}

      # (b) The connect TARGET is an IP 8-tuple from the resolved set — NOT the
      # hostname charlist. This is what bypasses the getaddrinfo RFC-6724 sort.
      assert is_tuple(target) and tuple_size(target) == 8
      assert target in @azzurra_aaaa

      # (c) SNI is the ORIGINAL hostname (charlist), not the picked IP — so the
      # leaf's cert (SAN irc.azzurra.chat) validates under verify_peer.
      assert Keyword.fetch!(opts, :server_name_indication) == ~c"irc.azzurra.chat"

      # (c) hostname verification stays wired to the RFC-6125 :https match_fun.
      match = Keyword.fetch!(opts, :customize_hostname_check)
      assert is_function(Keyword.fetch!(match, :match_fun), 2)

      # #89 verify_peer must survive the IP-tuple switch untouched.
      assert Keyword.fetch!(opts, :verify) == :verify_peer
      assert Keyword.fetch!(opts, :depth) == 3
    end

    test "TCP connect dials an IP tuple target (no hostname to getaddrinfo)" do
      resolver = fn ~c"irc.azzurra.chat", :in, :aaaa -> @azzurra_aaaa end
      parent = self()

      connect_fun = fn transport, target, port, opts, _ ->
        send(parent, {:dial, transport, target, port, opts})
        {:ok, :fake_socket}
      end

      assert {:ok, :fake_socket} =
               Client.__connect_with_rotation_for_test__(
                 ~c"irc.azzurra.chat",
                 6667,
                 false,
                 [],
                 :inet6,
                 resolver,
                 connect_fun
               )

      assert_received {:dial, :tcp, target, 6667, _}
      assert is_tuple(target) and tuple_size(target) == 8
      assert target in @azzurra_aaaa
    end

    # The bind_opts (ifaddr source bind) still ride through to the connect fun —
    # the source-address pool bind is not lost by the IP-tuple switch.
    test "connect passes the source-bind ifaddr opts through to the connect fun" do
      resolver = fn ~c"irc.azzurra.chat", :in, :aaaa -> @azzurra_aaaa end
      parent = self()
      source = {0x2A03, 0x4000, 0x2, 0x33C, 0, 0, 0, 0x1}

      connect_fun = fn _, _, _, opts, _ ->
        send(parent, {:opts, opts})
        {:ok, :fake_socket}
      end

      assert {:ok, :fake_socket} =
               Client.__connect_with_rotation_for_test__(
                 ~c"irc.azzurra.chat",
                 6697,
                 true,
                 [ifaddr: source],
                 :inet6,
                 resolver,
                 connect_fun
               )

      assert_received {:opts, opts}
      assert Keyword.fetch!(opts, :ifaddr) == source
    end

    # (d) rotate-on-connect-fail: the first-picked leaf's connect failure must
    # roll to a DIFFERENT member of the set before the :transient give-up, so a
    # single dead leaf can't park every session.
    test "rotate-on-fail: a first-pick connect failure retries a DIFFERENT leaf" do
      resolver = fn ~c"irc.azzurra.chat", :in, :aaaa -> @azzurra_aaaa end
      parent = self()
      attempts = :counters.new(1, [])

      connect_fun = fn _, target, _, _, _ ->
        n = :counters.get(attempts, 1)
        :counters.add(attempts, 1, 1)
        send(parent, {:tried, target})
        # First leaf is down; the next one is up.
        if n == 0, do: {:error, :econnrefused}, else: {:ok, :fake_socket}
      end

      assert {:ok, :fake_socket} =
               Client.__connect_with_rotation_for_test__(
                 ~c"irc.azzurra.chat",
                 6697,
                 true,
                 [],
                 :inet6,
                 resolver,
                 connect_fun
               )

      assert_received {:tried, first}
      assert_received {:tried, second}
      assert first != second, "retry dialed the SAME dead leaf — no rotation"
      assert first in @azzurra_aaaa and second in @azzurra_aaaa
      assert :counters.get(attempts, 1) == 2, "expected exactly 2 attempts (fail then success)"
    end

    # (d) exhaustion: when EVERY leaf is down, connect_with_rotation surfaces the
    # last {:error, reason} verbatim so the existing connect-fail throttle +
    # :transient give-up chain still engages (rotation must not swallow a real
    # give-up).
    test "all leaves down: surfaces the last {:error, reason} for the give-up chain" do
      resolver = fn ~c"irc.azzurra.chat", :in, :aaaa -> @azzurra_aaaa end
      parent = self()
      attempts = :counters.new(1, [])

      connect_fun = fn _, target, _, _, _ ->
        :counters.add(attempts, 1, 1)
        send(parent, {:tried, target})
        {:error, :econnrefused}
      end

      assert {:error, :econnrefused} =
               Client.__connect_with_rotation_for_test__(
                 ~c"irc.azzurra.chat",
                 6697,
                 true,
                 [],
                 :inet6,
                 resolver,
                 connect_fun
               )

      # Every leaf in the set was attempted before give-up.
      assert :counters.get(attempts, 1) == length(@azzurra_aaaa)
    end
  end
end
