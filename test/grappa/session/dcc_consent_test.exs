defmodule Grappa.Session.DccConsentTest do
  @moduledoc """
  issue 2089 — the CONSENT doors: what the operator's accept, refuse and
  list actually do to a held offer, driven through the real session.

  ## What is constructible here, and what is not

  Every test below reaches the held set the only way production does: an
  inbound `DCC SEND` over a real socket into a real `Session.Server`.
  There is deliberately no seam to plant one.

  That has a consequence worth stating rather than working around.
  `Grappa.Dcc.Policy.admit_offer/1` refuses a loopback address — that is
  the SSRF property, and it is absolute — so an offer that reaches the
  held set can never point at a fake sender this test could run. **The
  happy accept leg (bytes arrive → spool row → delivered link) is
  therefore not end-to-end constructible**, and it is not faked here. The
  transport is covered against a real fake sender in
  `Grappa.Dcc.TransferTest`; what this file covers is the SESSION's half,
  including the junction the task reports back through
  (`{:dcc_transfer_done, …}`), driven with the exact message the task
  sends.

  `async: false` because `Grappa.SessionRegistry`,
  `Grappa.SessionSupervisor`, `Grappa.PubSub` and
  `Grappa.RateLimit.DailyQuota` are singletons.
  """
  use Grappa.DataCase, async: false

  import Grappa.AuthFixtures

  alias Grappa.{Dcc, IRCServer, Scrollback, Session}
  alias Grappa.Dcc.{Policy, Report}
  alias Grappa.Networks.{Credentials, SessionPlan}
  alias Grappa.PubSub.Topic

  @nick "grappa-test"
  @wire_timeout 1_000
  @public_ip "1.2.3.4"
  @filename "holiday.jpg"
  @size 12_345

  describe "refuse — the operator declines" do
    test "resolves the offer on every device and stops holding it" do
      ctx = held_offer()

      assert :ok = Session.refuse_dcc_offer(ctx.subject, ctx.network.id, ctx.offer_id)

      assert_receive %Phoenix.Socket.Broadcast{
                       payload: %{kind: :dcc_offer_resolved, resolution: :refused, offer_id: id}
                     },
                     @wire_timeout

      assert id == ctx.offer_id
      assert {:ok, []} = Session.list_dcc_offers(ctx.subject, ctx.network.id)
    end

    test "a second refusal of the same handle is a 404, not a silent success" do
      ctx = held_offer()
      :ok = Session.refuse_dcc_offer(ctx.subject, ctx.network.id, ctx.offer_id)

      assert {:error, :not_held} =
               Session.refuse_dcc_offer(ctx.subject, ctx.network.id, ctx.offer_id)
    end

    test "a handle that names nothing is refused, never swallowed" do
      ctx = held_offer()

      assert {:error, :not_held} =
               Session.refuse_dcc_offer(ctx.subject, ctx.network.id, "nosuchofferhandleatall")
    end

    test "nothing is sent upstream — the peer learns nothing" do
      ctx = held_offer()

      :ok = Session.refuse_dcc_offer(ctx.subject, ctx.network.id, ctx.offer_id)

      # A `DCC REJECT` would confirm to an unsolicited stranger both that
      # this nick is online AND that a human read their offer. Silence is
      # indistinguishable from away / offline / no-DCC-client.
      assert {:error, :timeout} =
               IRCServer.wait_for_line(ctx.server, &String.contains?(&1, "DCC"), 200)
    end
  end

  describe "list — the cold-subscribe backfill and the REST index" do
    test "carries the held offer with the same payload the live event did" do
      ctx = held_offer()

      assert {:ok, [payload]} = Session.list_dcc_offers(ctx.subject, ctx.network.id)

      assert payload == ctx.live_payload
    end

    test "an empty held set lists nothing" do
      ctx = connected_session()

      assert {:ok, []} = Session.list_dcc_offers(ctx.subject, ctx.network.id)
    end
  end

  describe "the cold-subscribe snapshot" do
    # Without this the banner evaporates on reload and the offer lapses
    # unanswered — #482 in a second costume. It rides the SAME snapshot
    # call as `invited_windows` rather than a sibling one, because #482
    # measured what a second serial blocking call per network does to the
    # login hot path.
    test "carries the held offers, in the same payload the live event used" do
      ctx = held_offer()

      assert {:ok, snapshot} = Session.session_snapshot(ctx.subject, ctx.network.id)

      assert snapshot.held_dcc_offers == [ctx.live_payload]
    end

    test "carries nothing when nothing is held" do
      ctx = connected_session()

      assert {:ok, snapshot} = Session.session_snapshot(ctx.subject, ctx.network.id)

      assert snapshot.held_dcc_offers == []
    end

    test "stops carrying an offer the moment it is resolved" do
      ctx = held_offer()
      :ok = Session.refuse_dcc_offer(ctx.subject, ctx.network.id, ctx.offer_id)

      assert {:ok, snapshot} = Session.session_snapshot(ctx.subject, ctx.network.id)

      assert snapshot.held_dcc_offers == []
    end
  end

  describe "accept — the operator consents" do
    test "resolves the offer as accepted and stops holding it" do
      ctx = held_offer()

      assert :ok = Session.accept_dcc_offer(ctx.subject, ctx.network.id, ctx.offer_id)

      assert_receive %Phoenix.Socket.Broadcast{
                       payload: %{kind: :dcc_offer_resolved, resolution: :accepted}
                     },
                     @wire_timeout

      assert {:ok, []} = Session.list_dcc_offers(ctx.subject, ctx.network.id)
    end

    test "a handle that names nothing is a 404" do
      ctx = held_offer()

      assert {:error, :not_held} =
               Session.accept_dcc_offer(ctx.subject, ctx.network.id, "nosuchofferhandleatall")
    end

    test "an exhausted daily quota refuses the accept, resolves the banner, and says why" do
      ctx = held_offer()
      exhaust_daily_quota(ctx.subject)

      assert {:error, :rate_limited} =
               Session.accept_dcc_offer(ctx.subject, ctx.network.id, ctx.offer_id)

      # The banner must still come down — the offer is gone from the held
      # set either way, and a device left showing it would re-offer a file
      # nothing will ever deliver.
      assert_receive %Phoenix.Socket.Broadcast{
                       payload: %{kind: :dcc_offer_resolved, resolution: :refused}
                     },
                     @wire_timeout

      assert {:ok, []} = Session.list_dcc_offers(ctx.subject, ctx.network.id)
      assert [row] = eventually_rows(ctx)
      assert row.body == Report.render({:refused, :rate_limited}, "alice").body
    end
  end

  describe "the transfer reports back through the session" do
    test "a failure lands as a row naming what went wrong, attributed to grappa" do
      ctx = held_offer()
      :ok = Session.accept_dcc_offer(ctx.subject, ctx.network.id, ctx.offer_id)

      send(ctx.pid, transfer_done(ctx, Dcc.mint_slug(), {:error, :connect_refused}))

      assert [row] = eventually_rows(ctx)
      assert row.body == Report.render({:failed, @filename, :connect_refused}, "alice").body
      assert row.kind == :server_event
      assert Process.alive?(ctx.pid)
    end

    test "a delivered file is spooled and handed over as the peer speaking" do
      ctx = held_offer()
      :ok = Session.accept_dcc_offer(ctx.subject, ctx.network.id, ctx.offer_id)
      slug = Dcc.mint_slug()

      send(ctx.pid, transfer_done(ctx, slug, {:ok, @size}))

      assert [row] = eventually_rows(ctx)
      assert row.sender == "alice"
      assert row.kind == :privmsg
      assert row.body =~ Report.display_filename(@filename)
      assert row.body =~ slug

      assert {:ok, spooled} = Dcc.get_by_slug(ctx.subject, ctx.network.id, slug)
      assert spooled.peer_nick == "alice"
      assert spooled.bytes == @size
      assert spooled.filename == Report.display_filename(@filename)
      assert Process.alive?(ctx.pid)
    end

    test "a report for a transfer this session never started is ignored, not a crash" do
      ctx = connected_session()

      send(ctx.pid, transfer_done(ctx, Dcc.mint_slug(), {:error, :idle_timeout}))

      assert [_] = eventually_rows(ctx)
      assert Process.alive?(ctx.pid)
    end
  end

  # The exact message `Session.Server`'s detached task sends back. Spelled
  # here so a change to that tuple breaks these tests loudly rather than
  # leaving them green against a shape nothing emits.
  defp transfer_done(ctx, slug, result) do
    {:dcc_transfer_done, slug, "alice", ctx.channel, @filename, result}
  end

  # Spends the subject's whole allowance through the PRODUCTION verb, so
  # the test cannot drift from what the door actually checks.
  defp exhaust_daily_quota(subject) do
    for _ <- 1..Policy.daily_accepts(), do: :ok = Policy.admit_accept(subject)
  end

  # Feeds a real DCC SEND and returns the context plus the handle and the
  # payload the live event carried.
  defp held_offer do
    ctx = connected_session()
    :ok = Phoenix.PubSub.subscribe(Grappa.PubSub, Topic.user(ctx.user.name))

    IRCServer.feed(
      ctx.server,
      ":alice!u@h PRIVMSG #{@nick} :\x01DCC SEND #{@filename} #{@public_ip} 5000 #{@size}\x01\r\n"
    )

    assert_receive %Phoenix.Socket.Broadcast{payload: %{kind: :dcc_offer} = payload},
                   @wire_timeout

    Map.merge(ctx, %{offer_id: payload.offer_id, live_payload: payload, channel: payload.channel})
  end

  defp eventually_rows(ctx), do: eventually_rows(ctx, 50)

  defp eventually_rows(ctx, 0), do: server_rows(ctx)

  defp eventually_rows(ctx, tries) do
    case server_rows(ctx) do
      [] ->
        Process.sleep(20)
        eventually_rows(ctx, tries - 1)

      rows ->
        rows
    end
  end

  defp server_rows(ctx) do
    Scrollback.fetch(ctx.subject, ctx.network.id, "$server", nil, 50, @nick, false)
  end

  defp connected_session do
    {server, port} = IRCServer.start_server(IRCServer.welcome_handler(":irc", @nick))

    user = user_fixture(name: "vjt-#{System.unique_integer([:positive])}")

    {network, _} =
      network_with_server(port: port, slug: "test-#{System.unique_integer([:positive])}")

    _ = credential_fixture(user, network, %{})
    {:ok, plan} = SessionPlan.resolve(Credentials.get_credential!(user, network))

    subject = {:user, user.id}
    {:ok, pid} = Session.start_session(subject, network.id, plan)
    on_exit(fn -> Session.stop_session(subject, network.id) end)

    :ok = IRCServer.await_handshake(server, @wire_timeout)

    %{server: server, pid: pid, user: user, network: network, subject: subject, channel: "$server"}
  end
end
