defmodule Grappa.Push.BadgeCountLiveNickTest do
  @moduledoc """
  #498 — the notify/badge count must match the LIVE IRC nick, not the
  configured credential nick, after a `/nick` rename.

  `Grappa.Push.BadgeCount` (and the `/me` cold-load seed + read-cursor
  settle that share its own-nick resolver) historically read the
  CONFIGURED credential nick off-`Session`, accepting mention-match
  staleness after a rename "until the next reconnect rewrites the
  credential". Nothing rewrites the credential for a user, so the
  staleness was permanent: after `/nick newnick` the count kept matching
  the OLD nick and stopped matching the NEW one.

  C-prime converges every door onto the ONE live-nick source
  (`Session.current_nick/2`, now a cheap SessionRegistry-value lookup),
  so the badge follows the rename immediately, both halves.

  `async: false` — the session harness spawns a real `Session.Server`
  under the singleton `SessionRegistry`/`SessionSupervisor` (mirrors
  `Grappa.Session.ServerTest`); concurrent tests would collide on the
  `{:session, user_id, network_id}` key. `Grappa.DataCase` switches to
  shared sandbox mode so the out-of-PID GenServer sees the sandboxed Repo.
  """
  use Grappa.DataCase, async: false

  import Grappa.AuthFixtures

  alias Grappa.{IRCServer, Networks, ReadCursor, Scrollback, ScrollbackHelpers, Session}
  alias Grappa.Push.BadgeCount

  # The configured (credential) nick and the post-rename LIVE nick. The
  # rename is a genuine identity change (old ≢ new), so the credential nick
  # stays `@configured_nick` while the live session nick becomes
  # `@live_nick` — exactly the divergence #498 is about.
  @configured_nick "grappa-test"
  @live_nick "renamed-vjt"

  # Starts a real session, reconciles at 001 to the configured nick, then
  # forces a self-NICK to `@live_nick`. Returns `{subject, network}` with
  # the credential nick left at `@configured_nick` (nothing persists the
  # rename — the #498 staleness). The PING/PONG round-trip flushes the
  # cross-process NICK pipeline (TCP buffer → Client → Session mailbox)
  # so the rename is fully applied before the assertions run.
  defp start_renamed_session do
    {subject, network, server} = start_session_at_configured_nick()
    :ok = force_self_rename(server)
    {subject, network}
  end

  # Split out of `start_renamed_session/0` so #514 can seed scrollback rows
  # while the session still holds `@configured_nick` — the whole point there
  # is history that predates the rename.
  defp start_session_at_configured_nick do
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

    {:ok, _} = IRCServer.wait_for_line(server, &String.starts_with?(&1, "USER"), 1_000)
    # Autojoin JOIN fires only after 001 is fully processed → a barrier
    # proving the nick reconciliation landed before the self-NICK below.
    {:ok, _} = IRCServer.wait_for_line(server, &String.starts_with?(&1, "JOIN"), 1_000)

    {{:user, user.id}, network, server}
  end

  # Feeds the self-NICK and blocks until the session has fully applied it.
  # The PING/PONG round-trip is the barrier: PONG only goes out after the
  # session process has drained the NICK ahead of it in its mailbox, so any
  # `apply_effects/2` migration the rename triggers has already run.
  defp force_self_rename(server) do
    IRCServer.feed(server, ":#{@configured_nick}!u@h NICK :#{@live_nick}\r\n")
    IRCServer.feed(server, "PING :flush\r\n")
    {:ok, _} = IRCServer.wait_for_line(server, &(&1 == "PONG :flush\r\n"), 1_000)
    :ok
  end

  defp insert(subject, network, channel, opts) do
    {:ok, message} =
      ScrollbackHelpers.insert(%{
        user_id: elem(subject, 1),
        network_id: network.id,
        channel: channel,
        server_time: opts[:st],
        kind: :privmsg,
        sender: opts[:sender],
        body: opts[:body],
        dm_with: opts[:dm_with]
      })

    message
  end

  defp set_cursor(subject, network, channel, message_id) do
    {:ok, _} = ReadCursor.set(subject, network.id, channel, message_id)
    :ok
  end

  test "current_nick tracks the live rename (registry-backed reader)" do
    {subject, network} = start_renamed_session()

    # The reader returns the LIVE nick — the source every notify door must
    # converge on. (Green pre- and post-C-prime; guards the reader semantics
    # while its implementation moves from a GenServer.call to a Registry
    # lookup.)
    assert Session.current_nick(subject, network.id) == {:ok, @live_nick}
  end

  test "current_nick is :no_session with no live session (badge falls back to cred nick)" do
    user = user_fixture(name: "vjt-#{System.unique_integer([:positive])}")
    network = network_fixture()
    _ = credential_fixture(user, network, %{nick: @configured_nick})

    assert Session.current_nick({:user, user.id}, network.id) == {:error, :no_session}
  end

  test "live_nick_index resolves the live nick when a session is up" do
    {subject, network} = start_renamed_session()
    slug = network.slug

    assert %{^slug => {network_id, nick}} = Networks.live_nick_index(subject)
    assert network_id == network.id
    assert nick == @live_nick
  end

  test "live_nick_index falls back to the credential nick with no live session" do
    user = user_fixture(name: "vjt-#{System.unique_integer([:positive])}")
    network = network_fixture()
    _ = credential_fixture(user, network, %{nick: @configured_nick})

    assert Networks.live_nick_index({:user, user.id}) == %{
             network.slug => {network.id, @configured_nick}
           }
  end

  test "live_nick_index falls back to the credential nick for a visitor with no live session" do
    # Visitor twin of the user fallback above: the `{:visitor, _}` clause of
    # live_nick_index is a distinct WHERE (visitor_id) + share the same
    # live-or-fallback resolver. With no live session up, the per-credential
    # resolve returns the CONFIGURED credential nick (#211-phase-6 visitors
    # are multi-network, so the seed is per-credential like the user path).
    network = network_fixture()
    visitor = visitor_with_credential_fixture(nick: @configured_nick, network_slug: network.slug)

    assert Networks.live_nick_index({:visitor, visitor.id}) == %{
             network.slug => {network.id, @configured_nick}
           }
  end

  test "#498 — badge counts a mention of the LIVE nick after /nick (starts counting the new)" do
    {subject, network} = start_renamed_session()

    anchor = insert(subject, network, "#chan", st: 1, sender: "alice", body: "morning all")
    insert(subject, network, "#chan", st: 2, sender: "bob", body: "#{@live_nick}: ping")
    set_cursor(subject, network, "#chan", anchor.id)

    # RED before C-prime: the badge resolves own_nick from the CONFIGURED
    # nick (@configured_nick), so a mention of the LIVE nick is not matched
    # → 0. After: the badge follows the live nick → 1.
    assert BadgeCount.count(subject) == 1
  end

  test "#498 — badge stops counting a mention of the OLD (configured) nick after /nick" do
    {subject, network} = start_renamed_session()

    anchor = insert(subject, network, "#chan", st: 1, sender: "alice", body: "morning all")
    insert(subject, network, "#chan", st: 2, sender: "bob", body: "#{@configured_nick}: ping")
    set_cursor(subject, network, "#chan", anchor.id)

    # RED before C-prime: the badge still matches the stale CONFIGURED nick
    # → counts the old-nick mention → 1. After: the live nick is @live_nick,
    # so the old nick is no longer the operator's identity → 0.
    assert BadgeCount.count(subject) == 0
  end

  describe "#514 — a self-rename re-keys inbound DM rows received under the old nick" do
    @peer "alice"

    # Seeds a DM window with `@peer` holding one read anchor and one unread
    # inbound message, BOTH received while the session still holds
    # `@configured_nick` (so both carry `channel = @configured_nick`, the
    # own-nick tag `Push.Triggers.dm?/2` reads back). Then renames.
    defp seed_dm_then_rename do
      {subject, network, server} = start_session_at_configured_nick()

      anchor =
        insert(subject, network, @configured_nick,
          st: 1,
          sender: @peer,
          body: "ciao",
          dm_with: @peer
        )

      insert(subject, network, @configured_nick,
        st: 2,
        sender: @peer,
        body: "ci sei?",
        dm_with: @peer
      )

      # The cursor lives on the PEER window — that is the window key of an
      # inbound DM, and it is exactly what the self-rename does NOT move.
      set_cursor(subject, network, @peer, anchor.id)

      :ok = force_self_rename(server)

      {subject, network}
    end

    test "the unread DM keeps its badge credit across the rename" do
      {subject, _} = seed_dm_then_rename()

      # RED before #514: the row's `channel` still tags the OLD nick, so
      # `dm?/2` compares it against the LIVE nick, misses, and routes the row
      # into the channel branch — where `channel_messages_all: false` and no
      # mention of the new nick in "ci sei?" mean it stops counting → 0.
      # After: the tag follows the identity, the row classifies as a DM, and
      # `private_messages_all: true` credits it → 1.
      assert BadgeCount.count(subject) == 1
    end

    # #514 REFUTATION PIN (1/2). The issue flagged the DM-window fetch as
    # "possibly also affected". It is not: an inbound row's window key is
    # `dm_with` (the peer), which a self-rename never touches. Both rows read
    # back under the peer window after the rename — asserted through the
    # production read path with the LIVE nick, the way the controller does.
    test "the peer DM window still returns the full pre-rename history" do
      {subject, network} = seed_dm_then_rename()

      bodies =
        subject
        |> Scrollback.fetch(network.id, @peer, nil, 100, @live_nick, false)
        |> Enum.map(& &1.body)
        |> Enum.sort()

      assert bodies == ["ci sei?", "ciao"]
    end

    # #514 REFUTATION PIN (2/2). A channel mention of the OLD nick is NOT
    # recoverable by any storage migration: the old nick lives in the message
    # BODY, which is prose, not a key — rewriting it would falsify history.
    # This is a documented boundary of #514, not a defect left unfixed, and
    # it is pinned so nobody later reads the re-keying as "mentions follow a
    # rename too". (The #498 twin above pins the same edge from the other
    # side; this one pins that #514's migration does not move it.)
    test "a channel mention of the OLD nick stays uncounted — bodies are not keys" do
      {subject, network, server} = start_session_at_configured_nick()

      anchor = insert(subject, network, "#chan", st: 1, sender: "bob", body: "morning all")

      insert(subject, network, "#chan", st: 2, sender: "bob", body: "#{@configured_nick}: ping")

      set_cursor(subject, network, "#chan", anchor.id)

      :ok = force_self_rename(server)

      assert BadgeCount.count(subject) == 0
    end
  end
end
