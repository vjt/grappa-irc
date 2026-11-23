defmodule Grappa.AdminOverviewTest do
  @moduledoc """
  Tests for `Grappa.AdminOverview` (#1075) — the scalar projection behind
  the admin top bar (#1073).

  ## Why a projection and not a count of the tab lists

  `LiveIntrospection.list_sessions/0` and `Visitors.list_all_with_live_state/0`
  each issue a `GenServer.call` PER live pid with a 250ms degradation
  budget. Counting their rows on a push cadence is `O(N × 250ms)` for two
  integers. This module counts via one `Registry.select/2` + one
  `Repo.aggregate/3` and never touches a session pid.

  ## Isolation

  `async: false` — reads the singleton `Grappa.SessionRegistry`
  (`max_cases: 1` keeps the suite serial). `AdmissionStateHelpers.reset_all/0`
  clears leftover `Session.Server`s so counts start from a known-empty
  registry, same shape as `Grappa.LiveIntrospectionTest`.
  """
  use Grappa.DataCase, async: false

  import Grappa.AuthFixtures

  alias Grappa.{AdminOverview, AdmissionStateHelpers, Session}

  setup do
    AdmissionStateHelpers.reset_all()
    :ok
  end

  # Register the calling process under `Session.registry_key/2`, the key a
  # real session registers under, so the count sees it exactly as it sees a
  # real session (issue 2696: a literal key here would keep matching a
  # literal reader after a key change). Mirror of the idiom in
  # `Grappa.LiveIntrospectionTest`.
  defp register_session(subject, network_id) do
    {:ok, _} =
      Registry.register(Grappa.SessionRegistry, Session.registry_key(subject, network_id), nil)

    :ok
  end

  describe "snapshot/0 — session count" do
    test "reports zero against an empty registry" do
      assert %{sessions: 0} = AdminOverview.snapshot()
    end

    test "counts one per registered pid, across subject kinds" do
      :ok = register_session({:user, Ecto.UUID.generate()}, 1)
      :ok = register_session({:visitor, Ecto.UUID.generate()}, 1)

      assert %{sessions: 2} = AdminOverview.snapshot()
    end
  end

  describe "snapshot/0 — visitor counts are a DB/live PAIR" do
    test "total counts DB rows the registry knows nothing about" do
      # The U-0 honesty signal in scalar form: DB intent exists, BEAM
      # does not. `total` must NOT be derived from `live`, nor the
      # reverse — they are two sources of truth and are allowed to
      # disagree (CLAUDE.md "DB state and live state are separate").
      _ = visitor_fixture()
      _ = visitor_fixture()

      assert %{visitors: %{total: 2, live: 0}} = AdminOverview.snapshot()
    end

    test "live counts DISTINCT visitors, not visitor sessions" do
      visitor = visitor_fixture()
      # One visitor, two networks — two pids, ONE visitor. Mirrors the
      # Visitors tab, which renders one row per visitor carrying a
      # per-network live list.
      :ok = register_session({:visitor, visitor.id}, 1)
      :ok = register_session({:visitor, visitor.id}, 2)

      assert %{sessions: 2, visitors: %{total: 1, live: 1}} = AdminOverview.snapshot()
    end

    test "a user session never counts as a live visitor" do
      _ = visitor_fixture()
      :ok = register_session({:user, Ecto.UUID.generate()}, 1)

      assert %{sessions: 1, visitors: %{total: 1, live: 0}} = AdminOverview.snapshot()
    end
  end

  describe "snapshot/0 — machine facts" do
    test "version is the same string CTCP VERSION answers with" do
      assert %{version: version} = AdminOverview.snapshot()
      assert version == Grappa.Version.current()
    end

    test "hostname is the node's own hostname, non-empty" do
      {:ok, expected} = :inet.gethostname()

      assert %{hostname: hostname} = AdminOverview.snapshot()
      assert hostname == to_string(expected)
      assert hostname != ""
    end

    test "loadavg is a non-negative float (os_mon's cpu_sup is loaded)" do
      # Guards the `:os_mon` extra_application: without it `:cpu_sup.avg1/0`
      # is undefined and this collapses to the nil branch.
      assert %{loadavg: loadavg} = AdminOverview.snapshot()
      assert is_float(loadavg), "expected a float loadavg, got: #{inspect(loadavg)}"
      assert loadavg >= 0.0
    end
  end

  describe "derive_loadavg/1 — the pure fold" do
    test "scales cpu_sup's fixed-point integer by 256" do
      assert AdminOverview.derive_loadavg(256) == 1.0
      assert AdminOverview.derive_loadavg(0) == 0.0
      assert AdminOverview.derive_loadavg(128) == 0.5
    end

    test "rounds to two decimals — the bar has no room for more" do
      assert AdminOverview.derive_loadavg(100) == 0.39
    end

    test "an unavailable sampler is nil, never a fabricated zero" do
      # A zero loadavg and an absent sampler are DIFFERENT facts. Coercing
      # the error to 0.0 would render an idle box on a machine we cannot
      # measure — the bar must show "unknown", not "calm".
      assert AdminOverview.derive_loadavg({:error, :disabled}) == nil
      assert AdminOverview.derive_loadavg(:undefined) == nil
    end
  end

  describe "push_interval_ms/0" do
    test "is a positive integer so the channel tick can never busy-loop" do
      interval = AdminOverview.push_interval_ms()
      assert is_integer(interval) and interval > 0
    end
  end
end
