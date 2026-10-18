if Mix.env() in [:dev, :test] do
  defmodule Grappa.TestSupport.E2eInboxExpiry do
    @moduledoc """
    Test-only: makes a subject's offline queue of encrypted messages
    (`Grappa.E2eInbox`) expire NOW, through the production sweep (issue
    2430).

    The TTL is seven days and the session sweeps hourly, so an e2e spec
    cannot wait for either. This ages every queued entry past the TTL —
    the one column the sweep reads — and then delivers the session's own
    `:e2e_inbox_sweep` tick, so what runs is the production path: the same
    expiry, the same recipient-only notice, the same persist and broadcast.
    Nothing in production code knows this module exists.

    Compile-gated to `:dev` and `:test` Mix envs — the module literally
    does not exist in the prod release.
    """

    use Boundary,
      top_level?: true,
      deps: [Grappa.E2eInbox, Grappa.Repo, Grappa.Session, Grappa.Subject]

    import Ecto.Query

    alias Grappa.{E2eInbox, Repo, Session, Subject}
    alias Grappa.E2eInbox.Entry

    @doc """
    Ages `subject`'s queue on `network_id` past the TTL and runs the live
    session's sweep, returning once the session has handled it.
    `{:error, :no_session}` when no session runs for the pair: the sweep is
    the session's, so there is nothing to tick.
    """
    @spec expire_now(Subject.t(), integer()) :: :ok | {:error, :no_session}
    def expire_now(subject, network_id) when is_integer(network_id) do
      case Session.whereis(subject, network_id) do
        nil ->
          {:error, :no_session}

        pid ->
          aged = DateTime.truncate(DateTime.add(DateTime.utc_now(), -(E2eInbox.ttl_seconds() + 60), :second), :second)

          {_, _} =
            Entry
            |> Subject.subject_where(subject)
            |> where([e], e.network_id == ^network_id)
            |> Repo.update_all(set: [inserted_at: aged])

          send(pid, :e2e_inbox_sweep)
          # The state read is queued behind the tick: once it answers, the
          # sweep has run and its rows are persisted.
          _ = :sys.get_state(pid)
          :ok
      end
    end
  end
end
