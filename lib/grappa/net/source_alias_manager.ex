defmodule Grappa.Net.SourceAliasManager do
  @moduledoc """
  Ref-counted lifecycle owner for derived outbound source aliases (#543
  `static_mapping_with_reservations`, mode 2).

  Many `(user, network)` sessions can share ONE derived `::cb` address (a
  NAT/CGNAT collapses many clients behind one `/64` to a single derived
  source). Binding it per-session and unbinding on every disconnect would
  churn `ifconfig`; binding it once and never removing it would leak. So this
  GenServer keeps a per-address ref-count: `acquire/1` binds on the 0→1
  transition, `release/1` unbinds on 1→0.

  ## Arm gate

  At init (once the Repo is up so `ServerSettings.static_mapping_prefix/0` is
  readable) it runs the platform adapter's `arm_check/1` against the configured
  prefix and publishes `armed?` to `:persistent_term`. The session plan folds
  `armed?/0` into the addressing config; a disarmed mode 2 is HELD
  (`{:hold, :mode2_disarmed}`) rather than egressing from a shared
  kernel-default source (Global Constraint: refuse to arm). `armed?/0` /
  `disarm_reason/0` are lock-free reads — no GenServer round-trip on the
  connect path.

  `arm/1` re-runs the gate at RUNTIME: the admin settings write (#609) calls it
  BEFORE persisting a mode-2 addressing change, so an unusable mode is rejected
  with the concrete reason (422) and never reaches the DB, and a successful set
  adopts the new prefix + publishes `armed?` without a reboot (B1). It changes
  NO state on refusal — a failed set-time probe must not disarm a manager that
  is currently working.

  ## Boot reconcile

  `reconcile/0` diffs the OS ground truth (`adapter.list_aliases/1`) against
  the set of addresses that SHOULD remain bound (`held_addresses/1`) and
  releases the orphans a crashed prior run left bound. It runs once at startup
  via `handle_continue/2` — the child is ordered AFTER the Endpoint (so the
  public surface is up first) and BEFORE Bootstrap (so the sweep clears stale
  aliases before sessions re-acquire).

  ## Boundary

  Sibling boundary to `Grappa.Net.SourceAlias` (the pure adapter subsystem):
  this deps that + `Grappa.ServerSettings` (the DB prefix it arms against).
  The lifecycle state (ref-counts) is small and per-node, so it lives in the
  GenServer state map — every acquire/release/reconcile is serialized through
  the mailbox, so no ETS/cross-process read is needed.
  """

  use GenServer

  use Boundary,
    top_level?: true,
    deps: [Grappa.Net.SourceAlias, Grappa.ServerSettings]

  alias Grappa.Net.SourceAlias.Config
  alias Grappa.ServerSettings

  require Logger

  @arm_key {__MODULE__, :arm}

  # Every mailbox-serialized call here (acquire/release/reconcile/arm) shells
  # out to the adapter (ifconfig add/del/probe, up to the adapter's @timeout_s
  # ceiling); the GenServer.call budget must exceed that ceiling so a slow
  # shell-out returns an {:error, _} the caller can handle instead of crashing
  # it with the default 5s call-timeout EXIT (e.g. a set-time `arm` probe
  # blocking a concurrent connect's `acquire`). A pathological QUEUE of several
  # slow shell-outs can still exceed this — a pre-existing mailbox-serialization
  # limit, not introduced by the runtime probe.
  @call_timeout 15_000

  @type state :: %{
          refcounts: %{optional(String.t()) => pos_integer()},
          prefix: String.t() | nil,
          adapter: module(),
          held_source_fn: (-> [String.t()])
        }

  # -- API --------------------------------------------------------------------

  @spec start_link(keyword()) :: GenServer.on_start()
  def start_link(opts) do
    {name, opts} = Keyword.pop(opts, :name, __MODULE__)
    GenServer.start_link(__MODULE__, opts, name: name)
  end

  @doc """
  Ensure `addr` is bound (ref-count 0→1 binds via the adapter). Returns the
  adapter error WITHOUT incrementing when the bind fails — a failed bind must
  not leave a phantom ref-count that would later "release" an alias that was
  never created.
  """
  @spec acquire(String.t()) :: :ok | {:error, term()}
  def acquire(addr) when is_binary(addr),
    do: GenServer.call(__MODULE__, {:acquire, addr}, @call_timeout)

  @doc """
  Drop a reference to `addr` (ref-count 1→0 unbinds via the adapter). A
  best-effort operation: a release of an unheld address is a no-op `:ok`, and
  an adapter failure on the 1→0 unbind is LOGGED but still returns `:ok` (the
  boot reconcile is the backstop that reclaims a stuck alias).
  """
  @spec release(String.t()) :: :ok
  def release(addr) when is_binary(addr),
    do: GenServer.call(__MODULE__, {:release, addr}, @call_timeout)

  @doc """
  Release the alias orphans — bound at the OS layer but not in the held set.
  See the moduledoc + `held_addresses/1`.
  """
  @spec reconcile() :: :ok
  def reconcile, do: GenServer.call(__MODULE__, :reconcile, @call_timeout)

  @doc """
  Probe `prefix` and, on success, adopt it as the manager's working prefix and
  publish `armed?`. Returns `{:error, reason}` WITHOUT changing state when the
  probe refuses.

  The admin settings write (#609) calls this BEFORE it persists a mode-2
  change: on `{:error, reason}` the controller returns 422 with the reason and
  does NOT persist (an unusable mode never reaches the DB); on `:ok` it persists
  while the manager's `armed?`/prefix already reflect the new value, so mode 2
  goes live without a reboot (B1).
  """
  @spec arm(String.t()) :: :ok | {:error, atom()}
  def arm(prefix) when is_binary(prefix), do: GenServer.call(__MODULE__, {:arm, prefix}, @call_timeout)

  @doc """
  True when the platform adapter armed mode 2 at boot. Lock-free read
  (`:persistent_term`); defaults to `false` (disarmed) before the manager
  boots, so a mode-2 subject is safely HELD rather than egressing wrong.
  """
  @spec armed?() :: boolean()
  def armed?, do: elem(arm_state(), 0)

  @doc "The reason mode 2 is disarmed (nil when armed). Lock-free read."
  @spec disarm_reason() :: atom() | nil
  def disarm_reason, do: elem(arm_state(), 1)

  defp arm_state, do: :persistent_term.get(@arm_key, {false, :not_armed})

  # -- GenServer --------------------------------------------------------------

  @impl GenServer
  def init(opts) do
    adapter = Keyword.get_lazy(opts, :adapter, &Config.adapter/0)
    prefix = Keyword.get_lazy(opts, :prefix, &ServerSettings.static_mapping_prefix/0)

    # #543 INC-6 — the live-holder source for `held_addresses/1`, INJECTED so
    # this manager (a `Grappa.Net` boundary) stays OFF a `Grappa.Session`
    # (domain) dep: a Net→Session edge would be backwards. `application.ex`
    # wires `&Grappa.Session.live_derived_sources/0` (the pure `Registry`
    # read); the default is the empty list = the INC-5 behaviour (refcount-only
    # held set), safe when no fn is injected (the manager's own unit tests, or
    # a mis-wire — never a live-alias release, only a skipped orphan sweep).
    held_source_fn = Keyword.get(opts, :held_source_fn, fn -> [] end)

    publish_arm(compute_arm(adapter, prefix))

    {:ok, %{refcounts: %{}, prefix: prefix, adapter: adapter, held_source_fn: held_source_fn}, {:continue, :reconcile}}
  end

  @impl GenServer
  def handle_continue(:reconcile, state) do
    {:noreply, do_reconcile(state)}
  end

  @impl GenServer
  def handle_call({:acquire, addr}, _, state) do
    case Map.get(state.refcounts, addr, 0) do
      0 ->
        case state.adapter.ensure_source(addr, state.prefix) do
          :ok ->
            {:reply, :ok, put_in(state.refcounts[addr], 1)}

          {:error, _} = err ->
            {:reply, err, state}
        end

      n ->
        {:reply, :ok, put_in(state.refcounts[addr], n + 1)}
    end
  end

  @impl GenServer
  def handle_call({:release, addr}, _, state) do
    case Map.get(state.refcounts, addr, 0) do
      0 ->
        Logger.warning("source-alias release of unheld address #{inspect(addr)} — ignoring")
        {:reply, :ok, state}

      1 ->
        _ = unbind(state, addr)
        {:reply, :ok, %{state | refcounts: Map.delete(state.refcounts, addr)}}

      n ->
        {:reply, :ok, put_in(state.refcounts[addr], n - 1)}
    end
  end

  @impl GenServer
  def handle_call(:reconcile, _, state) do
    {:reply, :ok, do_reconcile(state)}
  end

  @impl GenServer
  def handle_call({:arm, prefix}, _, state) do
    case compute_arm(state.adapter, prefix) do
      {true, nil} = arm ->
        publish_arm(arm)
        {:reply, :ok, %{state | prefix: prefix}}

      {false, reason} ->
        # Refuse WITHOUT touching state: the current arm/prefix stand and the
        # caller returns 422 without persisting. We deliberately do NOT publish
        # the disarm — a failed set-time probe must not flip a currently-armed
        # manager to disarmed (only boot + a SUCCESSFUL set change arm state).
        {:reply, {:error, reason}, state}
    end
  end

  # -- internals --------------------------------------------------------------

  # The set of addresses that SHOULD remain bound for the reconcile diff. Its
  # crash-survival source of truth is source 2 below (the LIVE HOLDERS): every
  # in-use derived alias has a live `Session.Server` registered under it, and
  # that survives THIS manager's own restart (when `state.refcounts` has reset
  # to empty). Source 1 (the refcount keys) is unioned in only as a CONSERVATIVE
  # belt-and-braces: in steady state it is a SUBSET of the holders (every
  # acquire both increments the refcount AND registers a holder), so the union
  # merely guarantees `held ⊇ refcount` — source 1 is NOT independently required
  # for the held set. Keeping it is zero-cost INSURANCE: the union can only err
  # by EXCESS (`held` a superset ⇒ reconcile releases only TRUE orphans, never a
  # live alias), and reconcile exists precisely for the states where the two
  # structures DIVERGE — so folding one away to save nothing would only narrow
  # the safety margin.
  #
  # That is DISTINCT from the two STRUCTURES both being needed by the SYSTEM,
  # which they are — do not fold them together:
  #
  #   1. `state.refcounts` — authoritative for the PROMPT bind/unbind decisions
  #      (`ensure_source` once on 0→1, `release_source` once on 1→0),
  #      self-contained + serialized through the mailbox so the count-mutation
  #      AND the ifconfig are decided atomically in one op (no distributed-count
  #      race). It resets to empty on this manager's own crash.
  #   2. `state.held_source_fn.()` — the live `Session.Server` holders, read
  #      from the `Grappa.SourceAliasHolders` `:duplicate` Registry via the
  #      injected fn. It survives a manager restart (sessions + their OS-bound
  #      aliases stay up) and is auto-GC'd by the BEAM on holder death. It
  #      CANNOT drive prompt unbind — Registry GC is passive: no callback fires
  #      `release_source` on last-holder death — which is exactly why source 1,
  #      not this, owns the unbind.
  #
  # Why source 2 matters HERE: on a MANAGER restart `refcounts` is empty but
  # sessions still hold aliases; without it the very next reconcile would
  # classify every in-use alias as an orphan and RELEASE it, pulling the source
  # out from under live upstream sockets. The reconcile diff below is UNCHANGED
  # — INC-6 only widened the SOURCE here (MapSet dedups the overlap).
  @spec held_addresses(state()) :: [String.t()]
  defp held_addresses(state), do: Map.keys(state.refcounts) ++ state.held_source_fn.()

  # #627 — with no prefix, mode 2 is unconfigured (the arm gate already
  # disarmed it, see `compute_arm/2`): there is no derivation block to
  # reconcile against and nothing can be a managed alias, so the sweep is not
  # merely unnecessary — it has no business running. Doing it anyway shelled
  # `ifconfig lo0` and filtered `::1` through `in_cidr6?(_, nil)`, raising in
  # the boot `handle_continue` and escalating to the whole application, so a
  # mode-1 / fresh install (no `addressing.static_mapping_prefix` row) could
  # not start. The arm gate guarded the bind decisions but not this path.
  defp do_reconcile(%{prefix: nil} = state), do: state

  defp do_reconcile(state) do
    case state.adapter.list_aliases(state.prefix) do
      {:ok, os_bound} ->
        held = MapSet.new(held_addresses(state))
        orphans = Enum.reject(os_bound, &MapSet.member?(held, &1))

        if orphans != [] do
          Logger.info("source-alias reconcile: releasing #{length(orphans)} orphan alias(es)")
          Enum.each(orphans, &unbind(state, &1))
        end

        state

      {:error, reason} ->
        Logger.warning("source-alias reconcile: list_aliases failed (#{inspect(reason)}) — skipping sweep")
        state
    end
  end

  # Best-effort OS unbind, LOGGED on failure (no silent swallow — CLAUDE.md
  # boundary rule). Reconcile is the backstop for a stuck alias.
  defp unbind(state, addr) do
    case state.adapter.release_source(addr, state.prefix) do
      :ok ->
        :ok

      {:error, reason} ->
        Logger.warning("source-alias release_source failed for #{inspect(addr)}: #{inspect(reason)}")
        {:error, reason}
    end
  end

  defp compute_arm(_, nil), do: {false, :no_static_prefix}

  defp compute_arm(adapter, prefix) when is_binary(prefix) do
    case adapter.arm_check(prefix) do
      :ok -> {true, nil}
      {:error, reason} -> {false, reason}
    end
  end

  defp publish_arm({armed?, reason} = arm) do
    unless armed? do
      Logger.info("source-alias mode 2 disarmed (#{inspect(reason)}) — static-mapping sessions will be held")
    end

    :persistent_term.put(@arm_key, arm)
    :ok
  end

  if Mix.env() == :test do
    @doc false
    @spec put_test_armed(boolean(), atom() | nil) :: :ok
    def put_test_armed(armed?, reason) do
      :persistent_term.put(@arm_key, {armed?, reason})
      :ok
    end
  end
end
