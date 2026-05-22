defmodule Grappa.Operator do
  @moduledoc """
  Host-side operator verbs invoked via `bin/grappa` against the live BEAM.

  Each public function is the target of a `bin/grappa <verb>` dispatch
  through `iex --rpc-eval grappa@grappa "Grappa.Operator.<verb>(...)"`
  (T-2's Erlang-dist + `--rpc-eval` shape). The bash wrapper is a thin
  shell; the operator-facing logic + text formatting live here so that
  one feature = one code path, every door (CLAUDE.md "One feature, one
  code path, every door"):

    * `delete_visitor!/1` — synchronously terminate the visitor's
      `Session.Server` BEFORE deleting the DB row. Frees the
      `SessionRegistry` cap slot in the same call.
    * `reap_visitors!/0` — force `Grappa.Visitors.Reaper` sweep on demand
      instead of waiting up to 60s for the next tick.
    * `reap_visitors/0` (typed sibling) + `reset_circuit/1` —
      M-cluster M-5 HTTP-facing verbs (operator admin console).
      Same orchestration as the bang-variants where they exist; no
      stdout side-effect so the controller can render the result
      into the JSON response.
    * `list_visitors_text!/0`, `list_credentials_text!/0`,
      `list_sessions_text!/0` — print tab-separated operator tables
      (header + rows) for grep / awk pipelines.

  ## Why a dedicated module, not per-context helpers

  Operator UX is a NEW domain — not a property of `Visitors`, `Networks`,
  or `Session` (CLAUDE.md "Reuse the verbs, not the nouns"). Co-locating
  the verbs keeps the rpc-eval surface auditable: any new `bin/grappa`
  verb that touches live state lands here, with the same Boundary deps
  + the same test file.

  ## Output

  Functions print to stdout via `IO.puts/1` then return `:ok`. The
  `:ok` is echoed by `--rpc-eval`'s built-in `inspect/1` of the
  evaluated expression result — same precedent as the T-2 remote-shell
  `--batch` examples.

  Errors propagate as exceptions (e.g. `Ecto.NoResultsError` on unknown
  visitor id) so `bin/grappa` exits non-zero on operator misuse. The
  Operator boundary deliberately does NOT wrap errors in
  `{:ok, _} | {:error, _}` tuples — `bin/grappa` is interactive; a
  crash + stderr line is the right operator UX (clarity over silence).

  ## Boundary

  Deps cover the three lib/ contexts whose live state the verbs read or
  mutate. The `Reaper` module sits in its own top-level boundary
  (`Grappa.Visitors.Reaper`) so it shows up explicitly in the dep list.
  `Registry` is Erlang stdlib — no boundary entry needed.
  """

  use Boundary,
    top_level?: true,
    deps: [
      Grappa.Admission,
      Grappa.AdminEvents,
      Grappa.LiveIntrospection,
      Grappa.Networks,
      Grappa.Session,
      Grappa.Visitors,
      Grappa.Visitors.Reaper
    ]

  alias Grappa.AdminEvents
  alias Grappa.AdminEvents.Wire, as: AdminWire
  alias Grappa.Admission.NetworkCircuit
  alias Grappa.{LiveIntrospection, Networks, Session, Visitors}
  alias Grappa.LiveIntrospection.SessionEntry
  alias Grappa.Networks.Credentials
  alias Grappa.Visitors.Visitor

  require Logger

  @disconnect_reason "disconnected by admin"
  @terminate_reason "terminated by admin"

  @typedoc """
  Optional admin actor attribution for M-11 admin-event emission.
  `nil` for system / `bin/grappa` invocations; `{user_id, user_name}`
  for admin REST surfaces (controllers thread `conn.assigns.current_subject`).
  """
  @type actor :: nil | {String.t(), String.t()}

  @doc """
  Synchronously terminate the visitor's `Session.Server` (if any) and
  delete the DB row. CASCADE wipes `visitor_channels`, `messages`,
  `accounts_sessions`, `query_windows`, `push_subscriptions`,
  `user_settings`, `read_cursors` in the same transaction (V CP32
  visitor-parity invariant).

  Synchronous: `Session.stop_session/2` waits for the `:DOWN` AND the
  registry-unregister before returning, so the cap slot is free by the
  time `delete_visitor!/1` returns. Operator dashboards reading
  `Admission.check_capacity/1` see the slot back immediately.

  Unknown id: raises `Ecto.NoResultsError` after a stderr line.
  Operator clarity > silence; `bin/grappa` exits non-zero.
  """
  @spec delete_visitor!(Ecto.UUID.t()) :: :ok | no_return()
  def delete_visitor!(id) when is_binary(id) do
    case delete_visitor(id, nil) do
      :ok ->
        :ok

      {:error, :not_found} ->
        IO.puts(:stderr, "visitor #{id} not found")
        raise Ecto.NoResultsError, queryable: Visitor
    end
  end

  @doc """
  Typed-error sibling of `delete_visitor!/1` for HTTP / programmatic
  callers (M-cluster M-3 admin endpoint `DELETE /admin/visitors/:id`).
  Same orchestration — Session.stop_session BEFORE Visitors.delete so
  the cap slot frees synchronously — but returns
  `{:error, :not_found}` on unknown id instead of raising.

  Side-effect parity with `delete_visitor!/1`: prints the same
  human-readable lines (deleted / orphaned-network / concurrent-reaper).
  The HTTP path captures the return shape for FallbackController; the
  bin/grappa path captures stdout for operator UX. One feature, one
  code path, every door.

  `actor` (M-11) is `nil` for `bin/grappa` invocations + the
  3-arity HTTP wrapper without admin attribution; `{user_id,
  user_name}` for admin REST callers. Threaded into the
  `:visitor_deleted` admin event so the operator console shows
  who triggered the delete.
  """
  @spec delete_visitor(Ecto.UUID.t()) :: :ok | {:error, :not_found}
  def delete_visitor(id) when is_binary(id), do: delete_visitor(id, nil)

  @spec delete_visitor(Ecto.UUID.t(), actor()) :: :ok | {:error, :not_found}
  def delete_visitor(id, actor) when is_binary(id) do
    case Visitors.get(id) do
      nil ->
        {:error, :not_found}

      visitor ->
        :ok = stop_visitor_session(visitor)
        :ok = log_delete_outcome(id, visitor, Visitors.delete(id))
        :ok = emit_visitor_deleted(visitor, actor)
        :ok
    end
  end

  @spec emit_visitor_deleted(Visitor.t(), actor()) :: :ok
  defp emit_visitor_deleted(%Visitor{} = v, actor) do
    {actor_id, actor_name} = unpack_actor(actor)
    AdminEvents.record(AdminWire.visitor_deleted(v.id, v.nick, v.network_slug, actor_id, actor_name))
  end

  defp stop_visitor_session(%Visitor{id: id, network_slug: slug}) do
    case Networks.get_network_by_slug(slug) do
      {:ok, network} ->
        :ok = Session.stop_session({:visitor, id}, network.id)

      {:error, :not_found} ->
        # Visitor row pinned to a network that no longer exists. The DB
        # delete still works (CASCADE wipes dependents); there's no
        # live session to terminate because spawn requires the network
        # row to resolve. Surface via stderr so the operator knows the
        # row was orphaned.
        IO.puts(:stderr, "network #{slug} not found, no session to stop")
    end

    :ok
  end

  defp log_delete_outcome(id, visitor, :ok) do
    IO.puts("deleted visitor #{id} (#{visitor.nick}@#{visitor.network_slug})")
    :ok
  end

  # Reaper / concurrent operator raced; the post-condition we promised
  # (row gone) is reached but a sibling did the work. Honest log so the
  # operator dashboard distinguishes "I freed the slot" from "someone
  # else already had".
  defp log_delete_outcome(id, _, {:error, :not_found}) do
    IO.puts("visitor #{id} already deleted (concurrent reaper or operator)")
    :ok
  end

  @doc """
  Force-run `Grappa.Visitors.Reaper.sweep/0` on demand. Returns `:ok`
  after printing the swept count. The Reaper runs its scheduled tick
  every 60s; this verb is the operator-on-demand variant.
  """
  @spec reap_visitors!() :: :ok
  def reap_visitors! do
    {:ok, n} = Grappa.Visitors.Reaper.sweep()
    IO.puts("reaped #{n} expired visitor(s)")
    :ok
  end

  @doc """
  Typed-error sibling of `reap_visitors!/0` for HTTP / programmatic
  callers (M-cluster M-5 `POST /admin/reaper/run`). Same delegation
  to `Visitors.Reaper.sweep/0`; returns the swept count instead of
  printing it so the HTTP path can render it into the JSON response.
  One feature, one code path, every door.
  """
  @spec reap_visitors() :: {:ok, non_neg_integer()}
  def reap_visitors, do: reap_visitors(nil)

  @doc """
  M-11 admin-event aware variant. Emits the `:reaper_swept` summary
  unconditionally (even on count=0) — operator clicked the button,
  the events tab should confirm. Scheduled-tick path
  (`Reaper.handle_info(:tick, ...)`) suppresses count=0 to avoid
  flooding the ring buffer. Per-row `:visitor_reaped` events fire
  inside `Reaper.sweep/0` regardless of trigger source.
  """
  @spec reap_visitors(actor()) :: {:ok, non_neg_integer()}
  def reap_visitors(actor) do
    {:ok, n} = Grappa.Visitors.Reaper.sweep()
    {actor_id, actor_name} = unpack_actor(actor)

    # actor_id/name not yet threaded into reaper_swept wire shape (the
    # event is :reaper_swept count, not :reaper_swept actor) — but the
    # un-suppressed emit on count=0 IS the operator-attribution
    # signal: scheduled ticks suppress, so any count=0 row in the
    # events tab provably came from a manual reap click. Future
    # cluster may extend the wire shape with actor; today the
    # presence-of-event-on-count-zero is the audit signal.
    _ = {actor_id, actor_name}
    :ok = AdminEvents.record(AdminWire.reaper_swept(n))

    {:ok, n}
  end

  @doc """
  Operator-driven clear of the per-network admission circuit-breaker
  (M-cluster M-5 `POST /admin/circuit/:network_id/reset`). Verifies
  the network row exists first so an unknown id surfaces as
  `{:error, :not_found}` instead of a silent ETS delete on a stale
  FK.

  Returns the post-reset ETS snapshot (`nil` after a successful
  reset — the row is gone). Synchronous: the cast is followed by a
  `:sys.get_state/1` mailbox drain so the caller observes the
  cleared state.
  """
  @spec reset_circuit(integer()) ::
          {:ok, NetworkCircuit.entry() | nil} | {:error, :not_found}
  def reset_circuit(network_id), do: reset_circuit(network_id, nil)

  @doc """
  M-11 admin-event aware variant. Emits a synthetic `:circuit_reset`
  event with actor attribution. The telemetry-side `:circuit, :close,
  reason: :operator_reset` is intentionally `:skip`-ed in
  `Wire.from_telemetry/3` so this synthetic emit is the single
  source for the operator-reset surface.
  """
  @spec reset_circuit(integer(), actor()) ::
          {:ok, NetworkCircuit.entry() | nil} | {:error, :not_found}
  def reset_circuit(network_id, actor) when is_integer(network_id) do
    case Networks.get_network(network_id) do
      nil ->
        {:error, :not_found}

      network ->
        # REV-J M10: synchronous reset via the public verb. Pre-fix this
        # used `NetworkCircuit.reset/1` (cast) + `:sys.get_state/1` to
        # drain the mailbox — a debug primitive that coupled Operator
        # to NetworkCircuit's GenServer-backed-by-ETS internals. The
        # snapshot below now reflects the operator verb because
        # `reset_sync/1` only returns after the ETS delete + telemetry
        # have fired.
        :ok = NetworkCircuit.reset_sync(network_id)

        post = Enum.find(NetworkCircuit.entries(), &match?({^network_id, _, _, _, _}, &1))

        {actor_id, actor_name} = unpack_actor(actor)
        :ok = AdminEvents.record(AdminWire.circuit_reset(network_id, network.slug, actor_id, actor_name))

        {:ok, post}
    end
  end

  @doc """
  M-cluster M-9a: T32 disconnect a live session by `(subject, network_id)`.

  ## Branches

    * `{:user, _} == subject` AND `actor_user_id` matches → reject
      `{:error, :cannot_disconnect_self}`. Server-side gate so an
      operator hitting the URL via curl can't lock themselves out
      either. Visitor subjects never collide with `actor_user_id`
      (admin is always a user), so the check is skipped there.
    * `{:user, user_id}` with a credential row in `:connected` → delegate
      to `Networks.disconnect/2` (sends QUIT upstream, stops the
      Session.Server, transitions `connection_state` to `:parked`,
      broadcasts state change).
    * `{:user, user_id}` with a credential in `:parked | :failed` →
      `:ok` (post-condition met; `Logger.info` records the no-op).
      Operator boundary absorbs `:not_connected` here so the
      controller can stay uniform on 204.
    * `{:user, user_id}` with no credential row → `{:error, :not_found}`.
    * `{:visitor, visitor_id}` → collapse to `terminate_session/3`
      semantics. Visitors carry no `connection_state` to park; the
      uniform-surface choice is "Disconnect == Terminate" for
      visitor pids so cic doesn't grow a subject-discriminated
      parallel state machine.

  `actor_user_id == nil` disables the self-check — reserved for
  future `bin/grappa disconnect-session` operator overrides where
  the rpc-eval path runs as root.

  Logger context: `subject`, `network_id`, and `actor_user_id` are
  inlined into the message body (NOT passed as metadata) to keep the
  global allowlist tight — same pattern as `Session.stop_session/2`'s
  budget-exhaustion line (see `session.ex:230-238`).
  """
  @spec disconnect_session(Session.subject(), integer(), Ecto.UUID.t() | nil) ::
          :ok | {:error, :not_found | :cannot_disconnect_self}
  def disconnect_session(subject, network_id, actor_user_id) do
    disconnect_session(subject, network_id, actor_user_id, nil)
  end

  @doc """
  M-11 admin-event aware variant. `actor` is `nil` for `bin/grappa`
  rpc-eval invocations (no Plug.Conn in scope); `{user_id,
  user_name}` for admin REST callers.
  """
  @spec disconnect_session(Session.subject(), integer(), Ecto.UUID.t() | nil, actor()) ::
          :ok | {:error, :not_found | :cannot_disconnect_self}
  def disconnect_session({:user, user_id} = subject, network_id, actor_user_id, actor)
      when is_binary(user_id) and is_integer(network_id) and
             (is_binary(actor_user_id) or is_nil(actor_user_id)) do
    # MED-4 (M-11 review): credential lookup BEFORE the self-protect
    # check so a bogus (admin_uuid, missing_network_id) request gets
    # 404 instead of leaking "network exists" via 422 vs 404 differ-
    # entiation. dispatch_user_session returns `{:error, :not_found}`
    # when no credential row matches the (user_id, network_id) pair.
    #
    # REV-J M11: gate `:session_disconnected` emission on the actual
    # `:connected → :parked` transition having occurred. Pre-fix the
    # event fired whenever `disconnect_user_session` returned `:ok`,
    # including the already-`:parked|:failed` no-op branch — the
    # admin events ring buffer falsely claimed "the operator
    # disconnected this session" when nothing happened. Symmetric
    # with the visitor branch which already gates on `Session.whereis/2`.
    with {:ok, %{connection_state: _}} <- Credentials.get_credential_by_ids(user_id, network_id),
         :ok <- guard_not_self(user_id, actor_user_id),
         {:ok, outcome} <- disconnect_user_session(subject, network_id, actor_user_id) do
      if outcome == :transitioned do
        :ok = emit_session_disconnected(:user, user_id, network_id, actor)
      end

      :ok
    end
  end

  def disconnect_session({:visitor, visitor_id} = subject, network_id, actor_user_id, actor)
      when is_binary(visitor_id) and is_integer(network_id) and
             (is_binary(actor_user_id) or is_nil(actor_user_id)) do
    Logger.debug(
      "visitor disconnect collapsed to terminate " <>
        "(subject=#{inspect(subject)} network_id=#{network_id})"
    )

    # Visitor disconnect collapses to terminate (no `:parked` state).
    # Emit `:session_disconnected` ONLY when there's actually a live
    # pid to disconnect from — without this gate, an operator
    # clicking Disconnect on a visitor whose Session.Server already
    # exited (deleted-row race, prior terminate) gets a fabricated
    # event saying "the visitor was just disconnected" when nothing
    # happened. terminate_session/4 still fires its own
    # `:session_terminated` regardless — `Session.stop_session` is
    # idempotent and the wire shape there means "the row stopped
    # being a live pid," which is true post-call either way.
    if Session.whereis(subject, network_id) do
      :ok = emit_session_disconnected(:visitor, visitor_id, network_id, actor)
    end

    terminate_session(subject, network_id, actor_user_id, actor)
  end

  defp guard_not_self(user_id, user_id) when is_binary(user_id),
    do: {:error, :cannot_disconnect_self}

  defp guard_not_self(_, _), do: :ok

  @spec disconnect_user_session(Session.subject(), integer(), Ecto.UUID.t() | nil) ::
          {:ok, :transitioned | :noop} | {:error, :not_found}
  defp disconnect_user_session({:user, user_id} = subject, network_id, actor_user_id) do
    case Credentials.get_credential_by_ids(user_id, network_id) do
      {:ok, %{connection_state: :connected} = cred} ->
        # Networks.disconnect/2 guarantees {:ok, _} on :connected input
        # (lib/grappa/networks.ex:369-386 only short-circuits on parked/
        # failed); the bare match crashes loudly if a future refactor
        # changes the shape — preferable to a defensive case that hides
        # the contract (CLAUDE.md "Dialyzer warnings are design signals").
        {:ok, _} = Networks.disconnect(cred, @disconnect_reason)

        Logger.info(
          "admin disconnected user session " <>
            "(subject=#{inspect(subject)} network_id=#{network_id} " <>
            "actor_user_id=#{inspect(actor_user_id)})"
        )

        {:ok, :transitioned}

      {:ok, %{connection_state: state}} when state in [:parked, :failed] ->
        Logger.info(
          "admin disconnect on credential already not connected " <>
            "(subject=#{inspect(subject)} network_id=#{network_id} " <>
            "state=#{state} actor_user_id=#{inspect(actor_user_id)})"
        )

        {:ok, :noop}

      {:error, :not_found} ->
        {:error, :not_found}
    end
  end

  @doc """
  M-cluster M-9a: synchronously stop the live `Session.Server` for
  `(subject, network_id)`. Does NOT touch the DB row — for user
  credentials, `connection_state` stays at its current value;
  for visitor rows, the row remains (use
  `delete_visitor/1` for the row-delete variant).

  Idempotent: returns `:ok` whether or not a pid is registered for
  the key (the post-condition — "no live pid" — is met either way).

  Self-protection same as `disconnect_session/3`: 422
  `{:error, :cannot_disconnect_self}` when `actor_user_id` matches
  a user subject. Visitor subjects bypass the check.
  """
  @spec terminate_session(Session.subject(), integer(), Ecto.UUID.t() | nil) ::
          :ok | {:error, :cannot_disconnect_self}
  def terminate_session(subject, network_id, actor_user_id) do
    terminate_session(subject, network_id, actor_user_id, nil)
  end

  @doc """
  M-11 admin-event aware variant. Emits `:session_terminated` after
  the synchronous stop_session.
  """
  @spec terminate_session(Session.subject(), integer(), Ecto.UUID.t() | nil, actor()) ::
          :ok | {:error, :cannot_disconnect_self}
  def terminate_session({:user, user_id}, _, actor_user_id, _)
      when is_binary(user_id) and is_binary(actor_user_id) and user_id == actor_user_id,
      do: {:error, :cannot_disconnect_self}

  def terminate_session(subject, network_id, actor_user_id, actor)
      when is_integer(network_id) and (is_binary(actor_user_id) or is_nil(actor_user_id)) do
    _ = best_effort_quit(subject, network_id)
    :ok = Session.stop_session(subject, network_id)

    Logger.info(
      "admin terminated session " <>
        "(subject=#{inspect(subject)} network_id=#{network_id} " <>
        "actor_user_id=#{inspect(actor_user_id)})"
    )

    {subject_kind, subject_id} = subject
    :ok = emit_session_terminated(subject_kind, subject_id, network_id, actor)
    :ok
  end

  # `@terminate_reason` is a literal module attribute with no CR/LF/NUL,
  # so `Session.send_quit/3` will never return `:invalid_line` — we don't
  # plug for it. If a future hand swaps the reason to bytes that fail
  # `Identifier.safe_line_token?/1`, the bare match crashes loudly and
  # the operator sees "fix the reason constant" rather than a silent
  # swallow. The `:no_session` branch IS reachable (no live pid is the
  # happy case for a hard terminate).
  defp best_effort_quit(subject, network_id) do
    case Session.send_quit(subject, network_id, @terminate_reason) do
      :ok -> :ok
      {:error, :no_session} -> :ok
    end
  end

  @doc """
  Print active visitors (anon TTL not yet elapsed + identified
  never-expires rows) as a tab-separated table: header + one row per
  visitor. Columns: id, nick, network_slug, expires_at, identified,
  inserted_at.
  """
  @spec list_visitors_text!() :: :ok
  def list_visitors_text! do
    IO.puts(Enum.join(visitor_columns(), "\t"))

    Enum.each(Visitors.list_active(), fn %Visitor{} = v ->
      identified = if is_nil(v.expires_at), do: "true", else: "false"

      row = [
        v.id,
        v.nick,
        v.network_slug,
        format_datetime(v.expires_at),
        identified,
        format_datetime(v.inserted_at)
      ]

      IO.puts(Enum.join(row, "\t"))
    end)

    :ok
  end

  @doc """
  Print every bound `(user, network)` credential as a tab-separated
  table: header + one row per binding regardless of `connection_state`.
  Columns: user_id, network_slug, nick, state, connection_state_reason.

  Operator triage of a stuck network needs ALL credential states
  (`:connected`, `:parked`, `:failed`) — not just `:connected`. Uses
  `Credentials.list_all_credentials/0`, which drops the
  `:connected`-only filter that `list_credentials_for_all_users/0`
  applies for Bootstrap's spawn loop.
  """
  @spec list_credentials_text!() :: :ok
  def list_credentials_text! do
    IO.puts(Enum.join(credential_columns(), "\t"))

    Enum.each(Credentials.list_all_credentials(), fn cred ->
      row = [
        cred.user_id,
        cred.network.slug,
        cred.nick,
        Atom.to_string(cred.connection_state),
        cred.connection_state_reason || ""
      ]

      IO.puts(Enum.join(row, "\t"))
    end)

    :ok
  end

  @doc """
  Print every live `Session.Server` registered in `Grappa.SessionRegistry`
  as a tab-separated table: header + one row per process. Columns:
  subject_kind, subject_id, network_id, pid, alive, mailbox_len,
  memory_kb. The introspection columns surface mailbox bloat / leaks —
  the #1 thing operators chase on a stuck session.

  Pre-M-4 this verb owned the `Registry.select` + `Process.info`
  projection inline; the M-4 admin console needed the same data as
  JSON, so the projection moved into `Grappa.LiveIntrospection`. The
  text formatter is the second door — one feature, one code path
  (CLAUDE.md "every door").
  """
  @spec list_sessions_text!() :: :ok
  def list_sessions_text! do
    IO.puts(Enum.join(session_columns(), "\t"))

    Enum.each(LiveIntrospection.list_sessions(), fn %SessionEntry{} = entry ->
      {subject_kind, subject_id} = entry.subject

      row = [
        Atom.to_string(subject_kind),
        subject_id,
        Integer.to_string(entry.network_id),
        inspect(entry.pid),
        to_string(entry.alive),
        Integer.to_string(entry.mailbox_len),
        Integer.to_string(div(entry.memory_bytes, 1024))
      ]

      IO.puts(Enum.join(row, "\t"))
    end)

    :ok
  end

  ## Column headers

  defp visitor_columns,
    do: ["id", "nick", "network_slug", "expires_at", "identified", "inserted_at"]

  defp credential_columns,
    do: ["user_id", "network_slug", "nick", "state", "connection_state_reason"]

  defp session_columns,
    do: ["subject_kind", "subject_id", "network_id", "pid", "alive", "mailbox_len", "memory_kb"]

  defp format_datetime(nil), do: ""
  defp format_datetime(%DateTime{} = dt), do: DateTime.to_iso8601(dt)

  ## M-11 admin-event helpers --------------------------------------------

  @spec unpack_actor(actor()) :: {String.t() | nil, String.t() | nil}
  defp unpack_actor(nil), do: {nil, nil}
  defp unpack_actor({id, name}) when is_binary(id) and is_binary(name), do: {id, name}

  @spec emit_session_disconnected(:user | :visitor, String.t(), integer(), actor()) :: :ok
  defp emit_session_disconnected(subject_kind, subject_id, network_id, actor) do
    {actor_id, actor_name} = unpack_actor(actor)
    slug = lookup_network_slug(network_id)

    AdminEvents.record(
      AdminWire.session_disconnected(
        subject_kind,
        subject_id,
        network_id,
        slug,
        actor_id,
        actor_name
      )
    )
  end

  @spec emit_session_terminated(:user | :visitor, String.t(), integer(), actor()) :: :ok
  defp emit_session_terminated(subject_kind, subject_id, network_id, actor) do
    {actor_id, actor_name} = unpack_actor(actor)
    slug = lookup_network_slug(network_id)

    AdminEvents.record(
      AdminWire.session_terminated(
        subject_kind,
        subject_id,
        network_id,
        slug,
        actor_id,
        actor_name
      )
    )
  end

  @spec lookup_network_slug(integer()) :: String.t() | nil
  defp lookup_network_slug(network_id) do
    case Networks.get_network(network_id) do
      nil -> nil
      net -> net.slug
    end
  end
end
