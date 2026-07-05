defmodule Grappa.Session.AwayStateTest do
  @moduledoc """
  Tests for `Grappa.Session.AwayState` — the away-state quartet
  extracted from `Grappa.Session.Server` (cluster #7, Theme 3 /
  resp-A1 / ext-A9 god-module decomposition, 2/3).

  CRITICAL invariants asserted here (per CLAUDE.md "state lives on
  the server" and S3.2 precedence rules):

    * `set_explicit_away/2` always wins — no precedence guard inside
      the data module. Server.ex enforces precedence at handle_call
      level (auto is no-op when explicit is set; explicit overwrites
      auto). The data module is mechanical: whatever you set, sticks.
    * `set_auto_away/1` records the fixed `@auto_away_reason` constant
      AND the auto state — Server.ex guards against calling this from
      `:away_explicit` (the precedence rule), but the data module
      itself does not — it's pure mutation.
    * `unset_away/1` clears all three away fields (state /
      started_at / reason) back to idle defaults. Used by both
      explicit and auto unset paths on Server.
    * `started_at/1` returns the DateTime that the away period began,
      or `nil` if `:present`. Mentions aggregation (S3.5) reads this
      to fix the lower window boundary.
    * NO debounce timer reference inside this struct (Option A from
      cluster #7 design judgment): the timer is a process-relative
      `Process.send_after` reference and lives on Session.Server,
      symmetric with `in_flight_joins` from cluster #6.
  """
  use ExUnit.Case, async: true
  import Grappa.TypeLaundry

  alias Grappa.Session.AwayState

  describe "new/0" do
    test "returns an empty struct (state :present, all metadata nil)" do
      as = AwayState.new()

      assert AwayState.state_of(as) == :present
      assert AwayState.started_at(as) == nil
      assert AwayState.reason(as) == nil
    end
  end

  describe "set_explicit_away/2" do
    test "transitions to :away_explicit, records reason and started_at" do
      before = DateTime.utc_now()
      as = AwayState.set_explicit_away(AwayState.new(), "lunch")
      after_ = DateTime.utc_now()

      assert AwayState.state_of(as) == :away_explicit
      assert AwayState.reason(as) == "lunch"

      started = AwayState.started_at(as)
      assert %DateTime{} = started
      assert DateTime.compare(started, before) in [:eq, :gt]
      assert DateTime.compare(started, after_) in [:eq, :lt]
    end

    test "overwrites a prior :away_auto (data module is mechanical, no precedence)" do
      as =
        AwayState.new()
        |> AwayState.set_auto_away()
        |> AwayState.set_explicit_away("manual")

      assert AwayState.state_of(as) == :away_explicit
      assert AwayState.reason(as) == "manual"
    end

    test "calling twice updates reason + started_at to the latest values" do
      first = AwayState.set_explicit_away(AwayState.new(), "first")
      first_started = AwayState.started_at(first)

      # Sleep 1ms so the second timestamp is strictly later.
      Process.sleep(1)

      second = AwayState.set_explicit_away(first, "second")

      assert AwayState.reason(second) == "second"
      assert DateTime.compare(AwayState.started_at(second), first_started) == :gt
    end
  end

  describe "set_auto_away/1" do
    test "transitions to :away_auto, records the fixed auto-away reason" do
      before = DateTime.utc_now()
      as = AwayState.set_auto_away(AwayState.new())
      after_ = DateTime.utc_now()

      assert AwayState.state_of(as) == :away_auto
      assert AwayState.reason(as) == AwayState.auto_away_reason()

      started = AwayState.started_at(as)
      assert %DateTime{} = started
      assert DateTime.compare(started, before) in [:eq, :gt]
      assert DateTime.compare(started, after_) in [:eq, :lt]
    end

    test "overwrites a prior :away_explicit (data module is mechanical, no precedence)" do
      as =
        AwayState.new()
        |> AwayState.set_explicit_away("manual")
        |> AwayState.set_auto_away()

      assert AwayState.state_of(as) == :away_auto
      assert AwayState.reason(as) == AwayState.auto_away_reason()
    end
  end

  describe "unset_away/1" do
    test "from :away_explicit returns to :present and clears reason + started_at" do
      as =
        AwayState.new()
        |> AwayState.set_explicit_away("lunch")
        |> AwayState.unset_away()

      assert AwayState.state_of(as) == :present
      assert AwayState.started_at(as) == nil
      assert AwayState.reason(as) == nil
    end

    test "from :away_auto returns to :present and clears reason + started_at" do
      as =
        AwayState.new()
        |> AwayState.set_auto_away()
        |> AwayState.unset_away()

      assert AwayState.state_of(as) == :present
      assert AwayState.started_at(as) == nil
      assert AwayState.reason(as) == nil
    end

    test "from :present is idempotent (no-op, stays :present)" do
      as = AwayState.unset_away(AwayState.new())

      assert AwayState.state_of(as) == :present
      assert AwayState.started_at(as) == nil
      assert AwayState.reason(as) == nil
    end
  end

  describe "auto_away_reason/0" do
    test "returns the fixed auto-away protocol constant" do
      assert AwayState.auto_away_reason() == "auto-away (web client disconnected)"
    end
  end

  describe "readers" do
    test "state_of/1 returns the current state atom" do
      assert AwayState.state_of(AwayState.new()) == :present

      assert AwayState.state_of(AwayState.set_explicit_away(AwayState.new(), "x")) ==
               :away_explicit

      assert AwayState.state_of(AwayState.set_auto_away(AwayState.new())) == :away_auto
    end

    test "reason/1 returns the recorded reason string or nil" do
      assert AwayState.reason(AwayState.new()) == nil
      assert AwayState.reason(AwayState.set_explicit_away(AwayState.new(), "brb")) == "brb"

      assert AwayState.reason(AwayState.set_auto_away(AwayState.new())) ==
               AwayState.auto_away_reason()
    end

    test "started_at/1 returns the DateTime when away started, or nil" do
      assert AwayState.started_at(AwayState.new()) == nil

      explicit_at = AwayState.started_at(AwayState.set_explicit_away(AwayState.new(), "x"))
      assert %DateTime{} = explicit_at

      auto_at = AwayState.started_at(AwayState.set_auto_away(AwayState.new()))
      assert %DateTime{} = auto_at
    end
  end

  describe "type guards" do
    test "set_explicit_away/2 requires a binary reason" do
      assert_raise FunctionClauseError, fn ->
        AwayState.set_explicit_away(AwayState.new(), opaque(:not_a_string))
      end
    end
  end
end
