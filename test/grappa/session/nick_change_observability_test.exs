defmodule Grappa.Session.NickChangeObservabilityTest do
  @moduledoc """
  #618 — when a session stops answering to the nick it was configured
  with, BOTH operator doors must say so.

  The motivating case is a ghost recovery that fails or times out: the FSM
  renames the live session to `<nick>_` as its very first action and only
  comes back on the success edge, so every other terminal leaves the
  session answering to a nick nobody was told about. But the defect is not
  the ghost path's — an AuthFSM 433 ladder, a services rename and a plain
  `/nick` strand the same way. So the observability rides the ONE trigger
  they all share (`Session.Server.on_own_nick_change/2`) rather than any
  one of their terminals:

    * the AUDIT door — a `SessionLog` `:nick_changed` record carrying the
      pair `old_nick → nick`;
    * the STATE door — `LiveIntrospection.SessionEntry.nick`, the live half
      of the two-sources rule, which the admin listings render next to the
      DB-canonical credential nick.

  The rename here is driven for real over the fake IRC server rather than
  by poking state, and the credential row is deliberately left at the
  configured nick: an implementation that read the DB nick, or that keyed
  off the ghost FSM instead of the shared trigger, fails these tests.

  `async: false` — a real `Session.Server` under the singleton
  `SessionRegistry` / `SessionSupervisor` (mirrors
  `Grappa.Push.BadgeCountLiveNickTest`, whose rename harness this reuses).
  """
  use Grappa.DataCase, async: false

  import Grappa.AuthFixtures

  alias Grappa.{IRCServer, LiveIntrospection, Session, SessionLog}
  alias Grappa.Networks.Credentials

  @configured_nick "grappa-test"
  @live_nick "grappa-test_"

  defp attach_capture(events) do
    handler_id = "nick-change-observability-#{System.unique_integer([:positive])}"
    parent = self()
    ref = make_ref()

    :ok =
      :telemetry.attach_many(
        handler_id,
        events,
        fn name, measurements, metadata, _ ->
          send(parent, {:telemetry, ref, name, measurements, metadata})
        end,
        nil
      )

    on_exit(fn -> :telemetry.detach(handler_id) end)
    ref
  end

  # Brings up a real session that registers as `@configured_nick`, then
  # forces a self-NICK to `@live_nick`. The credential row is NOT rewritten
  # — nothing persists a rename, which is exactly the divergence under test.
  # The JOIN barrier proves 001 was fully processed before the NICK, and the
  # PING/PONG round-trip flushes the cross-process NICK pipeline (TCP buffer
  # → Client → Session mailbox) so the rename has landed before assertions.
  defp start_renamed_session do
    rfc_handler = fn state, line ->
      if String.starts_with?(line, "USER ") do
        {:reply, ":server 001 #{@configured_nick} :Welcome\r\n", state}
      else
        {:reply, nil, state}
      end
    end

    {:ok, server} = IRCServer.start_link(rfc_handler)
    port = IRCServer.port(server)

    user = user_fixture(name: "vjt-#{System.unique_integer([:positive])}")
    {network, _} = network_with_server(port: port, slug: "test-#{System.unique_integer([:positive])}")
    _ = credential_fixture(user, network, %{nick: @configured_nick})

    _ = start_session_for(user, network)

    on_exit(fn -> Session.stop_session({:user, user.id}, network.id) end)

    {:ok, _} = IRCServer.wait_for_line(server, &String.starts_with?(&1, "USER"), 1_000)
    {:ok, _} = IRCServer.wait_for_line(server, &String.starts_with?(&1, "JOIN"), 1_000)

    IRCServer.feed(server, ":#{@configured_nick}!u@h NICK :#{@live_nick}\r\n")
    IRCServer.feed(server, "PING :flush\r\n")
    {:ok, _} = IRCServer.wait_for_line(server, &(&1 == "PONG :flush\r\n"), 1_000)

    {{:user, user.id}, network}
  end

  test "the audit door records the move as a pair, not just an endpoint" do
    # Attached BEFORE the session starts: 001 welcomes us under the nick we
    # asked for, so the ONLY :nick_changed in this run is the self-NICK.
    ref = attach_capture([[:grappa, :session, :log, :nick_changed]])

    {subject, network} = start_renamed_session()

    assert_receive {:telemetry, ^ref, [:grappa, :session, :log, :nick_changed], _m, md}, 2_000

    assert md.old_nick == @configured_nick
    assert md.nick == @live_nick
    assert md.session_id == SessionLog.session_id(subject, network.id)
  end

  test "the state door reports the live nick while the DB still says the configured one" do
    {subject, network} = start_renamed_session()

    entry = LiveIntrospection.lookup_session(subject, network.id)

    # The whole point: these two disagree, and the operator surface has to
    # keep both. An implementation reading the credential row would return
    # @configured_nick here and the first assertion would fail.
    assert entry.nick == @live_nick

    {:ok, cred} = Credentials.get_credential_by_ids(elem(subject, 1), network.id)
    assert cred.nick == @configured_nick
  end

  test "no live session yields no entry at all, never a DB-shaped guess" do
    # The U-0 honesty signal upstream of the nick: no pid means `nil` entry,
    # which the admin wires render as `live_state: null`. There is no shape
    # in which a configured nick leaks into the live projection.
    user = user_fixture(name: "vjt-#{System.unique_integer([:positive])}")
    {network, _} = network_with_server(port: 6667, slug: "test-#{System.unique_integer([:positive])}")
    _ = credential_fixture(user, network, %{nick: @configured_nick})

    assert LiveIntrospection.lookup_session({:user, user.id}, network.id) == nil
  end
end
