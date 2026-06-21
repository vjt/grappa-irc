defmodule Grappa.Push.ShouldNotifyParityTest do
  @moduledoc """
  Drift gate for the PWA badge predicate (2026-06-21).

  `Grappa.Push.Triggers.should_notify?/4` (server) and
  `cicchetto/src/lib/pushTriggers.ts`'s `shouldNotify` (foreground badge
  increment) MUST agree — the OS push, the icon badge, and the
  `document.title` all derive from the same notify decision, so a
  divergence would surface as "the title says you have a mention but no
  push fired" (or vice-versa).

  Both ports run against ONE shared fixture
  (`cicchetto/src/lib/shouldNotifyTruthTable.json`): this ExUnit suite and
  the vitest `pushTriggers.test.ts` consume the identical cases. Add a
  branch → add a row → both suites pick it up. Same discipline as the
  wireTypes parity gate; here ExUnit READS the cic-side artifact (the cic
  source tree is bind-mounted into the test container).
  """
  use ExUnit.Case, async: true

  alias Grappa.Push.Triggers
  alias Grappa.Scrollback.Message

  @fixture_path Path.expand(
                  "../../../cicchetto/src/lib/shouldNotifyTruthTable.json",
                  __DIR__
                )
  @external_resource @fixture_path
  @truth_table @fixture_path |> File.read!() |> Jason.decode!()

  # Explicit string→atom maps (literal atoms, created at this module's
  # compile time) instead of `String.to_existing_atom/1`, which races
  # module load order when the suite runs this file in isolation.
  @kinds %{
    "privmsg" => :privmsg,
    "notice" => :notice,
    "action" => :action,
    "join" => :join
  }
  @pref_keys %{
    "channel_messages_all" => :channel_messages_all,
    "channel_messages_only" => :channel_messages_only,
    "channel_mentions" => :channel_mentions,
    "private_messages_all" => :private_messages_all,
    "private_messages_only" => :private_messages_only
  }

  test "the shared fixture is non-empty (guards an accidental empty array)" do
    assert length(@truth_table) >= 10
  end

  for testcase <- @truth_table do
    test "should_notify?/4 — #{testcase["name"]}" do
      c = unquote(Macro.escape(testcase))

      message = %Message{
        kind: Map.fetch!(@kinds, c["message"]["kind"]),
        channel: c["message"]["channel"],
        sender: c["message"]["sender"],
        body: c["message"]["body"]
      }

      # JSON carries string-keyed prefs; should_notify?/4 reads atom keys.
      prefs = Map.new(c["prefs"], fn {k, v} -> {Map.fetch!(@pref_keys, k), v} end)

      assert Triggers.should_notify?(message, c["own_nick"], prefs, c["patterns"]) ==
               c["expected"],
             "truth-table case #{inspect(c["name"])} expected #{inspect(c["expected"])}"
    end
  end
end
