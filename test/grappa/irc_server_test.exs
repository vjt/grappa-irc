defmodule Grappa.IRCServerTest do
  @moduledoc """
  Unit tests for the `Grappa.IRCServer` handshake barrier (#1397 F1).

  The fake server is otherwise exercised through its consumers, which is
  why it has had no test of its own. `await_handshake/2` gets one because
  it is the first barrier hoisted out of the thirteen local copies, and
  the property that matters about it is not behavioural but structural:
  it must NOT grow a default timeout.

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
end
