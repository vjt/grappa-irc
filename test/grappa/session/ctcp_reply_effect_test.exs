defmodule Grappa.Session.CtcpReplyEffectTest do
  @moduledoc """
  Issue 1988 — the `:reply` effect JUNCTION between `Session.EventRouter`
  (the producer) and `Session.Server.apply_effects/2` (the consumer).

  `apply_effects/2` has exactly one `:reply` clause and it takes the
  3-tuple `{:reply, line, origin}` the effect grammar declares (#1390
  slice 6). Four producers still emitted the pre-#1390 2-tuple
  `{:reply, line}`, and there is no catch-all `apply_effects` clause — so
  each of them killed the session GenServer with `function_clause`. An
  inbound `/ctcp <victim> USERINFO` from any user on the network was
  enough, with no opt-in and no authentication on the victim's side.

  ## Why these tests drive the real session and not `EventRouter.route/2`

  `event_router_test.exs` already covered all four sites, and every one of
  those tests passed while production died three times in one evening.
  They assert the CONTENT of the tuple the producer returns, in isolation,
  so they type-check the producer against itself: the defect lives in the
  junction, where a shape the producer is free to emit meets a consumer
  that cannot match it. A test that can stay green while the session dies
  is a mirror, not a test.

  So each test here feeds a real line into a real `Session.Server` over a
  real TCP socket (`Grappa.IRCServer`, the in-process fake ircd — never a
  `:gen_tcp` mock) and then asserts the two things the isolation tests
  structurally cannot see:

    * the answer actually reached the wire, and
    * the session pid that was serving before the CTCP is the SAME pid,
      still alive, afterwards.

  The pid identity half matters as much as the liveness half: `Session.Server`
  is `:transient`, so a crash is followed by a supervisor restart under a
  NEW pid that re-registers the same key. `Process.alive?/1` on a
  re-looked-up pid would therefore go green a few milliseconds after the
  very crash it is meant to catch.

  `async: false` because `Grappa.SessionRegistry`, `Grappa.SessionSupervisor`
  and `Grappa.PubSub` are singletons — same reason as `server_test.exs`.
  """
  use Grappa.DataCase, async: false

  import Grappa.AuthFixtures

  alias Grappa.{IRCServer, ServerSettings, Session}
  alias Grappa.Networks.{Credentials, SessionPlan}

  # The nick `credential_fixture/3` gives the session, and therefore the
  # nick the fake ircd must welcome and a peer must address.
  @nick "grappa-test"

  # One budget for every wire wait in this file. The fake ircd is
  # in-process over loopback; a second is three orders of magnitude of
  # headroom, and spelling it once keeps the file from re-deciding it per
  # call site the way #1397 found thirteen copies doing.
  @wire_timeout 1_000

  # A real 1x1 transparent PNG. `Credentials.set_avatar/4` runs the bytes
  # through `Grappa.Uploads` and its fail-closed `MetadataStrip`, so a
  # placeholder string would be rejected and the arrange step would fail
  # for a reason that has nothing to do with what is under test.
  @png Base.decode64!(
         "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg=="
       )

  describe "inbound CTCP queries survive the :reply effect junction (issue 1988)" do
    test "an inbound CTCP USERINFO is answered and does NOT kill the session" do
      # The reported P0, end to end: `/ctcp grappa-test USERINFO` from a
      # stranger. No profile is configured, which is the weakest case for
      # the victim and still a legitimate answer — an empty USERINFO
      # string means "nothing configured", so a reply is emitted and the
      # crash is reached.
      {server, pid} = connected_session([])

      IRCServer.feed(server, ":alice!u@h PRIVMSG #{@nick} :\x01USERINFO\x01\r\n")

      assert {:ok, line} =
               IRCServer.wait_for_line(
                 server,
                 &String.starts_with?(&1, "NOTICE alice :\x01USERINFO"),
                 @wire_timeout
               )

      assert line =~ "USERINFO"
      assert_same_session_alive(pid)
    end

    test "an inbound CTCP AVATAR is answered and does NOT kill the session" do
      # The AVATAR arm only replies when an avatar is SET (an unset avatar
      # is deliberately silent), so this test must arrange one or the
      # producer returns `[]`, the junction is never reached, and the test
      # goes green for the wrong reason. Measured while writing it: seeding
      # the plan with `:restored_avatar_url` does NOT work, because
      # `Session.Server.init/1` re-resolves the plan through the injected
      # `refresh_plan` closure and merges the FRESH plan OVER the opts —
      # the DB wins, and the DB said nil. So the avatar is set the way
      # production sets it, on the credential, before the plan is resolved.
      {server, pid} = connected_session(avatar: true)

      IRCServer.feed(server, ":alice!u@h PRIVMSG #{@nick} :\x01AVATAR\x01\r\n")

      assert {:ok, line} =
               IRCServer.wait_for_line(
                 server,
                 &String.starts_with?(&1, "NOTICE alice :\x01AVATAR"),
                 @wire_timeout
               )

      assert line =~ "/uploads/"
      assert_same_session_alive(pid)
    end
  end

  describe "outbound peer-profile queries survive the same junction (issue 1988)" do
    test "the outbound peer USERINFO query does NOT kill the session" do
      # The `show_peer_profiles` opt-in half. A peer JOINing a channel we
      # are in is the "first seen this session" moment that fires the lazy
      # CTCP query — so this path needs no inbound CTCP at all, and a
      # victim who never receives one is still exposed by it.
      {server, pid} = connected_session(show_peer_profiles: true)

      IRCServer.feed(server, ":alice!u@h JOIN #grappa\r\n")

      assert {:ok, _} =
               IRCServer.wait_for_line(
                 server,
                 &(String.trim_trailing(&1) == "PRIVMSG alice :\x01USERINFO\x01"),
                 @wire_timeout
               )

      assert_same_session_alive(pid)
    end

    test "the outbound peer AVATAR query does NOT kill the session" do
      # Sibling of the above: `maybe_query_peer_profile/2` fires BOTH
      # halves off the same JOIN, and each half emitted its own 2-tuple.
      # Asserted separately so a regression in one is not masked by the
      # other still being on the wire.
      {server, pid} = connected_session(show_peer_profiles: true)

      IRCServer.feed(server, ":alice!u@h JOIN #grappa\r\n")

      assert {:ok, _} =
               IRCServer.wait_for_line(
                 server,
                 &(String.trim_trailing(&1) == "PRIVMSG alice :\x01AVATAR\x01"),
                 @wire_timeout
               )

      assert_same_session_alive(pid)
    end
  end

  # Boots a registered session against a fresh fake ircd and returns
  # `{server, pid}`.
  #
  #   * `:avatar` — set a real avatar on the credential first, through
  #     `Credentials.set_avatar/4` (a real `Grappa.Uploads` row on the
  #     test storage root), so the resolved plan carries a real URL.
  #   * `:show_peer_profiles` — the M2 opt-in. Injected as a plan key
  #     rather than a `user_settings` row because `Session.start_session/3`
  #     reads it with `Map.put_new_lazy/3` precisely so a caller can
  #     supply it, and unlike `:restored_avatar_url` it is NOT a plan key
  #     the `refresh_plan` re-resolve overwrites.
  defp connected_session(opts) do
    {server, port} = IRCServer.start_server(IRCServer.welcome_handler(":irc", @nick))

    user = user_fixture(name: "vjt-#{System.unique_integer([:positive])}")

    {network, _} =
      network_with_server(port: port, slug: "test-#{System.unique_integer([:positive])}")

    _ = credential_fixture(user, network, %{})

    if Keyword.get(opts, :avatar, false) do
      {:ok, _} =
        Credentials.set_avatar(
          Credentials.get_credential!(user, network),
          @png,
          "image/png",
          ServerSettings.upload_caps()
        )
    end

    {:ok, resolved} = SessionPlan.resolve(Credentials.get_credential!(user, network))

    plan =
      case Keyword.fetch(opts, :show_peer_profiles) do
        {:ok, value} -> Map.put(resolved, :show_peer_profiles, value)
        :error -> resolved
      end

    subject = {:user, user.id}

    {:ok, pid} = Session.start_session(subject, network.id, plan)

    on_exit(fn -> Session.stop_session(subject, network.id) end)

    :ok = IRCServer.await_handshake(server, @wire_timeout)

    {server, pid}
  end

  # The session that answered must be the session that was asked. See the
  # moduledoc: a `:transient` child is restarted under a new pid, so
  # liveness alone is not evidence that nothing crashed.
  defp assert_same_session_alive(pid) do
    assert Process.alive?(pid)
  end
end
