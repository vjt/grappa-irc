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

  alias Grappa.{Dcc, IRCServer, Scrollback, Session, UserSettings}
  alias Grappa.Dcc.{Policy, Report}
  alias Grappa.Networks.{Credentials, SessionPlan}
  alias Grappa.PubSub.Topic
  alias Grappa.QueryWindows
  alias Grappa.RateLimit.DailyQuota

  @nick "grappa-test"
  @wire_timeout 1_000
  @public_ip "1.2.3.4"
  @filename "holiday.jpg"
  # The peer. Named rather than repeated as a literal: since issue 2127
  # this nick is a WINDOW KEY as well as a sender, so every assertion
  # about where a row landed has to name the same string the offer did.
  @peer "alice"
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
      # A policy-gate refusal has NO accept behind it, so it stays where
      # the offer rendered (issue 2127) — the `$server` window here.
      assert [refusal] = eventually_rows(ctx, "$server")
      assert refusal.body == Report.render({:refused, :rate_limited}, @peer).body
    end
  end

  describe "the transfer reports back through the session" do
    test "a failure lands as a row naming what went wrong, attributed to grappa" do
      ctx = held_offer()
      :ok = Session.accept_dcc_offer(ctx.subject, ctx.network.id, ctx.offer_id)

      send(ctx.pid, transfer_done(Dcc.mint_slug(), {:error, :connect_refused}))

      assert [row] = eventually_rows(ctx, @peer)
      assert row.body == Report.render({:failed, @filename, :connect_refused}, @peer).body
      assert row.kind == :server_event
      assert Process.alive?(ctx.pid)
    end

    test "a delivered file is spooled and handed over as the peer speaking" do
      ctx = held_offer()
      :ok = Session.accept_dcc_offer(ctx.subject, ctx.network.id, ctx.offer_id)
      slug = Dcc.mint_slug()

      send(ctx.pid, transfer_done(slug, {:ok, @size}))

      assert [row] = eventually_rows(ctx, @peer)
      assert row.sender == @peer
      assert row.kind == :privmsg
      assert row.body =~ Report.display_filename(@filename)
      assert row.body =~ slug

      assert {:ok, spooled} = Dcc.get_by_slug(slug)
      assert spooled.peer_nick == @peer
      assert spooled.bytes == @size
      assert spooled.filename == Report.display_filename(@filename)
      assert Process.alive?(ctx.pid)
    end

    test "a report for a transfer this session never started is ignored, not a crash" do
      ctx = connected_session()

      send(ctx.pid, transfer_done(Dcc.mint_slug(), {:error, :idle_timeout}))

      assert [_] = eventually_rows(ctx, @peer)
      assert Process.alive?(ctx.pid)
    end
  end

  describe "issue 2127 — where a POST-ACCEPT row is filed" do
    # The routing axis, asserted on BOTH sides of the consent line. A test
    # that only checked "the row exists" passed before this change too:
    # the row was there, in `$server`, which is the defect.

    test "the OFFER still renders in $server — #546 is untouched" do
      # The premise the rest of this describe is a departure from. If a
      # stranger's offer ever starts minting a window, these tests stop
      # measuring consent and start measuring nothing.
      ctx = held_offer()

      # The banner routes to `$server`, and the offer writes NO scrollback
      # row at all — it mints even less than a window. Both halves are the
      # premise: if either changed, the post-accept tests below would be
      # measuring something other than the consent line.
      assert ctx.channel == "$server"
      assert rows_in(ctx, "$server") == []
      refute QueryWindows.open?(ctx.subject, ctx.network.id, @peer)
    end

    test "a DELIVERED row lands in the query with the peer, not in $server" do
      ctx = held_offer()
      :ok = Session.accept_dcc_offer(ctx.subject, ctx.network.id, ctx.offer_id)
      slug = Dcc.mint_slug()

      send(ctx.pid, transfer_done(slug, {:ok, @size}))

      assert [row] = eventually_rows(ctx, @peer)
      assert row.body =~ slug

      # And it is NOT also in the home window. Asserted explicitly: the
      # bug was a row in the wrong place, so "present in the right place"
      # alone would still pass if it were filed in both.
      refute Enum.any?(rows_in(ctx, "$server"), &(&1.body =~ slug))
    end

    test "a FAILED row follows the delivered one — the accept is the consent" do
      ctx = held_offer()
      :ok = Session.accept_dcc_offer(ctx.subject, ctx.network.id, ctx.offer_id)

      send(ctx.pid, transfer_done(Dcc.mint_slug(), {:error, :idle_timeout}))

      failure = Report.render({:failed, @filename, :idle_timeout}, @peer).body

      assert [row] = eventually_rows(ctx, @peer)
      assert row.body == failure
      refute Enum.any?(rows_in(ctx, "$server"), &(&1.body == failure))
    end

    test "the query window is OPENED by the delivery, not merely written into" do
      # The row would otherwise land in a window with no tab in the
      # sidebar — scrollback nobody can navigate to.
      ctx = held_offer()
      refute QueryWindows.open?(ctx.subject, ctx.network.id, @peer)

      :ok = Session.accept_dcc_offer(ctx.subject, ctx.network.id, ctx.offer_id)
      send(ctx.pid, transfer_done(Dcc.mint_slug(), {:ok, @size}))

      window = eventually_window(ctx, @peer)

      # RAW-cased: a nick's case is presentation, and the fold lives on the
      # index rather than in the stored value.
      assert window.target_nick == @peer
      assert QueryWindows.open?(ctx.subject, ctx.network.id, @peer)
      assert [_] = eventually_rows(ctx, @peer)
    end

    test "an EXPIRED offer stays where the offer rendered — no accept behind it" do
      # The other half of the ruling, and the one that keeps #546 intact:
      # an unanswered banner must not mint a window for a stranger who
      # only had to send one DCC line.
      ctx = held_offer()

      send(ctx.pid, {:dcc_offer_expired, ctx.offer_id})

      assert [expiry] = eventually_rows(ctx, "$server")
      assert expiry.body == Report.render({:expired, @filename}, @peer).body
      refute QueryWindows.open?(ctx.subject, ctx.network.id, @peer)
      assert rows_in(ctx, @peer) == []
    end

    test "a PARSER-refused offer stays in $server — it never even reached the operator" do
      # The `:refused` arm the ruling names is the one with no accept
      # behind it: the parser or the policy gate turned the offer away.
      # Driven through a real wire line, not the operator's own refuse
      # verb — that one writes no row at all, by design, because the
      # operator already knows what they clicked.
      #
      # A passive (reverse) offer is the cheapest real refusal: port 0,
      # well-formed, declined on policy. It is also exactly the capability
      # #546 denies — one line from a stranger must not mint a window.
      ctx = connected_session()

      IRCServer.feed(
        ctx.server,
        ":#{@peer}!u@h PRIVMSG #{@nick} :\x01DCC SEND f.bin #{@public_ip} 0 1\x01\r\n"
      )

      assert [refusal] = eventually_rows(ctx, "$server")
      assert refusal.body == Report.render({:refused, :passive_unsupported}, @peer).body
      refute QueryWindows.open?(ctx.subject, ctx.network.id, @peer)
      assert rows_in(ctx, @peer) == []
    end
  end

  describe "issue 2143 — per-network auto-accept, restricted to known peers" do
    test "the opt-in is OFF by default — even a known peer raises a banner" do
      ctx = auto_accept_ctx(known_peer: true)

      feed_dcc_send(ctx)

      assert_receive %Phoenix.Socket.Broadcast{payload: %{kind: :dcc_offer}}, @wire_timeout
      assert accepts_recorded(ctx.subject) == 0
    end

    test "a STRANGER keeps the banner with the opt-in ON — #546 is untouched" do
      # The load-bearing test of this slice. The wide variant of 2143 —
      # auto-accept for any peer, quota-only — is a relaxation of the
      # consent ruling and was NOT built; if the query-window conjunct ever
      # goes, this is what reddens.
      ctx = auto_accept_ctx(enabled_slug: :self)

      # A stranger BY CONSTRUCTION: the 2127 describe above measures that a
      # stranger's offer mints no window, so there is nothing to undo here.
      refute QueryWindows.open?(ctx.subject, ctx.network.id, @peer)

      feed_dcc_send(ctx)

      assert_receive %Phoenix.Socket.Broadcast{payload: %{kind: :dcc_offer}}, @wire_timeout
      assert {:ok, [_held]} = Session.list_dcc_offers(ctx.subject, ctx.network.id)
      assert accepts_recorded(ctx.subject) == 0
    end

    test "opt-in plus an open query window skips the banner and SPENDS the accept" do
      ctx = auto_accept_ctx(enabled_slug: :self, known_peer: true)

      feed_dcc_send(ctx)

      # The POSITIVE half first, and it is why this test is not just two
      # refutations: an auto-accept mints no handle and raises no banner, so
      # the spent quota slot is the only synchronous evidence the offer
      # reached `Policy.admit_accept/1` at all. Without it, "no banner" would
      # go green on an offer silently DROPPED — the one outcome 2089 forbids.
      assert eventually_accepts_recorded(ctx.subject, 1)

      refute_receive %Phoenix.Socket.Broadcast{payload: %{kind: :dcc_offer}}, 200
      assert {:ok, []} = Session.list_dcc_offers(ctx.subject, ctx.network.id)
    end

    test "an auto-accept the quota refuses still REPORTS — no silent outcome" do
      ctx = auto_accept_ctx(enabled_slug: :self, known_peer: true)
      exhaust_daily_quota(ctx.subject)

      feed_dcc_send(ctx)

      # The refusal renders in the PEER's query window, and the conjunct
      # FORCES that rather than this test choosing it: `ctcp_query_channel/3`
      # routes an inbound CTCP to `$server` only when there is NO open query
      # with the sender (#546), and the auto-accept arm requires exactly such
      # a window. So an auto-accept refusal can never land in `$server` —
      # which is why the sibling `:passive_unsupported` test above asserts
      # that window and this one cannot: its peer is a STRANGER.
      #
      # What stays identical is the only thing the funnel promises — the
      # BODY. Skipping the human must not change what the human is told.
      assert [refusal] = eventually_rows(ctx, @peer)
      assert refusal.body == Report.render({:refused, :rate_limited}, @peer).body
      assert rows_in(ctx, "$server") == []
      refute_receive %Phoenix.Socket.Broadcast{payload: %{kind: :dcc_offer}}, 200
    end

    test "the opt-in is per NETWORK — arming another network leaves this one asking" do
      ctx = auto_accept_ctx(enabled_slug: "some-other-network", known_peer: true)

      feed_dcc_send(ctx)

      assert_receive %Phoenix.Socket.Broadcast{payload: %{kind: :dcc_offer}}, @wire_timeout
      assert accepts_recorded(ctx.subject) == 0
    end
  end

  # The exact message `Session.Server`'s detached task sends back. Spelled
  # here so a change to that tuple breaks these tests loudly rather than
  # leaving them green against a shape nothing emits.
  #
  # issue 2127 dropped the `channel` element: post-accept there is no
  # inherited window to carry, every row the transfer can produce belongs
  # to the query with `from`, and a field nothing reads is a field the
  # next reader will file a row into.
  defp transfer_done(slug, result) do
    {:dcc_transfer_done, slug, @peer, @filename, result}
  end

  # Spends the subject's whole allowance through the PRODUCTION verb, so
  # the test cannot drift from what the door actually checks.
  defp exhaust_daily_quota(subject) do
    for _ <- 1..Policy.daily_accepts(), do: :ok = Policy.admit_accept(subject)
  end

  # Reads the quota counter WITHOUT spending it (issue 2143).
  #
  # `Policy.admit_accept/1` is check-and-record in one call, so polling the
  # quota THROUGH it would take the very slot the assertion is about: the
  # test would then go green because IT spent the allowance, while the
  # auto-accept it was measuring got rate-limited. The ETS table is public
  # and named, and reading a rate-limit table straight is what
  # `AdmissionStateHelpers` already does for the network circuit.
  defp accepts_recorded(subject) do
    case :ets.lookup(DailyQuota.table_name(), {Policy.quota_bucket(), subject}) do
      [{_key, _date, count}] -> count
      _ -> 0
    end
  end

  defp eventually_accepts_recorded(subject, want),
    do: eventually_accepts_recorded(subject, want, 50)

  defp eventually_accepts_recorded(subject, want, 0) do
    flunk(
      "quota recorded #{accepts_recorded(subject)} accept(s), wanted #{want} — " <>
        "the auto-accept never reached Policy.admit_accept/1"
    )
  end

  defp eventually_accepts_recorded(subject, want, tries) do
    if accepts_recorded(subject) >= want do
      true
    else
      Process.sleep(20)
      eventually_accepts_recorded(subject, want, tries - 1)
    end
  end

  # The wire half of `held_offer/0`, split out so the 2143 tests can feed a
  # real offer and then REFUSE to receive a banner — `held_offer/0` asserts
  # one arrives, which is the opposite of what an auto-accept must do.
  defp feed_dcc_send(ctx) do
    IRCServer.feed(
      ctx.server,
      ":#{@peer}!u@h PRIVMSG #{@nick} :\x01DCC SEND #{@filename} #{@public_ip} 5000 #{@size}\x01\r\n"
    )
  end

  # Feeds a real DCC SEND and returns the context plus the handle and the
  # payload the live event carried.
  defp held_offer do
    ctx = connected_session()
    :ok = Phoenix.PubSub.subscribe(Grappa.PubSub, Topic.user(ctx.user.name))

    feed_dcc_send(ctx)

    assert_receive %Phoenix.Socket.Broadcast{payload: %{kind: :dcc_offer} = payload},
                   @wire_timeout

    Map.merge(ctx, %{offer_id: payload.offer_id, live_payload: payload, channel: payload.channel})
  end

  # The 2143 staging: a connected session, subscribed, with the opt-in and
  # the query window set exactly as the case under test wants them.
  #
  # `enabled_slug: :self` arms THIS session's network; a literal slug arms a
  # different one, which is how the per-network test proves the key is not
  # global. Absent, nothing is armed — the default-off case.
  defp auto_accept_ctx(opts) do
    ctx = connected_session()

    case opts[:enabled_slug] do
      nil -> :ok
      :self -> {:ok, _} = UserSettings.put_dcc_auto_accept(ctx.subject, ctx.network.slug, true)
      slug -> {:ok, _} = UserSettings.put_dcc_auto_accept(ctx.subject, slug, true)
    end

    if opts[:known_peer] do
      {:ok, _} = QueryWindows.open(ctx.subject, ctx.network.id, @peer, ctx.user.name)
    end

    :ok = Phoenix.PubSub.subscribe(Grappa.PubSub, Topic.user(ctx.user.name))
    ctx
  end

  # Polls one window until it holds at least `want` rows. `want` is a
  # parameter rather than "non-empty" because issue 2127 made the counts
  # matter: an expiry leaves TWO rows in `$server` (the offer's own, then
  # the expiry), and a poll that stopped at the first would read the
  # offer row and assert against it.
  defp eventually_rows(ctx, channel), do: eventually_rows(ctx, channel, 1)

  defp eventually_rows(ctx, channel, want), do: eventually_rows(ctx, channel, want, 50)

  defp eventually_rows(ctx, channel, _, 0), do: rows_in(ctx, channel)

  defp eventually_rows(ctx, channel, want, tries) do
    rows = rows_in(ctx, channel)

    if length(rows) >= want do
      rows
    else
      Process.sleep(20)
      eventually_rows(ctx, channel, want, tries - 1)
    end
  end

  defp rows_in(ctx, channel) do
    Scrollback.fetch(ctx.subject, ctx.network.id, channel, nil, 50, @nick, false)
  end

  # Polls for the query window itself rather than inferring it from the
  # row. MEASURED, not defensive: `apply_effects/2` persists the row and
  # THEN opens the window (#422 orders it that way deliberately, so the
  # `query_windows_list` broadcast is a truthful "history already landed"
  # barrier), so a poll that stops at the row can land in the gap between
  # the two and read an empty window list — which is exactly what this
  # test did before, deterministically. The row is not evidence of the
  # window; only the window is.
  defp eventually_window(ctx, nick), do: eventually_window(ctx, nick, 50)

  defp eventually_window(ctx, nick, 0) do
    flunk("no query window for #{nick} after waiting; windows: #{inspect(windows(ctx))}")
  end

  defp eventually_window(ctx, nick, tries) do
    case Enum.find(windows(ctx), &(&1.target_nick == nick)) do
      nil ->
        Process.sleep(20)
        eventually_window(ctx, nick, tries - 1)

      window ->
        window
    end
  end

  defp windows(ctx) do
    ctx.subject |> QueryWindows.list_for_subject() |> Map.get(ctx.network.id, [])
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
