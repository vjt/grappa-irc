defmodule Grappa.Session.RegistrationGateTest do
  @moduledoc """
  Issue 2728 — a verb that writes a line upstream is refused, as
  `{:error, :not_registered}`, until the network has registered us (001
  RPL_WELCOME), whether or not a Client exists yet.

  An ircd answers anything but the registration verbs from an unregistered
  client with 451 and drops it, and nothing here handles 451, so a line
  written in that window is lost while the caller is told it went out. Each
  test below pins the OUTCOME of one such verb in the window — the reply, the
  rows, the wire — never which clause answered.

  Two windows, both "not registered":

    * no Client at all (`client: nil`) — the Backoff-deferred respawn;
    * a Client whose socket is up but no 001 has arrived — the
      `passthrough_handler` fake never sends one, so the session sits there.

  `async: false` for the same singleton reasons as `Grappa.Session.ServerTest`.
  """
  use Grappa.DataCase, async: false

  import Ecto.Query
  import Grappa.AuthFixtures

  alias Grappa.IRC.Client
  alias Grappa.{IRCServer, Repo, Session, SessionStateHelpers}
  alias Grappa.Networks.{Credentials, SessionPlan}
  alias Grappa.Scrollback.Message

  # The `client: nil` tests orphan a live Client, which logs its exit when
  # the fake ircd goes away at teardown.
  @moduletag :capture_log

  @nick "grappa-test"

  defp unregistered_session(plan_extra) do
    {server, port} = IRCServer.start_server(IRCServer.passthrough_handler())
    user = user_fixture(name: "vjt-#{System.unique_integer([:positive])}")
    {network, _} = network_with_server(port: port, slug: "test-#{System.unique_integer([:positive])}")
    _ = credential_fixture(user, network, %{nick: @nick})

    {:ok, plan} = SessionPlan.resolve(Credentials.get_credential!(user, network))
    {:ok, pid} = Session.start_session({:user, user.id}, network.id, Map.merge(plan, plan_extra))
    on_exit(fn -> Session.stop_session({:user, user.id}, network.id) end)
    :ok = IRCServer.await_handshake(server, 1_000)

    %{server: server, pid: pid, subject: {:user, user.id}, network: network}
  end

  # Every line written before this one has reached the fake: the Client
  # writes in mailbox order, and the fake records in arrival order.
  defp wire_barrier(server, pid) do
    line = "PING :barrier-#{System.unique_integer([:positive])}\r\n"
    :ok = pid |> SessionStateHelpers.fetch() |> SessionStateHelpers.client() |> Client.send_line(line)
    {:ok, _} = IRCServer.wait_for_line(server, &(&1 == line), 1_000)
    :ok
  end

  defp rows(network_id), do: Message |> where([m], m.network_id == ^network_id) |> Repo.aggregate(:count)

  defp sent?(server, prefix), do: Enum.any?(IRCServer.sent_lines(server), &String.starts_with?(&1, prefix))

  describe "before 001, with the socket up" do
    test "a PRIVMSG is refused, persists no row and writes no line" do
      %{server: server, pid: pid, subject: subject, network: network} = unregistered_session(%{})

      assert {:error, :not_registered} = Session.send_privmsg(subject, network.id, "#chan", "hello")

      wire_barrier(server, pid)
      assert rows(network.id) == 0
      refute sent?(server, "PRIVMSG #chan")
    end

    test "a /nick is refused, so the configured nick is not reclaimed over it after 001" do
      %{server: server, pid: pid, subject: subject, network: network} =
        unregistered_session(%{nick_reclaim_ms: 50})

      assert {:error, :not_registered} = Session.send_nick(subject, network.id, "other-nick")
      assert SessionStateHelpers.fetch(pid).nick == @nick

      IRCServer.feed(server, ":irc.test.org 001 #{@nick} :Welcome\r\n")
      # Past the reclaim deadline: a reclaim, had one been armed, is on the wire.
      Process.sleep(200)
      wire_barrier(server, pid)

      refute sent?(server, "NICK other-nick")
      assert Enum.count(IRCServer.sent_lines(server), &(&1 == "NICK #{@nick}\r\n")) == 1
    end

    test "a /links is refused and primes nothing, so the retry after 001 is not locked out" do
      %{server: server, subject: subject, network: network} = unregistered_session(%{})

      assert {:error, :not_registered} = Session.send_links(subject, network.id, nil, nil)
      assert {:error, :not_registered} = Session.send_links(subject, network.id, nil, nil)

      IRCServer.feed(server, ":irc.test.org 001 #{@nick} :Welcome\r\n")
      assert {:ok, _} = IRCServer.wait_for_line(server, &String.starts_with?(&1, "MODE #{@nick}"), 1_000)

      assert :ok = Session.send_links(subject, network.id, nil, nil)
      assert {:ok, "LINKS\r\n"} = IRCServer.wait_for_line(server, &(&1 == "LINKS\r\n"), 1_000)
    end

    test "a directory refresh is refused and writes no LIST" do
      %{server: server, pid: pid, subject: subject, network: network} = unregistered_session(%{})

      assert {:error, :not_registered} = Session.refresh_directory(subject, network.id)

      wire_barrier(server, pid)
      refute sent?(server, "LIST")
    end
  end

  describe "with no Client at all" do
    test "a PRIVMSG is refused and persists no row" do
      %{pid: pid, subject: subject, network: network} = unregistered_session(%{})
      :sys.replace_state(pid, &%{&1 | client: nil})

      assert {:error, :not_registered} = Session.send_privmsg(subject, network.id, "#chan", "hello")
      assert rows(network.id) == 0
    end

    test "a /links is refused and primes nothing" do
      %{pid: pid, subject: subject, network: network} = unregistered_session(%{})
      :sys.replace_state(pid, &%{&1 | client: nil})

      assert {:error, :not_registered} = Session.send_links(subject, network.id, nil, nil)
      assert {:error, :not_registered} = Session.send_links(subject, network.id, nil, nil)
    end
  end

  describe "Grappa.Session.VerbPolicy" do
    # Every probe carries the one untagged head the check allows, the gate's
    # shape: a bare `request` refused by a guard, ahead of the tagged clauses.
    defp compile_server(policy, clauses) do
      Code.compile_string("""
      defmodule Grappa.Session.VerbPolicyProbe#{System.unique_integer([:positive])} do
        @verb_policy #{inspect(policy)}
        @before_compile Grappa.Session.VerbPolicy
        def handle_call(request, _, s) when is_tuple(request) and elem(request, 0) == :gated,
          do: {:reply, {:error, :not_registered}, s}
        #{clauses}
      end
      """)
    end

    test "a request every table entry answers, and no other, compiles" do
      assert [_] =
               compile_server(
                 %{ping: :local, send_x: :needs_registered, send_part: :local_first},
                 """
                 def handle_call(:ping, _, s), do: {:reply, :pong, s}
                 def handle_call({:send_x, _} = r, _, s), do: {:reply, r, s}
                 def handle_cast({:send_part, _}, s), do: {:noreply, s}
                 """
               )
    end

    test "a clause whose tag the table does not classify fails to compile" do
      assert_raise CompileError, ~r/unclassified: \[:send_new\]/, fn ->
        compile_server(%{ping: :local}, """
        def handle_call(:ping, _, s), do: {:reply, :pong, s}
        def handle_call({:send_new, _, _}, _, s), do: {:reply, :ok, s}
        """)
      end
    end

    test "a table entry no clause answers fails to compile" do
      assert_raise CompileError, ~r/unanswered: \[:gone\]/, fn ->
        compile_server(%{ping: :local, gone: :local}, "def handle_call(:ping, _, s), do: {:reply, :pong, s}")
      end
    end

    # A head with no literal tag answers requests the two directions above
    # cannot see, so beyond the gate there must be none.
    test "a second untagged handle_call head, or any untagged handle_cast head, fails to compile" do
      assert_raise CompileError, ~r/untagged_heads: \[handle_call: 2, handle_cast: 0\]/, fn ->
        compile_server(%{ping: :local}, """
        def handle_call(:ping, _, s), do: {:reply, :pong, s}
        def handle_call(r, _, s) when elem(r, 0) == :send_foo, do: {:reply, :ok, s}
        """)
      end

      assert_raise CompileError, ~r/untagged_heads: \[handle_call: 1, handle_cast: 1\]/, fn ->
        compile_server(%{ping: :local}, """
        def handle_call(:ping, _, s), do: {:reply, :pong, s}
        def handle_cast(msg, s) when elem(msg, 0) == :send_foo, do: {:noreply, s}
        """)
      end
    end

    test "a policy outside the closed set fails to compile" do
      assert_raise CompileError, ~r/unknown_policy: \[ping: :maybe\]/, fn ->
        compile_server(%{ping: :maybe}, "def handle_call(:ping, _, s), do: {:reply, :pong, s}")
      end
    end
  end
end
