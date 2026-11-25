defmodule Grappa.Net.SourceAliasManagerTest do
  @moduledoc """
  #543 INC-5 — ref-count lifecycle + boot reconcile + arm gate. A Mox adapter
  (`Grappa.Net.SourceAliasMock`) stands in for the platform, so no real
  `ifconfig` runs. The manager is a GenServer that calls the adapter during
  `init` (arm_check) + `handle_continue` (reconcile) — before any `allow/3`
  could land — so the mock runs in GLOBAL mode (safe: the suite is fully
  serial via `max_cases: 1`).
  """
  use ExUnit.Case, async: false

  import Mox

  alias Grappa.Net.SourceAlias.FreeBSD
  alias Grappa.Net.SourceAliasManager, as: Manager

  @prefix "2a03:4000:20:2d3:cb::/80"
  @addr "2a03:4000:20:2d3:cb::1"
  @addr2 "2a03:4000:20:2d3:cb::2"

  setup :set_mox_global
  setup :verify_on_exit!

  # Start a manager wired to the Mox adapter + a fixed prefix. The boot-path
  # calls (arm_check, then reconcile's list_aliases) are stubbed so a clean
  # boot is a no-op; individual tests layer `expect/3` on top.
  defp start_manager do
    stub(Grappa.Net.SourceAliasMock, :arm_check, fn @prefix -> :ok end)
    stub(Grappa.Net.SourceAliasMock, :list_aliases, fn @prefix -> {:ok, []} end)

    pid = start_supervised!({Manager, adapter: Grappa.Net.SourceAliasMock, prefix: @prefix})
    drain_boot_reconcile(pid)
    pid
  end

  # Barrier between "manager started" and "expectations declared". `init/1`
  # returns `{:continue, :reconcile}`, so `handle_continue(:reconcile, …)` — and
  # its `adapter.list_aliases/1` boot call — runs ASYNC after `start_supervised!`
  # returns. A synchronous `:sys.get_state/1` is answered only from the receive
  # loop, which the gen_server reaches strictly AFTER `handle_continue` finishes,
  # so returning here proves the boot reconcile is done. Without it the boot
  # `list_aliases` can land after a test's `expect/3` and consume it, making the
  # explicit `Manager.reconcile()` a second (unexpected) call (#585).
  defp drain_boot_reconcile(pid), do: :sys.get_state(pid)

  describe "acquire/release ref-counting" do
    test "binds once on 0→1, stays bound across a second acquire, unbinds on last release" do
      start_manager()

      # ensure_source ONCE (0→1); no ensure on the second acquire.
      expect(Grappa.Net.SourceAliasMock, :ensure_source, fn @addr, @prefix -> :ok end)
      assert :ok = Manager.acquire(@addr)
      assert :ok = Manager.acquire(@addr)

      # First release (2→1) does NOT unbind; second (1→0) unbinds once.
      expect(Grappa.Net.SourceAliasMock, :release_source, fn @addr, @prefix -> :ok end)
      assert :ok = Manager.release(@addr)
      assert :ok = Manager.release(@addr)
    end

    test "a failed bind does not leave a phantom ref-count" do
      start_manager()

      expect(Grappa.Net.SourceAliasMock, :ensure_source, fn @addr, @prefix -> {:error, :eacces} end)
      assert {:error, :eacces} = Manager.acquire(@addr)

      # A release of the never-bound address must NOT call release_source
      # (no expect set — an unexpected call fails verify).
      assert :ok = Manager.release(@addr)
    end
  end

  describe "reconcile" do
    test "releases an OS-bound alias that is not in the held set" do
      start_manager()

      # Hold @addr (bind it); @addr2 is an orphan the OS still reports.
      expect(Grappa.Net.SourceAliasMock, :ensure_source, fn @addr, @prefix -> :ok end)
      assert :ok = Manager.acquire(@addr)

      expect(Grappa.Net.SourceAliasMock, :list_aliases, fn @prefix -> {:ok, [@addr, @addr2]} end)
      # Only the orphan @addr2 is released; the held @addr is left alone.
      expect(Grappa.Net.SourceAliasMock, :release_source, fn @addr2, @prefix -> :ok end)

      assert :ok = Manager.reconcile()
    end

    # #543 INC-6 Part B — the crash-boundary the held-set widening closes. When
    # THIS manager restarts, its ref-count table resets to empty while live
    # `Session.Server` processes stay up + their aliases stay OS-bound. The
    # held set MUST union the refcount keys with the live holders (via the
    # injected `held_source_fn`, default `&Grappa.Session.live_derived_sources/0`
    # in prod), else the next reconcile classifies every in-use alias as an
    # orphan and RELEASES it — pulling the source out from under live sockets.
    test "reconcile keeps a live-held alias even when the refcount table is empty" do
      stub(Grappa.Net.SourceAliasMock, :arm_check, fn @prefix -> :ok end)
      stub(Grappa.Net.SourceAliasMock, :list_aliases, fn @prefix -> {:ok, []} end)

      # A live session holds @addr; the refcount table is empty (restart).
      pid =
        start_supervised!(
          {Manager, adapter: Grappa.Net.SourceAliasMock, prefix: @prefix, held_source_fn: fn -> [@addr] end}
        )

      drain_boot_reconcile(pid)

      expect(Grappa.Net.SourceAliasMock, :list_aliases, fn @prefix -> {:ok, [@addr, @addr2]} end)
      # ONLY the orphan @addr2 is released; the live-held @addr survives even
      # though it is absent from the (empty) refcount table.
      expect(Grappa.Net.SourceAliasMock, :release_source, fn @addr2, @prefix -> :ok end)

      assert :ok = Manager.reconcile()
    end

    test "held set is the UNION of refcount keys and live holders" do
      stub(Grappa.Net.SourceAliasMock, :arm_check, fn @prefix -> :ok end)
      stub(Grappa.Net.SourceAliasMock, :list_aliases, fn @prefix -> {:ok, []} end)

      # @addr2 is live-held (from the fn); @addr is ref-counted (acquired here).
      pid =
        start_supervised!(
          {Manager, adapter: Grappa.Net.SourceAliasMock, prefix: @prefix, held_source_fn: fn -> [@addr2] end}
        )

      drain_boot_reconcile(pid)

      expect(Grappa.Net.SourceAliasMock, :ensure_source, fn @addr, @prefix -> :ok end)
      assert :ok = Manager.acquire(@addr)

      # OS reports both held addresses + one true orphan; only the orphan goes.
      orphan = "2a03:4000:20:2d3:cb::dead"
      expect(Grappa.Net.SourceAliasMock, :list_aliases, fn @prefix -> {:ok, [@addr, @addr2, orphan]} end)
      expect(Grappa.Net.SourceAliasMock, :release_source, fn ^orphan, @prefix -> :ok end)

      assert :ok = Manager.reconcile()
    end
  end

  describe "arm gate" do
    test "armed? true + disarm_reason nil when arm_check passes at boot" do
      start_manager()
      assert Manager.armed?() == true
      assert Manager.disarm_reason() == nil
    end

    test "armed? false + concrete reason when arm_check refuses" do
      stub(Grappa.Net.SourceAliasMock, :list_aliases, fn @prefix -> {:ok, []} end)

      expect(Grappa.Net.SourceAliasMock, :arm_check, fn @prefix ->
        {:error, :wrapper_unavailable}
      end)

      pid = start_supervised!({Manager, adapter: Grappa.Net.SourceAliasMock, prefix: @prefix})
      drain_boot_reconcile(pid)

      assert Manager.armed?() == false
      assert Manager.disarm_reason() == :wrapper_unavailable
    end

    test "armed? false with :no_static_prefix when no prefix is configured" do
      stub(Grappa.Net.SourceAliasMock, :list_aliases, fn _ -> {:ok, []} end)
      # arm_check is NEVER invoked with a nil prefix — the manager short-circuits.
      pid = start_supervised!({Manager, adapter: Grappa.Net.SourceAliasMock, prefix: nil})
      drain_boot_reconcile(pid)

      assert Manager.armed?() == false
      assert Manager.disarm_reason() == :no_static_prefix
    end
  end

  # #627 — a nil/absent `static_mapping_prefix` (mode 2 unconfigured, the
  # default of a fresh install or a pre-#543 DB) must NEVER take the node down.
  # In prod (FreeBSD jail, on the release deployed at `b41b8d09`) `do_reconcile`
  # shelled `ifconfig lo0` and filtered `::1` through `in_cidr6?(_, nil)`,
  # raising in the boot `handle_continue` and escalating to the whole
  # application. The bug rode in with #543's source-alias reconcile; the arm
  # gate already disarms mode 2 for a nil prefix — the reconcile path must too.
  describe "nil prefix (#627) — mode 2 unconfigured must not crash the node" do
    # The ROOT of the fix, proven adapter-agnostically: the Mox adapter has NO
    # `list_aliases` (or `arm_check`) stub, so ANY boot-path adapter call would
    # raise inside the GenServer and surface as a DOWN. Green requires the
    # manager to early-return from reconcile — not merely a defensive adapter
    # clause — because it must do NO reconcile work with no prefix to diff.
    test "the manager never calls the adapter when there is no prefix" do
      pid =
        start_supervised!(%{
          id: Manager,
          start: {Manager, :start_link, [[adapter: Grappa.Net.SourceAliasMock, prefix: nil]]},
          restart: :temporary
        })

      ref = Process.monitor(pid)
      # handle_continue(:reconcile) runs async right after init; a nil-prefix
      # crash arrives as a DOWN within milliseconds.
      refute_receive {:DOWN, ^ref, :process, ^pid, _reason}, 500
      assert Process.alive?(pid)

      # An explicit reconcile is a no-op too — still no adapter call.
      assert :ok = Manager.reconcile()
      assert Process.alive?(pid)
    end

    # The faithful prod reproduction: the REAL FreeBSD adapter (cmd Mox'd) with
    # prefix nil. Pre-fix, the manager shells `ifconfig` and crashes on `::1`;
    # the `stub` feeds exactly that line. Post-fix the reconcile early-returns,
    # so `run/3` is never reached (stub tolerates zero calls).
    test "boots on the real FreeBSD adapter with prefix nil without crashing" do
      stub(Grappa.Sys.HardenedCmdMock, :run, fn "ifconfig", ["lo0"], _ ->
        {:ok, "lo0: flags=8049\n\tinet6 ::1 prefixlen 128\n"}
      end)

      pid =
        start_supervised!(%{
          id: Manager,
          start: {Manager, :start_link, [[adapter: FreeBSD, prefix: nil]]},
          restart: :temporary
        })

      ref = Process.monitor(pid)
      refute_receive {:DOWN, ^ref, :process, ^pid, _reason}, 500
      assert Process.alive?(pid)

      assert :ok = Manager.reconcile()
      assert Process.alive?(pid)
      assert Manager.disarm_reason() == :no_static_prefix
    end
  end

  describe "arm/1 — runtime re-arm (set-time probe, #609)" do
    @new_prefix "2a03:4000:20:2d3:ca::/80"

    test "probes the prefix, adopts it, and publishes armed on success" do
      start_manager()
      # start_manager stubbed arm_check(@prefix) for boot; arm/1 probes the NEW
      # prefix, so expect that explicitly.
      expect(Grappa.Net.SourceAliasMock, :arm_check, fn @new_prefix -> :ok end)

      assert :ok = Manager.arm(@new_prefix)
      assert Manager.armed?() == true
      assert Manager.disarm_reason() == nil

      # the adopted prefix is now the working prefix — a subsequent acquire binds
      # against it, proving state.prefix moved.
      addr = "2a03:4000:20:2d3:ca::1"
      expect(Grappa.Net.SourceAliasMock, :ensure_source, fn ^addr, @new_prefix -> :ok end)
      assert :ok = Manager.acquire(addr)
    end

    test "returns the reason and changes NO state on a refused probe" do
      start_manager()
      # boot armed true (@prefix); a refused arm/1 must NOT flip it to disarmed.
      assert Manager.armed?() == true

      expect(Grappa.Net.SourceAliasMock, :arm_check, fn @new_prefix ->
        {:error, :alias_not_permitted}
      end)

      assert {:error, :alias_not_permitted} = Manager.arm(@new_prefix)

      # unchanged: still armed against the boot prefix, no disarm published.
      assert Manager.armed?() == true
      assert Manager.disarm_reason() == nil
    end
  end

  describe "release/1 when no manager is running (issue 2697 X1)" do
    # The exit SHAPE a caller of `release/1` has to catch. `GenServer.call/3`
    # wraps every exit it raises as `{reason, {GenServer, :call, args}}`: the
    # unregistered-name branch and the `:gen.call` catch alike
    # (`gen_server.ex` 1133-1142 in Elixir 1.19). A clause matching a BARE
    # `:noproc` or `:timeout` therefore never fires, which is why
    # `Session.Server.release_alias_best_effort/1` catches only the wrapped
    # form.
    test "exits {:noproc, {GenServer, :call, _}}, never a bare :noproc" do
      assert Process.whereis(Manager) == nil

      assert {:noproc, {GenServer, :call, [Manager, {:release, @addr}, _]}} =
               catch_exit(Manager.release(@addr))
    end
  end
end
