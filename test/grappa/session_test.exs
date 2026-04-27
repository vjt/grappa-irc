defmodule Grappa.SessionTest do
  @moduledoc """
  Pre-dispatch validation at the `Grappa.Session` facade. Tests here
  cover guards that fire BEFORE the registry lookup / GenServer
  call/cast — so they need no live `Session.Server` and no DB.

  The CRLF guard for `send_privmsg/4 | send_join/3 | send_part/3` is
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

  describe "send_privmsg/4 CRLF guard" do
    test "rejects \\r\\n in body before whereis lookup" do
      assert {:error, :invalid_line} =
               Session.send_privmsg(@user_id, @network_id, "#chan", "hi\r\nQUIT :pwn")
    end

    test "rejects \\r\\n in target before whereis lookup" do
      assert {:error, :invalid_line} =
               Session.send_privmsg(@user_id, @network_id, "#chan\r\nQUIT", "hi")
    end

    test "rejects bare \\n in body" do
      assert {:error, :invalid_line} =
               Session.send_privmsg(@user_id, @network_id, "#chan", "hi\nbye")
    end

    test "rejects NUL byte in body" do
      assert {:error, :invalid_line} =
               Session.send_privmsg(@user_id, @network_id, "#chan", "hi\x00bye")
    end

    test "valid input falls through to :no_session for unknown session" do
      assert {:error, :no_session} =
               Session.send_privmsg(@user_id, @network_id, "#chan", "hi raga")
    end
  end

  describe "send_join/3 CRLF guard" do
    test "rejects \\r\\n in channel before whereis lookup" do
      assert {:error, :invalid_line} =
               Session.send_join(@user_id, @network_id, "#chan\r\nQUIT")
    end

    test "valid input falls through to :no_session for unknown session" do
      assert {:error, :no_session} =
               Session.send_join(@user_id, @network_id, "#chan")
    end
  end

  describe "send_part/3 CRLF guard" do
    test "rejects \\r\\n in channel before whereis lookup" do
      assert {:error, :invalid_line} =
               Session.send_part(@user_id, @network_id, "#chan\r\nQUIT")
    end

    test "valid input falls through to :no_session for unknown session" do
      assert {:error, :no_session} =
               Session.send_part(@user_id, @network_id, "#chan")
    end
  end

  describe "list_channels/2" do
    test "returns {:error, :no_session} when no session is registered" do
      assert {:error, :no_session} =
               Session.list_channels(@user_id, @network_id)
    end
  end
end
