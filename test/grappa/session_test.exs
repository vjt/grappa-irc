defmodule Grappa.SessionTest do
  @moduledoc """
  Pre-dispatch validation at the `Grappa.Session` facade. Tests here
  cover guards that fire BEFORE the registry lookup / GenServer
  call/cast — so they need no live `Session.Server` and no DB.

  The CRLF guard for `send_privmsg/4 | send_join/4 | send_part/3` is
  the canonical case (S29 C1): CRLF in the body or target would
  smuggle a second IRC command onto the wire if it ever reached the
  Client. The Session facade rejects with `{:error, :invalid_line}`
  before ever touching `whereis/2`, so a CRLF attempt against a
  non-existent session still returns `:invalid_line` rather than
  `:no_session` — the ordering is intentional (input-shape error
  beats not-found).
  """
  use ExUnit.Case, async: true

  alias Grappa.Session

  @user_id "00000000-0000-0000-0000-000000000000"
  @network_id 999_999_999
  @origin_window %{kind: :channel, target: "#chan"}

  describe "send_privmsg/4 CRLF guard" do
    test "rejects \\r\\n in body before whereis lookup" do
      assert {:error, :invalid_line} =
               Session.send_privmsg({:user, @user_id}, @network_id, "#chan", "hi\r\nQUIT :pwn")
    end

    test "rejects \\r\\n in target before whereis lookup" do
      assert {:error, :invalid_line} =
               Session.send_privmsg({:user, @user_id}, @network_id, "#chan\r\nQUIT", "hi")
    end

    test "rejects bare \\n in body" do
      assert {:error, :invalid_line} =
               Session.send_privmsg({:user, @user_id}, @network_id, "#chan", "hi\nbye")
    end

    test "rejects NUL byte in body" do
      assert {:error, :invalid_line} =
               Session.send_privmsg({:user, @user_id}, @network_id, "#chan", "hi\x00bye")
    end

    test "valid input falls through to :no_session for unknown session" do
      assert {:error, :no_session} =
               Session.send_privmsg({:user, @user_id}, @network_id, "#chan", "hi raga")
    end
  end

  describe "send_join/4 CRLF guard" do
    test "rejects \\r\\n in channel before whereis lookup" do
      assert {:error, :invalid_line} =
               Session.send_join({:user, @user_id}, @network_id, "#chan\r\nQUIT", nil)
    end

    # Code-review CRIT-1 (bucket C): irc/S2 added `valid_channel?/1` to
    # `Client.send_join`/`send_part` — pre-CRIT-1 the Session facade
    # only gated `safe_line_token?`, so a malformed channel slipped to
    # the cast and `Server.handle_cast/2`'s strict `:ok = ...` would
    # MatchError. Tighten the facade so the rejection happens BEFORE
    # the cast, mirroring `send_topic`'s shape.
    test "rejects malformed channel (missing prefix) before whereis lookup (CRIT-1)" do
      assert {:error, :invalid_line} =
               Session.send_join({:user, @user_id}, @network_id, "no-hash", nil)
    end

    test "rejects empty channel before whereis lookup (CRIT-1)" do
      assert {:error, :invalid_line} =
               Session.send_join({:user, @user_id}, @network_id, "", nil)
    end

    test "valid input falls through to :no_session for unknown session" do
      assert {:error, :no_session} =
               Session.send_join({:user, @user_id}, @network_id, "#chan", nil)
    end

    # UX-4 bucket F: optional +k channel key.
    test "rejects \\r\\n in key before whereis lookup" do
      assert {:error, :invalid_line} =
               Session.send_join({:user, @user_id}, @network_id, "#chan", "key\r\n")
    end

    test "accepts valid key, falls through to :no_session for unknown session" do
      assert {:error, :no_session} =
               Session.send_join({:user, @user_id}, @network_id, "#chan", "secret")
    end

    test "empty-string key is treated as nil (no key)" do
      assert {:error, :no_session} =
               Session.send_join({:user, @user_id}, @network_id, "#chan", "")
    end
  end

  describe "send_part/3 CRLF guard" do
    test "rejects \\r\\n in channel before whereis lookup" do
      assert {:error, :invalid_line} =
               Session.send_part({:user, @user_id}, @network_id, "#chan\r\nQUIT")
    end

    test "rejects malformed channel (missing prefix) before whereis lookup (CRIT-1)" do
      assert {:error, :invalid_line} =
               Session.send_part({:user, @user_id}, @network_id, "no-hash")
    end

    test "rejects empty channel before whereis lookup (CRIT-1)" do
      assert {:error, :invalid_line} =
               Session.send_part({:user, @user_id}, @network_id, "")
    end

    test "valid input falls through to :no_session for unknown session" do
      assert {:error, :no_session} =
               Session.send_part({:user, @user_id}, @network_id, "#chan")
    end
  end

  # An empty reason builds `AWAY :\r\n` on the wire, which per RFC 2812
  # §4.6 means "no longer away" — the bare-AWAY un-away semantics. The
  # explicit-away verb must never emit it: an operator setting away with
  # an empty reason would silently CLEAR their away instead. The dedicated
  # verb for clearing is `unset_explicit_away/2`. `safe_line_token?/1`
  # only rejects CR/LF/NUL, so `""` slips through it — the emptiness check
  # is the facade's job (mirrors `Client.send_pong`'s empty-token guard).
  describe "set_explicit_away/3,4 empty-reason guard" do
    test "rejects empty reason before whereis lookup (/3)" do
      assert {:error, :invalid_line} =
               Session.set_explicit_away({:user, @user_id}, @network_id, "")
    end

    test "rejects empty reason before whereis lookup (/4 origin_window arity)" do
      assert {:error, :invalid_line} =
               Session.set_explicit_away({:user, @user_id}, @network_id, "", @origin_window)
    end

    test "rejects \\r\\n in reason before whereis lookup" do
      assert {:error, :invalid_line} =
               Session.set_explicit_away({:user, @user_id}, @network_id, "afk\r\nQUIT :pwn")
    end

    test "valid reason falls through to :no_session for unknown session (/3)" do
      assert {:error, :no_session} =
               Session.set_explicit_away({:user, @user_id}, @network_id, "lunch")
    end

    test "valid reason falls through to :no_session for unknown session (/4)" do
      assert {:error, :no_session} =
               Session.set_explicit_away({:user, @user_id}, @network_id, "lunch", @origin_window)
    end

    # Only the empty string is the un-away line. A whitespace-only reason
    # is a valid (if blank-looking) `AWAY :   ` set — the guard is
    # `reason != ""`, not a trim, matching `Client.send_pong`'s byte-empty
    # guard. Pinned so a future change doesn't tighten to `String.trim/1`
    # and silently start rejecting spaces-only reasons.
    test "whitespace-only reason is accepted (not the empty un-away case)" do
      assert {:error, :no_session} =
               Session.set_explicit_away({:user, @user_id}, @network_id, "   ")
    end
  end

  describe "list_channels/2" do
    test "returns {:error, :no_session} when no session is registered" do
      assert {:error, :no_session} =
               Session.list_channels({:user, @user_id}, @network_id)
    end
  end

  # #211 phase 6 — `call_session/4` must treat a callee that DIES during
  # the call as `:no_session`, not propagate the callee's exit to the
  # caller. Pre-fix only `:exit, {:timeout, _}` was caught; a session
  # crashing mid-call (a visitor's 2nd-network session hitting a 433 nick
  # collision on a shared leaf, `{:client_exit, {:nick_rejected, _}}`)
  # propagated the exit → `GET /networks` 500'd via
  # `resolve_network_nick`'s `current_nick` call. A dead session looks
  # like "no session" to callers.
  describe "call_session callee-death handling (current_nick)" do
    test "a session that EXITS during the call surfaces as {:error, :no_session}" do
      # A throwaway process registered under the exact session key that
      # exits (abnormally) the instant it's called — the deterministic
      # stand-in for a Session.Server crashing mid-`GenServer.call`.
      net_id = System.unique_integer([:positive])
      subject = {:visitor, "11111111-2222-3333-4444-555555555555"}
      key = Grappa.Session.Server.registry_key(subject, net_id)
      test_pid = self()

      {:ok, _} =
        Task.start(fn ->
          {:ok, _} = Registry.register(Grappa.SessionRegistry, key, nil)
          send(test_pid, :registered)

          receive do
            {:"$gen_call", _, {:current_nick}} ->
              # Die WITHOUT replying — the caller's GenServer.call gets the
              # callee's :DOWN → an :exit the fix must catch.
              exit({:client_exit, {:nick_rejected, 433, "collision"}})
          after
            5_000 -> :ok
          end
        end)

      assert_receive :registered, 1_000

      assert {:error, :no_session} = Session.current_nick(subject, net_id)
    end
  end
end
