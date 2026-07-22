defmodule GrappaWeb.NotifyControllerLiveTest do
  @moduledoc """
  Live-session slice of the `/notify` controller (#364 web S5).

  A fold-duplicate re-add must NOT re-emit `MONITOR +`/`WATCH +` upstream:
  the `pre_folds` snapshot + `Enum.reject` in `NotifyController.create/2`
  exists solely to suppress it (review nit 2026-07-19, commit `5e916515`).
  No test pinned the behaviour — the async `notify_controller_test`
  "idempotent" case checks only the HTTP/DB outcome, and `server_test`'s
  `notify_changed` case drives the Session facade with a pre-computed diff.
  So someone simplifying `create/2` to pass `nicks` verbatim would keep
  every other test green while the fixed bug (a redundant registration
  storm on every duplicate add) returns. This drives the controller → live
  session → upstream path end-to-end and asserts the quiet re-add.

  `async: false` — Session uses singleton supervisors + Registry (same
  rationale as `MembersControllerTest` / `Grappa.Session.ServerTest`).
  """
  use GrappaWeb.ConnCase, async: false

  import Grappa.AuthFixtures

  alias Grappa.IRCServer

  # Passthrough fake ircd — registration + presence numerics are fed
  # explicitly so the test controls the WATCH-vs-MONITOR mechanism.
  defp start_server do
    {:ok, server} = IRCServer.start_link(fn state, _ -> {:reply, nil, state} end)
    {server, IRCServer.port(server)}
  end

  defp flush(server) do
    token = "flush-#{System.unique_integer([:positive])}"
    IRCServer.feed(server, "PING :#{token}\r\n")
    {:ok, _} = IRCServer.wait_for_line(server, &(&1 == "PONG :#{token}\r\n"), 1_000)
  end

  defp watch_add_count(server) do
    Enum.count(IRCServer.sent_lines(server), &String.starts_with?(&1, "WATCH +"))
  end

  setup %{conn: conn} do
    user = user_fixture(name: "notify-live-#{System.unique_integer([:positive])}")
    session = session_fixture(user)
    {:ok, conn: put_bearer(conn, session.id), user: user}
  end

  test "a fold-duplicate re-add emits no second WATCH + upstream (#364 web S5)", %{
    conn: conn,
    user: user
  } do
    {server, port} = start_server()
    slug = "notify-live-net-#{System.unique_integer([:positive])}"
    {network, _} = network_with_server(port: port, slug: slug)
    _ = credential_fixture(user, network, %{nick: "grappa-test", autojoin_channels: []})

    _ = start_session_for(user, network)

    # Welcome past 005 (WATCH advertised) + end-of-MOTD. The DB watch list
    # is empty here, so arm_presence sends no burst — the WATCH lines below
    # come purely from the controller's live notify_changed sync.
    {:ok, _} = IRCServer.wait_for_line(server, &String.starts_with?(&1, "USER"), 1_000)
    IRCServer.feed(server, ":irc.test.org 001 grappa-test :Welcome\r\n")
    IRCServer.feed(server, ":irc.test.org 005 grappa-test WATCH=128 :are supported\r\n")
    IRCServer.feed(server, ":irc.test.org 376 grappa-test :End of MOTD\r\n")
    flush(server)

    # First add → exactly one WATCH +Foo upstream.
    conn
    |> post("/networks/#{network.slug}/notify", %{"nicks" => ["Foo"]})
    |> json_response(201)

    {:ok, _} = IRCServer.wait_for_line(server, &(&1 == "WATCH +Foo\r\n"), 1_000)
    assert watch_add_count(server) == 1

    # Fold-duplicate re-add ("foo" folds onto "Foo") → the controller diff
    # is [], so notify_changed sends NOTHING: the WATCH-add count is
    # unchanged. Pre-fix (verbatim nicks) this would re-send WATCH +foo.
    conn
    |> post("/networks/#{network.slug}/notify", %{"nicks" => ["foo"]})
    |> json_response(201)

    flush(server)
    assert watch_add_count(server) == 1

    :ok = Grappa.Session.stop_session({:user, user.id}, network.id)
  end
end
