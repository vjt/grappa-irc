defmodule Grappa.Unread2037ProbeTest do
  @moduledoc """
  issue 2037 — MEASUREMENT INSTRUMENT, not a regression test.

  The report has three numbers on one screen for what the operator reads as
  one quantity (`1807` in the far-behind bar, `187` + `216` in the sidebar
  pills) and the issue body says in as many words that own-authored rows
  plus the content/events split do NOT account for the `1807 - 403 = 1404`
  residual. This file measures the residual TERM BY TERM against a real
  `messages` table, so the residual stops being a guess.

  It measures the three counting doors the two surfaces reach:

    * `Scrollback.count_after/6`        — the bar (`GET …/messages/count`)
    * `Scrollback.count_after_split/6`  — the join-reply / per-message badge
    * `ReadCursor.bulk_unread_split/3`  — the `/me` cold-load badge seed

  ## Controls run FIRST and gate the print

  Nothing is printed unless BOTH controls hold, because a harness that
  mis-seeds its own fixture prints a number that describes the harness:

    * NEGATIVE — a window whose rows are all peer content, one anchor, one
      presence posture: every door must return the SAME total. A non-zero
      residual here means the fixture, not the code, is divergent.
    * POSITIVE — the same window plus K own-authored content rows: the
      residual must be EXACTLY K. A residual that is merely non-zero would
      pass a harness that is off by an unrelated term.

  Both are asserted before the first `IO.puts`. `mix test` failure IS the
  abort path: an assertion raises and the reporting block never runs.
  """
  use Grappa.DataCase, async: true

  import Grappa.AuthFixtures, only: [user_fixture: 0, network_fixture: 0]

  alias Grappa.PresenceFilter.Resolver
  alias Grappa.{ReadCursor, Scrollback, ScrollbackHelpers}
  alias Grappa.Scrollback.Message

  # A Session.Server stand-in registered under the real registry key, so
  # `Resolver.hidden?/4` and `Resolver.hidden_channels/3` reach it through the
  # production `Grappa.Session` facade rather than through a mock of the
  # resolver itself. Its whole purpose is that the two calls can be answered
  # INDEPENDENTLY — which is the question being measured.
  defmodule SessionStub do
    @moduledoc false
    use GenServer

    @spec start_link({Grappa.Subject.t(), integer(), map()}) :: GenServer.on_start()
    def start_link({subject, network_id, replies}) do
      GenServer.start_link(__MODULE__, replies,
        name: {:via, Registry, {Grappa.SessionRegistry, Grappa.Session.registry_key(subject, network_id)}}
      )
    end

    @impl GenServer
    def init(replies), do: {:ok, replies}

    @impl GenServer
    def handle_call({:list_members, _}, _, replies),
      do: {:reply, Map.fetch!(replies, :list_members), replies}

    def handle_call(:list_member_counts, _, replies),
      do: {:reply, Map.fetch!(replies, :list_member_counts), replies}
  end

  @own_nick "vjt"
  @channel "#sniffo"

  # ---------------------------------------------------------------------------
  # Fixture
  # ---------------------------------------------------------------------------

  # One window, seeded row by row so every population is known by
  # construction. `server_time` doubles as the sequence number; ids come out
  # monotonic because the inserts are serial.
  defp seed_window(subject_attrs, network_id, spec) do
    peer_content = Keyword.fetch!(spec, :peer_content)
    peer_presence = Keyword.fetch!(spec, :peer_presence)
    own_content = Keyword.fetch!(spec, :own_content)
    own_presence = Keyword.fetch!(spec, :own_presence)
    peer_topic = Keyword.fetch!(spec, :peer_topic)

    anchor = insert_row(subject_attrs, network_id, 0, :privmsg, "peer", "anchor")

    rows =
      Enum.flat_map(
        [
          {peer_content, :privmsg, "peer"},
          {peer_presence, :join, "peer"},
          {own_content, :privmsg, @own_nick},
          {own_presence, :part, @own_nick},
          {peer_topic, :topic, "peer"}
        ],
        fn {n, kind, sender} -> for _ <- 1..n//1, do: {kind, sender} end
      )

    rows
    |> Enum.with_index(1)
    |> Enum.each(fn {{kind, sender}, i} ->
      insert_row(subject_attrs, network_id, i, kind, sender, "row-#{i}")
    end)

    anchor.id
  end

  defp insert_row(subject_attrs, network_id, server_time, kind, sender, body) do
    attrs =
      Map.merge(subject_attrs, %{
        network_id: network_id,
        channel: @channel,
        server_time: server_time,
        kind: kind,
        sender: sender,
        body: body
      })

    {:ok, message} = ScrollbackHelpers.insert(attrs)
    message
  end

  # ---------------------------------------------------------------------------
  # The three doors, at a caller-chosen anchor and presence posture
  # ---------------------------------------------------------------------------

  defp bar(subject, network_id, anchor, hide_presence),
    do: Scrollback.count_after(subject, network_id, @channel, anchor, @own_nick, hide_presence, nil)

  defp split(subject, network_id, anchor, hide_presence) do
    %{messages: m, events: e} =
      Scrollback.count_after_split(subject, network_id, @channel, anchor, @own_nick, hide_presence)

    %{messages: m, events: e, total: m + e}
  end

  defp bulk(subject, network_id, slug, hide_presence?) do
    hidden =
      if hide_presence?, do: %{slug => MapSet.new([@channel])}, else: %{}

    %{messages: m, events: e} =
      subject
      |> ReadCursor.bulk_unread_split(%{slug => {network_id, @own_nick}}, hidden)
      |> get_in([slug, @channel])

    %{messages: m, events: e, total: m + e}
  end

  # ---------------------------------------------------------------------------
  # The measurement
  # ---------------------------------------------------------------------------

  test "issue 2037 — decompose the bar-vs-badge residual, term by term" do
    user = user_fixture()
    net = network_fixture()
    subject = {:user, user.id}
    attrs = %{user_id: user.id}

    # A single window with every population present and distinct in size, so
    # no term can be confused with another by coincidence of magnitude.
    pop = [peer_content: 7, peer_presence: 61, own_content: 5, own_presence: 3, peer_topic: 2]
    anchor = seed_window(attrs, net.id, pop)
    {:ok, _} = ReadCursor.set(subject, net.id, @channel, anchor)

    total_rows = Enum.sum(Keyword.values(pop))
    own_rows = pop[:own_content] + pop[:own_presence]
    suppressed_rows = pop[:peer_presence] + pop[:own_presence]

    # -- CONTROLS ------------------------------------------------------------
    # NEGATIVE: a second window with peer content only. One anchor, one
    # posture, no own rows, no presence rows -> every door must agree.
    ctrl_user = user_fixture()
    ctrl_subject = {:user, ctrl_user.id}
    ctrl_attrs = %{user_id: ctrl_user.id}

    ctrl_anchor =
      seed_window(ctrl_attrs, net.id,
        peer_content: 9,
        peer_presence: 0,
        own_content: 0,
        own_presence: 0,
        peer_topic: 0
      )

    {:ok, _} = ReadCursor.set(ctrl_subject, net.id, @channel, ctrl_anchor)

    neg_bar = bar(ctrl_subject, net.id, ctrl_anchor, false)
    neg_split = split(ctrl_subject, net.id, ctrl_anchor, false)
    neg_bulk = bulk(ctrl_subject, net.id, net.slug, false)

    assert neg_bar == 9, "NEG CTRL: the bar does not see the seeded population"
    assert neg_bar - neg_split.total == 0, "NEG CTRL: bar vs per-window split diverged with nothing to diverge on"
    assert neg_bar - neg_bulk.total == 0, "NEG CTRL: bar vs bulk seed diverged with nothing to diverge on"

    # POSITIVE: the real window, same anchor, same posture. The residual must
    # be EXACTLY the own-authored population — not merely non-zero.
    pos_bar = bar(subject, net.id, anchor, false)
    pos_split = split(subject, net.id, anchor, false)

    assert pos_bar == total_rows,
           "POS CTRL: the bar counted #{pos_bar} of #{total_rows} seeded rows"

    assert pos_bar - pos_split.total == own_rows,
           "POS CTRL: residual #{pos_bar - pos_split.total} != own-authored #{own_rows} — " <>
             "the harness carries an unaccounted term of its own"

    # -- TERMS ---------------------------------------------------------------
    # T1 — own-authored, the term the issue body names. Same anchor, same
    # posture; the ONLY predicate difference between the two doors.
    t1 = pos_bar - pos_split.total

    # T2 — presence posture. The bar resolves `hide_presence` through
    # `Resolver.hidden?/4` (one GenServer call, at probe time); the seed
    # resolves it through `Resolver.hidden_channels/3` (a different call, at
    # /me time). Same rule module, two inputs, two instants. This measures
    # what ONE disagreement costs.
    t2_bulk_hidden = bulk(subject, net.id, net.slug, true)
    t2 = pos_bar - t2_bulk_hidden.total - t1

    # T3 — the anchor. Measured as a SIGN, not just a size: `count_after/6`
    # is monotone non-increasing in the anchor, so an anchor that differs can
    # only ever move the bar in ONE direction.
    later_anchor = anchor + 30
    t3_bar_later = bar(subject, net.id, later_anchor, false)
    t3 = pos_bar - t3_bar_later

    # T4 — the bulk seed vs the per-window split at the same anchor and the
    # same posture. `bulk_unread_split/3`'s docstring claims these are
    # IDENTICAL for a channel window; this is that claim, measured.
    pos_bulk = bulk(subject, net.id, net.slug, false)
    t4 = pos_split.total - pos_bulk.total

    # T5 — scaling. A term that grows with the channel's traffic can carry a
    # 1404-row residual; one that grows with the OPERATOR's traffic cannot.
    scale_user = user_fixture()
    scale_subject = {:user, scale_user.id}

    scale_anchor =
      seed_window(%{user_id: scale_user.id}, net.id,
        peer_content: 7,
        peer_presence: 610,
        own_content: 5,
        own_presence: 3,
        peer_topic: 2
      )

    {:ok, _} = ReadCursor.set(scale_subject, net.id, @channel, scale_anchor)
    scale_bar = bar(scale_subject, net.id, scale_anchor, false)
    scale_t1 = scale_bar - split(scale_subject, net.id, scale_anchor, false).total
    scale_t2 = scale_bar - bulk(scale_subject, net.id, net.slug, true).total - scale_t1

    # -- REPORT --------------------------------------------------------------
    IO.puts("""

    ================================================================
    issue 2037 — bar-vs-badge residual, measured at #{Mix.env()} on a real
    `messages` table. Controls held (neg residual 0; pos residual == own).
    ================================================================
    window population (rows AFTER the anchor)
      peer content            #{pop[:peer_content]}
      peer presence (join)    #{pop[:peer_presence]}
      own content             #{pop[:own_content]}
      own presence (part)     #{pop[:own_presence]}
      peer topic              #{pop[:peer_topic]}
      TOTAL                   #{total_rows}
      suppressed-presence set #{suppressed_rows}   (join|part|quit|nick_change|mode)

    the three doors, SAME anchor (#{anchor}), SAME posture (presence shown)
      count_after/6        (bar)          #{pos_bar}
      count_after_split/6  (join badge)   #{pos_split.messages} + #{pos_split.events} = #{pos_split.total}
      bulk_unread_split/3  (/me seed)     #{pos_bulk.messages} + #{pos_bulk.events} = #{pos_bulk.total}

    TERMS
      T1 own-authored       #{t1}
         bar - split, same anchor, same posture. Bounded by what the
         OPERATOR typed/did. Seeded: #{own_rows}.
      T2 presence posture   #{t2}
         one resolver disagreement (bar SHOWS, seed HIDES), net of T1.
         Bounded by CHANNEL traffic. Seeded suppressed: #{suppressed_rows}.
      T3 anchor             #{t3}  (bar@#{anchor}=#{pos_bar} -> bar@#{later_anchor}=#{t3_bar_later})
         SIGN: a LATER anchor can only LOWER the bar. #{if t3 >= 0, do: "non-negative — confirmed", else: "NEGATIVE — monotonicity broken"}
      T4 bulk vs per-window #{t4}
         same anchor, same posture, channel window. Docstring claims 0.

    SCALING (same operator traffic, channel presence x10: 61 -> 610)
      T1  #{t1} -> #{scale_t1}   #{if scale_t1 == t1, do: "flat — cannot carry a channel-sized residual", else: "MOVED"}
      T2  #{t2} -> #{scale_t2}   #{if scale_t2 > t2, do: "grows with channel traffic — CAN carry 1404", else: "flat"}
    ================================================================
    """)

    # The report is the deliverable; these keep the file honest as a test.
    assert t1 == own_rows
    assert t3 >= 0
    assert Enum.all?(Message.suppressed_presence_kinds(), &(&1 not in Message.content_kinds()))
  end

  # ---------------------------------------------------------------------------
  # The ordered question: can the two presence paths RESPOND differently?
  #
  # The issue body says "Both paths DO share the presence-hidden filter, so
  # that is not a divergence source." They share the RULE
  # (`PresenceFilter.hidden?/2`) and nothing else: the bar resolves through
  # `Resolver.hidden?/4` -> `Session.list_members/3`, the seed through
  # `Resolver.hidden_channels/3` -> `Session.list_member_counts/2`. Two calls.
  #
  # Being written differently is not evidence. This measures whether they
  # ANSWER differently, and at what cost, by driving both through the real
  # `Grappa.Session` facade against a session whose two calls are answerable
  # independently.
  # ---------------------------------------------------------------------------
  describe "the two presence resolvers" do
    setup do
      user = user_fixture()
      net = network_fixture()
      subject = {:user, user.id}

      anchor =
        seed_window(%{user_id: user.id}, net.id,
          peer_content: 7,
          peer_presence: 61,
          own_content: 5,
          own_presence: 3,
          peer_topic: 2
        )

      {:ok, _} = ReadCursor.set(subject, net.id, @channel, anchor)

      %{subject: subject, net: net, anchor: anchor}
    end

    defp start_stub(subject, net, list_members, list_member_counts) do
      start_supervised!(
        {SessionStub, {subject, net.id, %{list_members: list_members, list_member_counts: list_member_counts}}}
      )
    end

    defp seed_hides?(subject, net) do
      subject
      |> Resolver.hidden_channels(%{net.slug => {net.id, @own_nick}}, %{
        net.slug => %{@channel => %{}}
      })
      |> Map.get(net.slug, MapSet.new())
      |> MapSet.member?(@channel)
    end

    defp bar_hides?(subject, net), do: Resolver.hidden?(subject, net.slug, net.id, @channel)

    # NEG CTRL, arm 1 — no session at all. Both lookups fail the SAME way and
    # decision D lands both on SHOW. Symmetric: no divergence to be had here,
    # which is exactly why "they share the filter" reads true from a distance.
    test "NEG CTRL — with no session, both resolvers SHOW", %{subject: subject, net: net} do
      refute bar_hides?(subject, net)
      refute seed_hides?(subject, net)
    end

    # NEG CTRL, arm 2 — one live session answering both calls CONSISTENTLY, at
    # a member count over the threshold. Both HIDE. Still symmetric.
    test "NEG CTRL — consistent answers over threshold: both HIDE", %{
      subject: subject,
      net: net
    } do
      big = Enum.map(1..250, &%{nick: "n#{&1}", modes: [], gender: nil})
      start_stub(subject, net, {:ok, big}, {:ok, %{@channel => 250}})

      assert bar_hides?(subject, net)
      assert seed_hides?(subject, net)
    end

    # POS CTRL + the measurement. The two calls answer INDEPENDENTLY: the
    # per-window one reports the channel unseeded (`:uninitialized`, which
    # `member_count_for_unset/4`'s catch-all maps to nil, IDENTICALLY to
    # `{:error, :timeout}` and `{:error, :no_session}`), while the bulk one
    # still carries the count.
    #
    # The resolvers then disagree WITH THE SIGN THE ISSUE NEEDS: the bar shows
    # presence, the seed hides it. The cost is measured, not assumed.
    test "POS CTRL — asymmetric answers diverge, bar SHOWS while seed HIDES", %{
      subject: subject,
      net: net,
      anchor: anchor
    } do
      start_stub(subject, net, {:ok, :uninitialized}, {:ok, %{@channel => 250}})

      refute bar_hides?(subject, net)
      assert seed_hides?(subject, net)

      # What that one disagreement costs, in rows, at the same anchor.
      bar_rows = bar(subject, net.id, anchor, bar_hides?(subject, net))
      seed = bulk(subject, net.id, net.slug, seed_hides?(subject, net))

      own_content = 5
      own_presence = 3
      peer_presence = 61
      own = own_content + own_presence
      suppressed = peer_presence + own_presence

      # The two excluded populations OVERLAP on the operator's own presence
      # rows, so the residual is their union, not their sum. Stated exactly —
      # a `> 0` assertion here would pass on any bug that merely moved rows.
      assert bar_rows - seed.total == own + suppressed - own_presence

      IO.puts("""

      ================================================================
      issue 2037 — the two presence resolvers, measured
      ================================================================
        no session                -> bar SHOW, seed SHOW   (symmetric)
        consistent, over-threshold-> bar HIDE, seed HIDE   (symmetric)
        asymmetric answers        -> bar SHOW, seed HIDE   (DIVERGENT)

        cost of that ONE disagreement, same anchor:
          bar  #{bar_rows}
          seed #{seed.messages} + #{seed.events} = #{seed.total}
          residual #{bar_rows - seed.total}
            = own-authored #{own} UNION suppressed-presence #{suppressed}
              (they overlap on the #{own_presence} own presence rows)

        The suppressed term is bounded by CHANNEL traffic, not by the
        operator's. It is the only term of the pair that can grow to 1404.
      ================================================================
      """)
    end
  end
end
