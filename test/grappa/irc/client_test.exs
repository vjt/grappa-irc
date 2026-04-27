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
    {:ok, _} = IRCServer.wait_for_line(server, &String.starts_with?(&1, "USER "))
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
              logger_metadata: [],
              nick: "grappa-test",
              auth_method: :none
            })
          end)

          Process.sleep(200)
        end)

      assert log =~ "verify_none"
    end
  end

  describe "auth_method: :none" do
    test "sends only NICK + USER; no PASS, no CAP, no IDENTIFY" do
      {server, port} = start_server(rfc_handler())
      _ = start_client(port, %{auth_method: :none})

      assert {:ok, _} =
               IRCServer.wait_for_line(server, &String.starts_with?(&1, "USER "))

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
               IRCServer.wait_for_line(server, &String.starts_with?(&1, "USER "))

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
                 &(&1 == "PRIVMSG NickServ :IDENTIFY swordfish\r\n")
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
               IRCServer.wait_for_line(server, &(&1 == "CAP END\r\n"))

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
               IRCServer.wait_for_line(server, &(&1 == "CAP END\r\n"))

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
               IRCServer.wait_for_line(server, &(&1 == "CAP END\r\n"))

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

      {:ok, _} = IRCServer.wait_for_line(server, &(&1 == "CAP END\r\n"))
      # Wait for 001 to be processed by tailing into the registered phase.
      Process.sleep(50)
      assert %{phase: :registered, caps_buffer: []} = :sys.get_state(client)

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

      assert %{phase: :registered, caps_buffer: []} = :sys.get_state(client)
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
      {:ok, _} = IRCServer.wait_for_line(server, &String.starts_with?(&1, "USER "))
      Process.sleep(50)

      assert %{phase: :registered, caps_buffer: []} = :sys.get_state(client)
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

    test "send_join/2 rejects \\r\\n in channel", %{client: client} do
      assert {:error, :invalid_line} = Client.send_join(client, "#chan\r\nQUIT")
    end

    test "send_part/2 rejects \\r\\n in channel", %{client: client} do
      assert {:error, :invalid_line} = Client.send_part(client, "#chan\r\nQUIT")
    end

    test "send_quit/2 rejects \\r\\n in reason", %{client: client} do
      assert {:error, :invalid_line} = Client.send_quit(client, "bye\r\nNICK pwn")
    end

    # send_pong/2 has NO CR/LF guard (C6 / S5). PING token is
    # parser-supplied; `Grappa.IRC.Parser` strips all `\r`/`\n` from
    # inbound bytes, so the token cannot carry control chars by the
    # time it reaches send_pong. The other helpers above accept
    # operator/user input and therefore retain their guards. The
    # parser invariant is pinned in `Grappa.IRC.ParserTest` under
    # "CR/LF stripping invariant (C6 / S5)".

    test "rejected lines never reach the server socket", %{server: server, client: client} do
      :ok = await_handshake(server)
      lines_before = IRCServer.sent_lines(server)

      _ = Client.send_privmsg(client, "#chan", "hi\r\nQUIT :pwn")
      _ = Client.send_join(client, "#chan\r\nQUIT")

      # No new line lands; if the guard leaks the bytes through, the
      # server would see PRIVMSG / QUIT / JOIN with embedded CR/LF.
      Process.sleep(50)
      lines_after = IRCServer.sent_lines(server)
      assert lines_after == lines_before
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
                 realname: "grappa-test",
                 sasl_user: "grappa-test",
                 auth_method: :none
               })

      assert is_pid(client)

      # Connect failure now arrives via process EXIT (handle_continue → :stop).
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
               IRCServer.wait_for_line(server, &String.starts_with?(&1, "USER "))
    end
  end
end
