defmodule Grappa.SpawnOrchestrator do
  @moduledoc """
  Cross-context verb-reuse helper for the **admission →
  backoff-reset → spawn** dance that two distinct call sites
  previously inlined.

  Cluster #8 (Theme 3 / resp-A1 / ext-A9 god-module decomposition,
  3/3) consolidates the duplicated quartet across:

    * `Grappa.Bootstrap` — boot-time spawn for both user credentials
      AND active visitor rows (see the `spawn_with_admission/6`
      private wrapper there). Was the prototype private helper that
      this module promotes to a public verb shared with the REST
      surface.
    * `GrappaWeb.NetworksController` — operator-driven respawn after
      `PATCH /networks/:id` flips `connection_state` to `:connected`
      (T32 reconnect verb; see the `spawn_session_after_connect/3`
      private helper there).

  ## Why this is a top-level boundary, not inside `Grappa.Session`

  Earlier draft placed this under `Grappa.Session.AdmissionOrchestrator`.
  That closes the cycle `Networks → Session → Admission → Networks`:

    * `Grappa.Networks` already deps `Grappa.Session` (Networks reads
      live nick / window state for wire shape).
    * `Grappa.Admission` deps `Grappa.Networks` (cap reads via
      `Network.max_concurrent_visitor_sessions` + `Credential` SQL
      joins). The U-1 schema split added
      `Network.max_concurrent_user_sessions` but admission still
      reads visitor-only — U-2 (subject-aware logic split) will
      flip admission to read both columns per `flow`'s subject_kind.
      Either way the `Admission → Networks` edge stays, so the cycle
      argument below is unchanged.

  Adding `Grappa.Session → Grappa.Admission` would close that
  triangle, which Boundary correctly rejects.

  Same constraint that the `S1.2` design note flagged for
  `Networks.connect/1`: `Networks` must NOT dep `Admission` to avoid
  the cycle, so the controller does the admission orchestration AT
  the controller. This module is the same fix one level up — the
  orchestrator lives in its OWN top-level boundary that deps both
  `Admission` AND `Session`, mirror-symmetric with `Grappa.Bootstrap`
  (which already declares `deps: [Grappa.Admission, Grappa.Networks,
  Grappa.Session, Grappa.Visitors]`).

  Top-level placement also matches the cross-cutting nature of the
  verb itself: it's neither admission-policy nor session-lifecycle —
  it's the **glue** that says "for an operator-initiated spawn, here
  is the canonical sequence." Any future spawn-initiating surface
  (a CLI command, a future `POST /networks/:id/connect` for a
  different verb, etc.) consumes this same helper without having to
  re-derive the sequence.

  ## Why visitor login (`Grappa.Visitors.Login`) is NOT a caller

  Cluster brainstorm flagged Visitors.Login as a third candidate.
  After reading the file the verbs diverge enough to fail the
  CLAUDE.md **"reuse the verbs, not the nouns"** test:

    * `Login.spawn_and_await/3` is a strictly RICHER verb than
      `Session.start_session/3`. It threads `notify_pid` + `notify_ref`
      through the start_opts so the spawned `Session.Server` can
      signal `:session_ready`, then `Process.monitor`s the new pid
      and `receive`s either `:session_ready`, a `:DOWN`, or a
      timeout. None of those concerns belong in this orchestrator
      (Bootstrap + NetworksController are fire-and-forget).
    * `Admission.check_capacity/1` is called BEFORE captcha + DB
      provision in `Login.dispatch(nil, ...)` (Case 1) — the dance
      is interleaved with non-spawn concerns, not consecutive.
    * `Backoff.reset/2` is called only in `preempt_and_respawn/4`
      (Case 2 — registered visitor respawn), not in Case 1
      (fresh anon provision) or Case 3 (anon token rotate, no spawn
      at all).
    * `Login` already wraps `NetworkCircuit.record_success/1` /
      `record_failure/1` around the spawn, plus
      `Visitors.purge_if_anon/1` cleanup on failure, plus
      `send_post_login_identify/3` post-readiness — adopting the
      orchestrator would require either a giant `opts` keyword or
      multiple injected callbacks. Both are shared-data-with-type-flag
      anti-patterns per CLAUDE.md design discipline.

  Forcing Login through this verb would not be reuse — it would be
  hiding a different state machine behind a shared name. The 80%
  shared by Bootstrap + NetworksController is genuine; the 80%
  Login appears to share is illusory. So this module covers the
  two true callers and Login keeps its verb.

  ## Contract

  Pure orchestration, NOT a process. The session GenServer + the
  Admission ETS/Registry checks ARE the synchronization primitives;
  bundling the call sequence into one module doesn't change concurrency
  semantics, only call-site duplication.

  Each `spawn/4` invocation:

    1. Calls `Grappa.Admission.check_capacity/1` with the caller's
       `capacity_input` (carries `flow:` discriminator —
       `:bootstrap_user`, `:bootstrap_visitor`, or
       `:patch_network_connect` — so Admission's own telemetry tags
       stay accurate).
    2. On `:ok`, calls `Grappa.Session.Backoff.reset/2`.
       **Why reset on every successful admission**: M-life-5 contract.
       Both call sites are operator actions (boot or PATCH /connect)
       overriding any prior failure history — the operator knows
       what they're doing; stale crash-backoff would block legitimate
       recovery.
    3. Calls `Grappa.Session.start_session/3` with the pre-resolved
       plan. The plan is whatever
       `Grappa.Networks.SessionPlan.resolve/1` (user) or
       `Grappa.Visitors.SessionPlan.resolve/1` (visitor) produced —
       this module is plan-shape-agnostic; it just threads the map
       through unchanged.
    4. Maps the start_session result into the unified
       `spawn_outcome/0` shape so call sites can branch on it
       without re-encoding `{:already_started, _}` semantics.

  ## Telemetry / logging — call sites OWN observability

  Cluster #8 design judgment (vjt-blessed Option A): this module
  emits NEITHER `Logger` lines NOR `:telemetry` events. The 3
  call-site-specific concerns (Bootstrap's tri-counter accumulator
  with structured `[user: id, network: slug]` metadata,
  NetworksController's `Logger.warning` on rejection, future
  observability dashboards) all live where the call site has the
  context — `:flow` value, `subject` shape, surrounding wire-shape.
  Keeping emission at the call site makes this refactor a strict
  zero-observability-change drop-in: existing log/telemetry tests
  on Bootstrap + NetworksController stay green without modification.

  If a future cluster wants unified `[:grappa, :session, :spawn, _]`
  telemetry, that's a deliberate cross-cutting decision — it can
  add an `emit_telemetry: true` opt or a wrapping module then.
  This refactor refuses to ship that shift accidentally.

  ## Reference: the verb-reuse principle

  Per CLAUDE.md "Design discipline" rule 6:

  > Reuse the verbs, not the nouns. When a second use case fits 80%
  > of existing infrastructure, ask "what are the 20% that don't fit?"
  > Those 20% are the domain boundary. Shared execution framework =
  > good reuse. Shared data model with a type flag = boundary
  > violation.

  This module is the archetypal **shared execution framework**: the
  three calls (admission → reset → spawn) ARE the verb. The 20%
  that varies (telemetry shape, accumulator vs early-return,
  Logger metadata) stays at the call site. No type-flag opt
  splits the orchestrator's behavior internally.
  """

  use Boundary,
    top_level?: true,
    deps: [Grappa.Admission, Grappa.Session]

  alias Grappa.{Admission, Session}
  alias Grappa.Session.Backoff

  @typedoc """
  The unified spawn-result shape. Call sites pattern-match on the
  three discriminants:

    * `{:ok, :spawned, pid}` — admission cleared, fresh
      `Session.Server` started under `SessionSupervisor`.
    * `{:ok, :already_started, pid}` — admission cleared, but a
      `Session.Server` for the same `(subject, network_id)` was
      already registered (Bootstrap restart idempotency,
      NetworksController PATCH-while-already-up). The pid is the
      live process; caller should treat as no-op.
    * `{:ok, :ignored}` — admission cleared, but `Session.Server.init/1`
      returned `:ignore` because the operator-owned DB row for the
      subject is gone (`Visitors.delete/1`, `Credentials.unbind_credential/2`).
      No pid; the DynamicSupervisor dropped the child permanently.
      Caller treats as no-op and may emit a Logger.info diagnostic.
    * `{:error, reason}` — either an `Admission.capacity_error()`
      (the cap or circuit tripped) OR a wrapped
      `{:start_failed, term()}` for any other
      `DynamicSupervisor.start_child/2` failure (upstream connect
      refused at `init/1`, etc.).
  """
  @type spawn_outcome ::
          {:ok, :spawned, pid()}
          | {:ok, :already_started, pid()}
          | {:ok, :ignored}
          | {:error, Admission.capacity_error()}
          | {:error, {:start_failed, term()}}

  @doc """
  Run the admission → backoff-reset → spawn dance for `subject` on
  `network_id` with the pre-resolved `plan`. `capacity_input` is
  passed verbatim to `Admission.check_capacity/1` — caller fills in
  the `flow:` discriminant and `client_id` per its own surface.

  See the moduledoc for the contract of each step + the
  unified `spawn_outcome/0` shape.
  """
  @spec spawn(Session.subject(), integer(), Session.start_opts(), Admission.capacity_input()) ::
          spawn_outcome()
  def spawn(subject, network_id, plan, capacity_input)
      when is_integer(network_id) and is_map(plan) and is_map(capacity_input) do
    case Admission.check_capacity(capacity_input) do
      :ok ->
        :ok = Backoff.reset(subject, network_id)

        case Session.start_session(subject, network_id, plan) do
          {:ok, pid} -> {:ok, :spawned, pid}
          {:error, {:already_started, pid}} -> {:ok, :already_started, pid}
          :ignore -> {:ok, :ignored}
          {:error, reason} -> {:error, {:start_failed, reason}}
        end

      {:error, _} = err ->
        err
    end
  end
end
