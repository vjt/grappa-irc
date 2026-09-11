defmodule Grappa.Presence2043ProbeTest do
  @moduledoc """
  issue 2043 — MEASUREMENT INSTRUMENT, not a regression test.

  The issue establishes that `Grappa.PresenceFilter.Resolver`'s two doors
  CAN disagree and what the disagreement costs, and then says in as many
  words what it did NOT establish:

  > A real `Session.Server` cannot answer the two calls asymmetrically
  > within one instant, and that is a READING, not a measurement.

  This file is that measurement. Every arm below reads the SAME pair —
  `Resolver.hidden?/4` (the per-window bar) and `Resolver.hidden_channels/3`
  (the bulk `/me` seed) — through the production `Grappa.Session` facade,
  against a REAL `Grappa.Session.Server` driven by the in-process fake ircd.
  The only exception is the pair of controls, which use a stand-in
  precisely because a stand-in can do what the question is about.

  ## The controls gate the reading, and one of them must DIVERGE

  A run in which every real arm comes back symmetric proves nothing on its
  own: an instrument that cannot see divergence reports "symmetric" for a
  divergent system just as cheerfully. So two controls run first:

    * `CTRL SYM` — a stand-in answering both doors consistently over the
      threshold. The pair must be (HIDE, HIDE).
    * `CTRL DIVERGE` — a stand-in answering the two doors independently.
      The pair MUST be (SHOW, HIDE). This is the known-answer control: if
      this arm ever reports symmetric, the instrument is blind and every
      other arm in this file is void.

  ## What each real arm asks

    * `R1`/`R2` — a healthy seeded channel, over and under the threshold.
      Establishes that the instrument reaches a real session at all.
    * `R3` — joined, NAMES not yet landed (`:uninitialized` at the
      per-window door, omitted at the bulk door). Mechanism (2) of the
      issue, at the door where it is cheapest to reach.
    * `R4` — a channel the session never joined.
    * `R5` — the network folds `[ ] \\ ~` (`CASEMAPPING=rfc1459`) while the
      read-cursor key that drives the bulk door is folded ASCII-only. This
      mechanism is NOT in the issue's list of two. `R5b` and `R5c` are its
      discriminating controls: the same network without the national char,
      and the same channel on an `:ascii` network. Both must be symmetric,
      or `R5` is not attributable to the key mismatch.
    * `R6` — two instants with the session dying in between: the issue's
      mechanism (1), stated as a lower bound on what a pair of instants can
      do.
  """
  use Grappa.DataCase, async: false

  import Grappa.AuthFixtures,
    only: [
      user_fixture: 1,
      network_fixture: 1,
      network_with_server: 1,
      credential_fixture: 3,
      start_session_for: 2
    ]

  alias Grappa.IRC.Identifier
  alias Grappa.{IRCServer, PresenceFilter, Session}
  alias Grappa.PresenceFilter.Resolver

  @nick "grappa-test"

  # A `Session.Server` stand-in registered under the real registry key, so the
  # resolvers reach it through the production facade. Its only special power
  # is answering the two calls independently — which is what the controls are
  # for, and what the real arms are testing the absence of.
  defmodule SessionStub do
    @moduledoc false
    use GenServer

    @spec start_link({Grappa.Subject.t(), integer(), map()}) :: GenServer.on_start()
    def start_link({subject, network_id, replies}) do
      name =
        {:via, Registry, {Grappa.SessionRegistry, Grappa.Session.Server.registry_key(subject, network_id)}}

      GenServer.start_link(__MODULE__, replies, name: name)
    end

    @impl GenServer
    def init(replies), do: {:ok, replies}

    @impl GenServer
    def handle_call({:list_members, _}, _, replies),
      do: {:reply, Map.fetch!(replies, :list_members), replies}

    def handle_call(:list_member_counts, _, replies),
      do: {:reply, Map.fetch!(replies, :list_member_counts), replies}
  end

  # ---------------------------------------------------------------------------
  # The pair under measurement — both halves through production code
  # ---------------------------------------------------------------------------

  defp bar_hides?(subject, net, channel),
    do: Resolver.hidden?(subject, net.slug, net.id, channel)

  # `windows` is the `/me` cursor envelope; only its KEYS are read. The key
  # passed here is the one a read cursor would carry, which is the whole point
  # of arm R5.
  defp seed_hides?(subject, net, window_key) do
    subject
    |> Resolver.hidden_channels(%{net.slug => {net.id, @nick}}, %{
      net.slug => %{window_key => %{}}
    })
    |> Map.get(net.slug, MapSet.new())
    |> MapSet.member?(window_key)
  end

  defp pair(subject, net, channel), do: pair(subject, net, channel, channel)

  defp pair(subject, net, channel, window_key),
    do: {bar_hides?(subject, net, channel), seed_hides?(subject, net, window_key)}

  # ---------------------------------------------------------------------------
  # Fixture
  # ---------------------------------------------------------------------------

  defp setup_user_and_network(port, cred_attrs) do
    user = user_fixture(name: "vjt-#{System.unique_integer([:positive])}")

    {network, _} =
      network_with_server(port: port, slug: "test-#{System.unique_integer([:positive])}")

    credential_fixture(user, network, cred_attrs)
    {user, network}
  end

  # Bring a real session up to the point where it has registered and sent its
  # JOINs. Returns everything the arms need to keep driving the fake ircd.
  defp live_session(autojoin) do
    {server, port} = IRCServer.start_server(IRCServer.welcome_handler(":irc", @nick))
    {user, net} = setup_user_and_network(port, %{autojoin_channels: autojoin})
    pid = start_session_for(user, net)

    :ok = IRCServer.await_handshake(server, 2_000)

    if autojoin != [] do
      {:ok, _} = IRCServer.wait_for_line(server, &String.starts_with?(&1, "JOIN"), 2_000)
    end

    %{server: server, net: net, pid: pid, subject: {:user, user.id}}
  end

  # A barrier, not a sleep: the session has processed everything fed before
  # this PING once it has answered the PONG.
  defp flush(server) do
    token = "f#{System.unique_integer([:positive])}"
    IRCServer.feed(server, "PING :#{token}\r\n")
    {:ok, _} = IRCServer.wait_for_line(server, &(&1 == "PONG :#{token}\r\n"), 2_000)
    :ok
  end

  # `n` members in the channel, own nick included, in 353 chunks so no single
  # line has to carry 250 nicks.
  defp seed_members(server, channel, n) do
    IRCServer.feed(server, ":#{@nick}!u@h JOIN :#{channel}\r\n")

    [@nick | Enum.map(2..n//1, &"n#{&1}")]
    |> Enum.chunk_every(20)
    |> Enum.each(fn chunk ->
      IRCServer.feed(server, ":irc 353 #{@nick} = #{channel} :#{Enum.join(chunk, " ")}\r\n")
    end)

    IRCServer.feed(server, ":irc 366 #{@nick} #{channel} :End\r\n")
    flush(server)
  end

  defp advertise_rfc1459(server) do
    IRCServer.feed(server, ":irc 005 #{@nick} CASEMAPPING=rfc1459 :are supported\r\n")
    flush(server)
  end

  defp stop(%{pid: pid}), do: :ok = GenServer.stop(pid, :normal, 2_000)

  # ---------------------------------------------------------------------------
  # The arms — one function each, so no reading is taken in the shadow of the
  # previous arm's session
  # ---------------------------------------------------------------------------

  defp arm_seeded(channel, members) do
    s = live_session([channel])
    seed_members(s.server, channel, members)
    reading = pair(s.subject, s.net, channel)
    stop(s)
    reading
  end

  # Joined, 353 delivered, NO 366 — the per-window door answers
  # `:uninitialized` and the bulk door omits the key.
  defp arm_pre_names do
    s = live_session(["#pending"])
    IRCServer.feed(s.server, ":#{@nick}!u@h JOIN :#pending\r\n")
    IRCServer.feed(s.server, ":irc 353 #{@nick} = #pending :#{@nick} alice bob\r\n")
    flush(s.server)

    assert {:ok, :uninitialized} = Session.list_members(s.subject, s.net.id, "#pending"),
           "R3 precondition: the per-window door must really be answering :uninitialized"

    reading = pair(s.subject, s.net, "#pending")
    stop(s)
    reading
  end

  defp arm_never_joined do
    s = live_session([])
    reading = pair(s.subject, s.net, "#nowhere")
    stop(s)
    reading
  end

  # `ReadCursor.set/4` folds the cursor key with the arity-1
  # `canonical_target/1` — plain ASCII, brackets untouched. The members map is
  # keyed by the session's own network-aware fold, which on rfc1459 maps `[`
  # to `{` first. Returns the two keys alongside the pair so the label states
  # the mismatch instead of asserting it in prose.
  defp arm_rfc1459_bracket(members) do
    s = live_session([])
    advertise_rfc1459(s.server)
    seed_members(s.server, "#foo[1]", members)

    {:ok, counts} = Session.list_member_counts(s.subject, s.net.id)
    members_key = counts |> Map.keys() |> Enum.find(&String.starts_with?(&1, "#foo"))
    cursor_key = Identifier.canonical_target("#foo[1]")

    reading = pair(s.subject, s.net, "#foo[1]", cursor_key)
    stop(s)
    {members_key, cursor_key, reading}
  end

  defp arm_rfc1459_plain(members) do
    s = live_session([])
    advertise_rfc1459(s.server)
    seed_members(s.server, "#plain", members)
    reading = pair(s.subject, s.net, "#plain")
    stop(s)
    reading
  end

  # Two instants with the session dying in between. Both pairs are read whole,
  # so the CROSS pair the caller builds from them is data and not a claim.
  defp arm_two_instants(members) do
    s = live_session(["#big2"])
    seed_members(s.server, "#big2", members)
    before_death = pair(s.subject, s.net, "#big2")
    stop(s)
    after_death = pair(s.subject, s.net, "#big2")
    {before_death, after_death}
  end

  # ---------------------------------------------------------------------------
  # The measurement
  # ---------------------------------------------------------------------------

  test "issue 2043 — can the two resolver doors diverge on a REAL Session.Server?" do
    over = PresenceFilter.large_channel_threshold() + 50
    under = 3

    # The controls use the stand-in on purpose, and CTRL DIVERGE is the
    # known-answer one: it must come back DIVERGENT or nothing below counts.
    ctrl_sym =
      with_stub({:ok, big_members(over)}, {:ok, %{"#ctrl" => over}}, fn subject, net ->
        pair(subject, net, "#ctrl")
      end)

    assert ctrl_sym == {true, true},
           "CTRL SYM: a stand-in answering both doors consistently over the threshold " <>
             "must HIDE at both; got #{inspect(ctrl_sym)}"

    ctrl_div =
      with_stub({:ok, :uninitialized}, {:ok, %{"#ctrl" => over}}, fn subject, net ->
        pair(subject, net, "#ctrl")
      end)

    assert ctrl_div == {false, true},
           "CTRL DIVERGE is the known-answer control. It must report (SHOW, HIDE); got " <>
             "#{inspect(ctrl_div)}. If this arm is symmetric the instrument is blind and " <>
             "every real arm in this file is void."

    r1 = arm_seeded("#big", over)
    assert r1 == {true, true}, "R1: a real seeded over-threshold channel must HIDE at both"

    r2 = arm_seeded("#small", under)
    assert r2 == {false, false}, "R2: a real seeded under-threshold channel must SHOW at both"

    r3 = arm_pre_names()
    r4 = arm_never_joined()

    {members_key, cursor_key, r5} = arm_rfc1459_bracket(over)

    r5b = arm_rfc1459_plain(over)

    assert r5b == {true, true},
           "R5b: on the same rfc1459 network a channel whose two keys COINCIDE must be " <>
             "symmetric, else R5 is not attributable to the key mismatch; got #{inspect(r5b)}"

    r5c = arm_seeded("#foo[1]", over)

    assert r5c == {true, true},
           "R5c: the same bracket channel on an :ascii network must be symmetric; " <>
             "got #{inspect(r5c)}"

    {t1, t2} = arm_two_instants(over)
    {_, seed_t1} = t1
    {bar_t2, _} = t2

    rows = [
      {"CTRL SYM   stand-in, consistent over threshold", ctrl_sym},
      {"CTRL DIVERGE  stand-in, independent answers", ctrl_div},
      {"R1  real, seeded, #{over} members", r1},
      {"R2  real, seeded, #{under} members", r2},
      {"R3  real, joined, pre-NAMES (:uninitialized)", r3},
      {"R4  real, channel never joined", r4},
      {"R5  rfc1459 + bracket: members #{inspect(members_key)} vs cursor #{inspect(cursor_key)}", r5},
      {"R5b CTRL rfc1459 + no bracket (keys coincide)", r5b},
      {"R5c CTRL same bracket channel, :ascii network", r5c},
      {"R6  two instants: both doors read BEFORE the session died", t1},
      {"R6  two instants: both doors read AFTER  the session died", t2},
      {"R6  the CROSS pair: seed@t1 vs bar@t2", {bar_t2, seed_t1}}
    ]

    IO.puts("""

    ================================================================
    issue 2043 — the two resolver doors against a REAL Session.Server
    ================================================================
    #{Enum.map_join(rows, "\n", &render_row/1)}

      threshold = #{PresenceFilter.large_channel_threshold()}
      Every row but the last three is ONE pair read with no state change
      between the two calls. R6's rows are two instants by construction, and
      the CROSS row is the pair a production /me-then-probe actually makes.
    ================================================================
    """)
  end

  defp render_row({label, {bar, seed} = reading}),
    do: "  #{String.pad_trailing(label, 62)} bar #{hs(bar)}  seed #{hs(seed)}  #{verdict(reading)}"

  defp verdict({a, b}) when a == b, do: "symmetric"
  defp verdict(_), do: "DIVERGENT"

  defp hs(true), do: "HIDE"
  defp hs(false), do: "SHOW"

  defp big_members(n), do: Enum.map(1..n, &%{nick: "n#{&1}", modes: [], gender: nil})

  # A stand-in for the length of one reading, torn down before the next arm so
  # the registry key is free.
  defp with_stub(list_members, list_member_counts, fun) do
    user = user_fixture(name: "vjt-#{System.unique_integer([:positive])}")
    net = network_fixture(slug: "test-#{System.unique_integer([:positive])}")
    subject = {:user, user.id}

    {:ok, pid} =
      SessionStub.start_link({subject, net.id, %{list_members: list_members, list_member_counts: list_member_counts}})

    try do
      fun.(subject, net)
    after
      GenServer.stop(pid, :normal, 1_000)
    end
  end
end
