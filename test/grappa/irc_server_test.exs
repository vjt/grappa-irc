defmodule Grappa.IRCServerTest do
  @moduledoc """
  Unit tests for the shared helpers on `Grappa.IRCServer` (#1397).

  The fake server is otherwise exercised through its consumers, which is
  why it has had no test of its own. A helper earns a test here once it
  is hoisted out of local copies, because hoisting removes the many
  hand-written copies that used to state the shape by example.

  `await_handshake/2` (F1) was the first: it is the barrier lifted out of
  thirteen local copies, and the property that matters about it is not
  behavioural but structural: it must NOT grow a default timeout.

  Commit `84fe0850` removed the default timeout from `wait_for_line/3`
  under the CLAUDE.md no-default-arguments rule, then stamped the value
  explicitly at every call site. The thirteen local `await_handshake`
  wrappers this replaces had immediately re-hidden that same value behind
  a zero-argument helper — eleven at 1s, two at 5s. A default here would
  restore the silent-degradation path that ruling removed AND quietly
  halve the budget of the two 5s sites, so the arity is pinned.
  """
  use ExUnit.Case, async: true

  alias Grappa.IRCServer

  defp connected_client(server) do
    {:ok, sock} = :gen_tcp.connect({127, 0, 0, 1}, IRCServer.port(server), [:binary, active: false])
    on_exit(fn -> :gen_tcp.close(sock) end)
    sock
  end

  test "returns :ok once the client has sent its USER registration line" do
    {:ok, server} = IRCServer.start_link(IRCServer.passthrough_handler())
    sock = connected_client(server)

    :ok = :gen_tcp.send(sock, "NICK vjt\r\n")
    :ok = :gen_tcp.send(sock, "USER vjt 0 * :Marcello\r\n")

    assert :ok = IRCServer.await_handshake(server, 1_000)
  end

  test "raises when the registration line never arrives inside the budget" do
    {:ok, server} = IRCServer.start_link(IRCServer.passthrough_handler())
    connected_client(server)

    assert_raise MatchError, fn -> IRCServer.await_handshake(server, 50) end
  end

  test "a line that merely starts with USER but is not the registration verb does not satisfy it" do
    {:ok, server} = IRCServer.start_link(IRCServer.passthrough_handler())
    sock = connected_client(server)

    :ok = :gen_tcp.send(sock, "USERHOST vjt\r\n")

    assert_raise MatchError, fn -> IRCServer.await_handshake(server, 50) end
  end

  test "carries no default timeout" do
    Code.ensure_loaded!(IRCServer)

    assert function_exported?(IRCServer, :await_handshake, 2)
    refute function_exported?(IRCServer, :await_handshake, 1)
  end

  describe "welcome_handler/2" do
    test "answers a USER line with 001 assembled from prefix and nick" do
      handler = IRCServer.welcome_handler(":irc", "grappa-test")

      assert {:reply, ":irc 001 grappa-test :Welcome\r\n", %{}} =
               handler.(%{}, "USER grappa-test 0 * :grappa\r\n")
    end

    test "both arguments reach the wire, each in its own position" do
      # Deliberately non-interchangeable values. Every call site in the
      # suite passes a plausible-looking prefix AND a plausible-looking
      # nick, so a swapped pair or an ignored second argument would keep
      # producing a well-formed 001 and pass everywhere. Here it cannot.
      handler = IRCServer.welcome_handler(":other.example.org", "someone-else")

      assert {:reply, ":other.example.org 001 someone-else :Welcome\r\n", %{}} =
               handler.(%{}, "USER whoever 0 * :whoever\r\n")
    end

    test "stays silent on non-USER lines and leaves handler state untouched" do
      handler = IRCServer.welcome_handler(":irc", "grappa-test")

      assert {:reply, nil, %{step: 1}} = handler.(%{step: 1}, "NICK grappa-test\r\n")
      assert {:reply, nil, %{}} = handler.(%{}, "CAP LS 302\r\n")
    end

    test "USERHOST does not register: the space in the prefix is load-bearing" do
      handler = IRCServer.welcome_handler(":irc", "grappa-test")

      assert {:reply, nil, %{}} = handler.(%{}, "USERHOST grappa-test\r\n")
    end

    test "carries no default prefix and no default nick" do
      Code.ensure_loaded!(IRCServer)

      assert function_exported?(IRCServer, :welcome_handler, 2)
      refute function_exported?(IRCServer, :welcome_handler, 1)
      refute function_exported?(IRCServer, :welcome_handler, 0)
    end
  end
end
