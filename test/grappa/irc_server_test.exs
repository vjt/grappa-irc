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

  describe "the dead-port body (#1397 bucket H characterization)" do
    # Six test files carry this same four-line body, five under the name
    # `pick_unused_port` and one as `unused_port`. Ten of its seventeen
    # call sites dial the number and want the connect REFUSED, so that
    # "upstream unreachable" / "connect refused" / "a refused connect
    # still counts toward the circuit" have something to happen against.
    # (The other seven never dial — a captcha, an IP cap, a throttle, an
    # `:ignore` and three accretion gates all reject first — so for them
    # any valid unused number would do.)
    #
    # For the ten, that refusal is the contract, and nothing asserted it
    # before this test: the six copies were only ever exercised through
    # what their callers did next.
    test "the six-copy body yields a port a connect is refused on" do
      {:ok, l} = :gen_tcp.listen(0, [])
      {:ok, port} = :inet.port(l)
      :gen_tcp.close(l)

      assert is_integer(port) and port > 0

      assert {:error, :econnrefused} =
               :gen_tcp.connect({127, 0, 0, 1}, port, [:binary, active: false], 1_000)
    end

    # The equivalence oracle for the consolidation: the helper must earn
    # the same verdict the inline gesture above earns, put to it the same
    # way. Not `assert helper() == inline()` — the two draw different
    # ephemeral numbers by construction, so equal RESULTS would be a bug,
    # not the property. What has to match is the port's OBSERVABLE
    # behaviour, which is the only thing the seventeen call sites could
    # ever have depended on.
    test "IRCServer.pick_unused_port/0 earns the same verdict as the inline body" do
      port = IRCServer.pick_unused_port()

      assert is_integer(port) and port > 0

      assert {:error, :econnrefused} =
               :gen_tcp.connect({127, 0, 0, 1}, port, [:binary, active: false], 1_000)
    end
  end

  # Both of these are named at seventy-two call sites once the eight
  # `start_irc_server/0` wrappers are gone (#1397 bucket H), and neither
  # had a test: they were exercised only through whatever their callers
  # did next. The same reason `welcome_handler/2` earned one above.
  describe "passthrough_handler/0" do
    test "replies to nothing, whatever the line, and leaves handler state untouched" do
      handler = IRCServer.passthrough_handler()

      assert {:reply, nil, %{step: 1}} = handler.(%{step: 1}, "USER vjt 0 * :Marcello\r\n")
      assert {:reply, nil, %{}} = handler.(%{}, "PING :probe\r\n")
    end
  end

  describe "start_server/1" do
    test "returns a live peer and the port a client actually reaches it on" do
      {server, port} = IRCServer.start_server(IRCServer.passthrough_handler())

      assert is_pid(server) and Process.alive?(server)
      assert port == IRCServer.port(server)

      {:ok, sock} = :gen_tcp.connect({127, 0, 0, 1}, port, [:binary, active: false])
      on_exit(fn -> :gen_tcp.close(sock) end)

      # `packet: :line` hands the delimiter to the buffer, so a stored line
      # keeps its CRLF — which is why every predicate here is a prefix test
      # rather than an equality.
      :ok = :gen_tcp.send(sock, "PING :probe\r\n")

      assert {:ok, "PING :probe\r\n"} =
               IRCServer.wait_for_line(server, &String.starts_with?(&1, "PING :probe"), 1_000)
    end
  end
end
