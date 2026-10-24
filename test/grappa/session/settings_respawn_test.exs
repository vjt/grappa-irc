defmodule Grappa.Session.SettingsRespawnTest do
  @moduledoc """
  Issue 2463 — a subject setting changed while the session runs must
  survive a `:transient` restart of that session.

  `DynamicSupervisor` restarts a crashed `Session.Server` with the child
  spec it cached at spawn, so anything resolved ONCE into those opts comes
  back at its spawn-time value. The plan half already re-resolves in
  `init/1` (`refresh_plan`, the 2026-05-27 zombie class); these tests pin
  the settings half — the `/ignore` list, the auto-away window / reason /
  nick suffix and the peer-profile opt-in — which `start_session/3` used to
  resolve once with `Map.put_new_lazy`.

  `async: false` for the same reason as `Grappa.Session.ServerTest`:
  `SessionRegistry` / `SessionSupervisor` are singletons.
  """
  use Grappa.DataCase, async: false
  import Grappa.AuthFixtures

  alias Grappa.IRC.Mask
  alias Grappa.{IRCServer, Scrollback, ServerSettings, Session, UserSettings}
  alias Grappa.Networks.Servers
  alias Grappa.PubSub.Topic
  alias Grappa.Session.AwayState

  @nick "grappa-test"

  defp setup_user_and_network(port) do
    user = user_fixture(name: "respawn-#{System.unique_integer([:positive])}")

    {network, server_row} =
      network_with_server(port: port, slug: "respawn-#{System.unique_integer([:positive])}")

    _ = credential_fixture(user, network, %{nick: @nick})
    {user, network, server_row}
  end

  defp label(user), do: Grappa.Subject.label({:user, user.name})

  # Kills the live session the way a crash does and returns its successor.
  # The `:sys.get_state/1` round-trip drains whatever the session was still
  # doing (a settings broadcast handler can read the DB), so the kill never
  # lands while it holds the sandbox's shared connection.
  defp crash_and_await_successor(subject, network_id, pid) do
    _ = :sys.get_state(pid)
    Process.exit(pid, :kill)
    await_respawn(subject, network_id, pid)
  end

  test "an /ignore added on a live session still drops the line after a crash" do
    {first_irc, port} = IRCServer.start_server(IRCServer.welcome_handler(":irc", @nick))
    {user, network, server_row} = setup_user_and_network(port)
    subject = {:user, user.id}

    pid = start_session_for(user, network)
    :ok = IRCServer.await_handshake(first_irc, 1_000)

    # The REST door's two steps (`IgnoresController.mutate/3`): store the
    # entry, then push the whole list into the live session.
    {:ok, :added, _, entries} = UserSettings.add_ignore(subject, network.slug, "spambot", nil, :ascii)
    :ok = Session.ignores_changed(subject, network.id, entries)

    # Pre-state: the LIVE session holds the ignore, so whatever the
    # successor does below is about the restart, not the sync.
    assert [%{mask: %Mask{source: "spambot!*@*"}}] = :sys.get_state(pid).ignores

    # The fake accepts one connection, so the successor dials a second one.
    # Repointing the server row is enough: the restart re-resolves the plan
    # from the DB, endpoint included.
    {second_irc, second_port} = IRCServer.start_server(IRCServer.welcome_handler(":irc", @nick))
    {:ok, _} = Servers.update_server(server_row, %{port: second_port})

    successor = crash_and_await_successor(subject, network.id, pid)
    assert successor != pid
    :ok = IRCServer.await_handshake(second_irc, 5_000)

    :ok = Phoenix.PubSub.subscribe(Grappa.PubSub, Topic.channel(user.name, network.slug, "#room"))

    # The control line goes SECOND: the session handles lines in order, so
    # once its row is broadcast the ignored line has been through the
    # filter, and its absence is a decision rather than a race.
    IRCServer.feed(second_irc, ":spambot!u@spam.example PRIVMSG #room :buy my coins\r\n")
    IRCServer.feed(second_irc, ":friend!u@good.example PRIVMSG #room :hello\r\n")

    assert_receive %Phoenix.Socket.Broadcast{
                     event: "event",
                     payload: %{message: %{kind: :privmsg, sender: "friend"}}
                   },
                   2_000

    # No row, and therefore no push: the push is dispatched FROM the
    # persisted row (`Grappa.Session.Persistor.dispatch_push/2`).
    senders =
      subject
      |> Scrollback.fetch(network.id, "#room", nil, 10, nil, false)
      |> Enum.map(& &1.sender)

    assert senders == ["friend"]
  end

  test "every subject setting changed after spawn is what the successor starts on" do
    {irc, port} = IRCServer.start_server(IRCServer.welcome_handler(":irc", @nick))
    {user, network, _} = setup_user_and_network(port)
    subject = {:user, user.id}

    pid = start_session_for(user, network)
    :ok = IRCServer.await_handshake(irc, 1_000)

    # Pre-state: the session started on the defaults, so the values asserted
    # on the successor can only come from a read the restart made.
    assert settings(:sys.get_state(pid)) == %{
             ignores: [],
             auto_away_debounce_ms: ServerSettings.auto_away_fallback_ms(),
             auto_away_reason: AwayState.auto_away_reason(),
             away_nick_suffix: nil,
             show_peer_profiles: false
           }

    {:ok, :added, _, _} = UserSettings.add_ignore(subject, network.slug, "spambot", nil, :ascii)
    {:ok, _} = UserSettings.put_auto_away_debounce_seconds(subject, 3_600, label(user))
    {:ok, _} = UserSettings.put_auto_away_reason(subject, "gone fishing", label(user))
    {:ok, _} = UserSettings.put_away_nick_suffix(subject, "-away", label(user))
    {:ok, _} = UserSettings.put_show_peer_profiles(subject, true)

    successor = crash_and_await_successor(subject, network.id, pid)

    # One comparison, not five: a stale setting must not hide the others.
    assert settings(:sys.get_state(successor)) == %{
             ignores: ["spambot!*@*"],
             auto_away_debounce_ms: 3_600_000,
             auto_away_reason: "gone fishing",
             away_nick_suffix: "-away",
             show_peer_profiles: true
           }
  end

  defp settings(state) do
    %{
      ignores: Enum.map(state.ignores, & &1.mask.source),
      auto_away_debounce_ms: state.auto_away_debounce_ms,
      auto_away_reason: state.auto_away_reason,
      away_nick_suffix: state.away_nick_suffix,
      show_peer_profiles: state.show_peer_profiles
    }
  end

  # The site default is half of how the auto-away window resolves (issue
  # 2359): a subject with no preference follows it, and the admin's change
  # reaches the live session through `reapply_auto_away_site_default/0`.
  test "a session following the site default comes back on the CURRENT one" do
    {irc, port} = IRCServer.start_server(IRCServer.welcome_handler(":irc", @nick))
    {user, network, _} = setup_user_and_network(port)
    subject = {:user, user.id}

    pid = start_session_for(user, network)
    :ok = IRCServer.await_handshake(irc, 1_000)

    refute ServerSettings.auto_away_fallback_ms() == 300_000
    assert :sys.get_state(pid).auto_away_debounce_ms == ServerSettings.auto_away_fallback_ms()

    :ok = ServerSettings.put_auto_away_default_seconds(300)
    :ok = Session.reapply_auto_away_site_default()

    successor = crash_and_await_successor(subject, network.id, pid)

    assert :sys.get_state(successor).auto_away_debounce_ms == 300_000
  end
end
