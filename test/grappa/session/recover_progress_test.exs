defmodule Grappa.Session.RecoverProgressTest do
  @moduledoc """
  #1390 slice 4 — the FSM-transition → modal-step projection, driven without
  a session.

  Every case here walks the REAL `RecoverIdentity` FSM from `:idle` with
  `step/2` and asks the projection what the modal should be told. Nothing is
  hand-built: a state the FSM cannot produce is not a state worth asserting,
  and driving it this way makes each assertion also a proof that the
  transition is reachable.

  Before this slice the projection was two `defp` clauses inside
  `Session.Server`, so the only way to exercise it was to boot a
  `Session.Server`, a fake ircd and the Repo and read the broadcasts back —
  which is what the 15 tests of `server_test.exs`'s
  `recover_identity (#581) — server integration` describe do, `async: false`,
  for a handful of paths. These run on plain `ExUnit.Case`, `async: true`,
  with no process, no socket and no database.

  **#1468 cured here.** Two terminals used to leave a step the modal already
  showed as `:running` without a terminal status, so cic rendered it spinning
  forever beside a failed outcome. The examples below pin each cured terminal,
  but the assertion that actually holds the rule is the exhaustive walk at the
  bottom: one example per leg is how the gap survived a rule, a test for the
  rule, and a review.
  """
  use ExUnit.Case, async: true

  alias Grappa.Session.{RecoverIdentity, RecoverProgress}

  defp start_fsm, do: RecoverIdentity.init("vjt", "s3cret")

  # One FSM hop: returns the state reached and what the modal is told about
  # the transition into it.
  # The verdict and the outbound lines are the host's business, not this
  # projection's — hence the bare `_`, the naming strategy Credo infers here.
  defp hop(fsm, input) do
    {_, next, _} = RecoverIdentity.step(fsm, input)
    {next, RecoverProgress.steps(fsm.phase, next)}
  end

  defp advance(fsm, inputs), do: Enum.reduce(inputs, fsm, fn i, acc -> elem(hop(acc, i), 0) end)

  @inputs [
    :start,
    :r_observed,
    {:nick_error, 433},
    {:nick_error, 437},
    :settle,
    :nick_observed,
    :timeout
  ]

  # Breadth-first to fixpoint over {phase, verb, rows}. Terminals are
  # recorded and NOT expanded: what happens after the FSM stops is the
  # host's business, and a self-loop there would only re-emit the same
  # terminal projection forever.
  defp walk do
    explore([{start_fsm(), %{}, []}], %{}, [])
  end

  defp explore([], seen, terminals), do: %{states: seen, terminals: terminals}

  defp explore([{fsm, rows, path} | queue], seen, terminals) do
    {next_queue, next_seen, next_terminals} =
      Enum.reduce(@inputs, {queue, seen, terminals}, fn input, {q, s, t} ->
        {next_fsm, steps} = hop(fsm, input)
        next_rows = upsert(rows, steps)
        next_path = [input | path]
        key = {next_fsm.phase, next_fsm.verb, next_rows}

        cond do
          Map.has_key?(s, key) ->
            {q, s, t}

          next_fsm.phase in [:succeeded, :failed] ->
            terminal = %{phase: next_fsm.phase, from: fsm.phase, rows: next_rows, path: next_path}
            {q, Map.put(s, key, true), [terminal | t]}

          true ->
            {q ++ [{next_fsm, next_rows, next_path}], Map.put(s, key, true), t}
        end
      end)

    explore(next_queue, next_seen, next_terminals)
  end

  # The client's rule: one row per step name, last write wins, rows nobody
  # updates are left exactly as they were.
  defp upsert(rows, steps) do
    Enum.reduce(steps, rows, fn {step, status, _reason}, acc -> Map.put(acc, step, status) end)
  end

  describe "the happy path" do
    test "the start transition sets BOTH the nick and the identify step running" do
      # NICK and IDENTIFY go out together, so both steps start together.
      assert {_, [{:nick, :running, nil}, {:identify, :running, nil}]} =
               hop(start_fsm(), :start)
    end

    test "+r observed on the first attempt reports the whole sequence ok" do
      fsm = advance(start_fsm(), [:start])

      assert {_, [{:nick, :ok, nil}, {:identify, :ok, nil}, {:register, :ok, nil}]} =
               hop(fsm, :r_observed)
    end
  end

  describe "the reclaim detour" do
    test "a 433 fails the nick step and starts the RECOVER verb" do
      fsm = advance(start_fsm(), [:start])

      assert {_, [{:nick, :failed, nil}, {:recover, :running, nil}]} =
               hop(fsm, {:nick_error, 433})
    end

    test "a 437 starts the RELEASE verb instead — the verb doubles as its step" do
      fsm = advance(start_fsm(), [:start])

      assert {_, [{:nick, :failed, nil}, {:release, :running, nil}]} =
               hop(fsm, {:nick_error, 437})
    end

    test "the settle tick completes the verb and re-runs the nick step ALONE" do
      # #623 — the identify step deliberately does NOT restart here: it waits
      # for the nick to be observed, so the modal never shows identify running
      # before the nick has landed.
      fsm = advance(start_fsm(), [:start, {:nick_error, 433}])

      assert {_, [{:recover, :ok, nil}, {:nick, :running, nil}]} = hop(fsm, :settle)
    end

    test "the observed re-NICK completes the nick step and starts identify" do
      fsm = advance(start_fsm(), [:start, {:nick_error, 433}, :settle])

      assert {_, [{:nick, :ok, nil}, {:identify, :running, nil}]} = hop(fsm, :nick_observed)
    end

    test "the bounded RETRY is silent — no visible churn in the modal" do
      # #623 — a 433/437 on the re-NICK sends the FSM back to await the verb.
      # The modal is told nothing, which is the point: a retry must not flicker.
      fsm = advance(start_fsm(), [:start, {:nick_error, 433}, :settle])

      assert {_, []} = hop(fsm, {:nick_error, 433})
    end
  end

  describe "terminals that reconcile every started step" do
    test "a deadline in :awaiting_r blames the identify step, not the nick" do
      # The NICK landed clean (no 433/437 ever came), so `+r` missing means the
      # IDENTIFY was refused.
      fsm = advance(start_fsm(), [:start])

      assert {_, [{:nick, :ok, nil}, {:identify, :failed, :wrong_password}]} =
               hop(fsm, :timeout)
    end

    test "a deadline in :awaiting_final_r blames identify with the reclaim reason" do
      # The nick WAS reclaimed, so this is not a wrong password: the sameNick
      # IDENTIFY simply went unconfirmed.
      fsm = advance(start_fsm(), [:start, {:nick_error, 433}, :settle, :nick_observed])

      assert {_, [{:nick, :ok, nil}, {:identify, :failed, :identify_unconfirmed}]} =
               hop(fsm, :timeout)
    end
  end

  # #1468 — the two terminals that used to strand a step. Both paths ran
  # through `:idle -> :awaiting_r`, which sets `identify: :running`, and
  # neither terminal gave that step a final status. cic upserts step rows by
  # name (`recoverProgress.ts`) and `RecoverModal` keeps rendering `is-running`
  # regardless of the outcome, so the modal ended with identify spinning beside
  # a failed result.
  describe "terminals that used to strand a step (#1468)" do
    test "#1468 — a deadline in :awaiting_verb_settle reconciles identify and nick too" do
      fsm = advance(start_fsm(), [:start, {:nick_error, 433}])

      # `identify` has been running since the start transition; `nick` is
      # either already :failed (first pass) or :running again (after a retry),
      # and this projection cannot tell those apart — so it reconciles both.
      assert {_, steps} = hop(fsm, :timeout)
      assert {:identify, :failed, :services_declined} in steps
      assert {:nick, :failed, :services_declined} in steps
      assert {:recover, :failed, :services_declined} in steps
    end

    test "#1468 — a deadline in :awaiting_nick reconciles the identify step too" do
      fsm = advance(start_fsm(), [:start, {:nick_error, 433}, :settle])

      assert {_, steps} = hop(fsm, :timeout)
      assert {:nick, :failed, :nick_unavailable} in steps
      assert {:identify, :failed, :nick_unavailable} in steps
    end
  end

  # ── The rule itself, over the whole reachable graph ────────────────────────
  #
  # #623 pt3's rule is "no step may be left :running when the recovery reaches
  # a terminal state". One example per leg is exactly how #1468 survived: the
  # rule existed, a test for the rule existed on the sibling leg, and the
  # clause next door did not honour it.
  #
  # This is an EXHAUSTIVE WALK rather than a StreamData property, and the
  # difference matters. The reachable space is finite and small — a phase, a
  # verb, and one status per step name — so a breadth-first search to fixpoint
  # is a PROOF over every reachable path, retry loops included, instead of a
  # sample of them. A generator would rediscover the same handful of states
  # with a seed that can be lucky; this cannot be lucky, and cannot flake.
  #
  # The accumulated rows mirror the CLIENT's rule, not a convenient one:
  # `recoverProgress.ts` upserts by step name, last write wins, and never
  # touches a row nobody updated. That is why a Map keyed by step name is the
  # faithful model of "what the modal is showing when the modal closes".
  describe "#623 pt3, proven over every reachable transition (#1468)" do
    test "no reachable terminal leaves a step :running" do
      %{terminals: terminals, states: states} = walk()

      # Vacuity floors. A walk that explored nothing, or never reached a
      # terminal, would satisfy the assertion below by having nothing to check.
      assert map_size(states) > 10,
             "the walk explored only #{map_size(states)} states — the search is broken"

      assert length(terminals) >= 4,
             "the walk reached only #{length(terminals)} terminals"

      # ...and it must reach a terminal out of EVERY phase that can fail, or a
      # future clause could strand rows on a leg this never visits.
      failed_from =
        terminals
        |> Enum.filter(fn %{phase: phase} -> phase == :failed end)
        |> Enum.map(& &1.from)
        |> Enum.uniq()
        |> Enum.sort()

      assert failed_from == [:awaiting_final_r, :awaiting_nick, :awaiting_r, :awaiting_verb_settle]

      for %{rows: rows, path: path, phase: phase, from: from} <- terminals do
        running = for {step, status} <- rows, status == :running, do: step

        assert running == [],
               """
               terminal #{inspect(phase)} out of #{inspect(from)} left #{inspect(running)} at :running.
               path:  #{inspect(Enum.reverse(path))}
               rows:  #{inspect(rows)}
               """
      end
    end
  end
end
