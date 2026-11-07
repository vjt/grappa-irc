defmodule Grappa.SessionRegisteredHoldersTest do
  @moduledoc """
  Issue 2597 — `Session.registered_holders/3` answers "which of OUR
  sessions holds this nick on the ircd right now", and only a session
  that has seen 001 RPL_WELCOME may answer yes.

  The live-nick copy in the `SessionRegistry` value is seeded with the
  CONFIGURED nick at `do_init`, before registration, and every upstream
  drop respawns the session onto that seed again. That is the #498
  contract for `current_nick/2` and it stays: its consumers want a nick
  to fall back on. But a session in backoff, or looping on 433, does not
  hold that nick upstream — somebody else may — so a nick→session lookup
  that read the seed would attribute one of our users to a stranger.
  Issue 2597 shows that user's client address to IRC operators, which is
  exactly the wrong person to be wrong about.

  `async: false` — real `Session.Server`s under the singleton
  `SessionRegistry` / `SessionSupervisor`, same as
  `Grappa.Push.BadgeCountLiveNickTest`.
  """
  use Grappa.DataCase, async: false

  import Grappa.AuthFixtures

  alias Grappa.IRC.Identifier
  alias Grappa.{IRCServer, Session}

  # Mixed case on purpose: the session holds it RAW, the lookup is folded.
  @nick "Holder-2597"

  defp start_session(handler) do
    {server, port} = IRCServer.start_server(handler)
    user = user_fixture(name: "vjt-#{System.unique_integer([:positive])}")
    {network, _} = network_with_server(port: port, slug: "test-#{System.unique_integer([:positive])}")
    _ = credential_fixture(user, network, %{nick: @nick})
    pid = start_session_for(user, network)
    :ok = IRCServer.await_handshake(server, 1_000)
    %{server: server, user: user, network: network, pid: pid, subject: {:user, user.id}}
  end

  # PONG only leaves after the session drained everything queued ahead of
  # the PING — the 001 included — so the registry write has happened.
  defp flush(server) do
    IRCServer.feed(server, "PING :flush\r\n")
    {:ok, _} = IRCServer.wait_for_line(server, &(&1 == "PONG :flush\r\n"), 1_000)
    :ok
  end

  defp holders(network, nick), do: Session.registered_holders(network.id, Identifier.canonical_target(nick), :ascii)

  test "a session that has not seen 001 holds no nick, while current_nick still answers its seed" do
    ctx = start_session(IRCServer.passthrough_handler())

    assert holders(ctx.network, @nick) == []
    assert Session.current_nick(ctx.subject, ctx.network.id) == {:ok, @nick}
  end

  test "after 001 the session is the holder of its nick, matched through the fold" do
    ctx = start_session(IRCServer.welcome_handler(":server", @nick))
    :ok = flush(ctx.server)

    assert holders(ctx.network, String.upcase(@nick)) == [{ctx.subject, ctx.user.name}]
  end

  test "a registered session on one network is no holder on another" do
    ctx = start_session(IRCServer.welcome_handler(":server", @nick))
    :ok = flush(ctx.server)
    other = network_fixture()

    assert holders(other, @nick) == []
  end

  test "a respawned session holds no nick until its own 001" do
    ctx = start_session(IRCServer.welcome_handler(":server", @nick))
    :ok = flush(ctx.server)
    assert holders(ctx.network, @nick) == [{ctx.subject, ctx.user.name}]

    # The fake server accepts ONE connection, so the respawn reconnects to a
    # listener nobody answers: it can never reach 001 in this test.
    Process.exit(ctx.pid, :kill)
    :ok = await_respawn(ctx.subject, ctx.network.id, ctx.pid, 100)

    assert holders(ctx.network, @nick) == []
  end

  # The respawn is observable once a NEW pid owns the key AND its do_init has
  # seeded the value (current_nick answers only from a seeded entry).
  defp await_respawn(_, _, _, 0), do: flunk("session never respawned with a seeded registry value")

  defp await_respawn(subject, network_id, old_pid, attempts) do
    pid = Session.whereis(subject, network_id)

    if is_pid(pid) and pid != old_pid and match?({:ok, _}, Session.current_nick(subject, network_id)) do
      :ok
    else
      Process.sleep(20)
      await_respawn(subject, network_id, old_pid, attempts - 1)
    end
  end
end
