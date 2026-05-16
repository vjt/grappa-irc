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
      Grappa.LiveIntrospection,
      Grappa.Networks,
      Grappa.Session,
      Grappa.Visitors,
      Grappa.Visitors.Reaper
    ]

  alias Grappa.Admission.NetworkCircuit
  alias Grappa.{LiveIntrospection, Networks, Session, Visitors}
  alias Grappa.LiveIntrospection.SessionEntry
  alias Grappa.Networks.Credentials
  alias Grappa.Visitors.Visitor

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
    case delete_visitor(id) do
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
  """
  @spec delete_visitor(Ecto.UUID.t()) :: :ok | {:error, :not_found}
  def delete_visitor(id) when is_binary(id) do
    case Visitors.get(id) do
      nil ->
        {:error, :not_found}

      visitor ->
        :ok = stop_visitor_session(visitor)
        :ok = log_delete_outcome(id, visitor, Visitors.delete(id))
        :ok
    end
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
  def reap_visitors do
    Grappa.Visitors.Reaper.sweep()
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
  def reset_circuit(network_id) when is_integer(network_id) do
    case Networks.get_network(network_id) do
      nil ->
        {:error, :not_found}

      _ ->
        :ok = NetworkCircuit.reset(network_id)
        # Drain the cast through the NetworkCircuit mailbox so the
        # post-reset ETS snapshot reflects the operator verb.
        _ = :sys.get_state(NetworkCircuit)

        post = Enum.find(NetworkCircuit.entries(), &match?({^network_id, _, _, _, _}, &1))
        {:ok, post}
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
end
