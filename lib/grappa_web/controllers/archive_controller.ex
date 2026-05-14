defmodule GrappaWeb.ArchiveController do
  @moduledoc """
  Per-network Archive section read surface (CP15 B4).

  `GET /networks/:network_id/archive` returns the targets that have
  scrollback rows on this network for the authenticated subject AND
  are NOT currently active — joined channels (`Session.list_channels/2`)
  + open query window targets (`QueryWindows.list_for_subject/1`) form
  the active keyset; the controller hands it to
  `Scrollback.list_archive/3` which filters those + the `$server`
  pseudo-channel out before grouping.

  Subject-dispatched: visitors share the controller (no separate
  endpoint). Visitor sessions don't get query-window persistence (per
  `Grappa.QueryWindows` moduledoc — visitor credentials are
  ephemeral) so the active keyset for visitors is the
  `Session.list_channels/2` snapshot only. The Scrollback query path
  is identical: `subject_where/2` partitions on `visitor_id` for
  `{:visitor, _}` subjects (per-subject iso mirror of the user path).

  Iso boundary: `Plugs.ResolveNetwork` collapses unknown-slug /
  not-your-network to 404 BEFORE this action runs. `:no_session` is
  not surfaced to the wire — an absent session simply means an empty
  `active_keyset`, which is the correct semantic (everything with rows
  qualifies for the archive when no session is live).
  """
  use GrappaWeb, :controller

  alias Grappa.Accounts.User
  alias Grappa.{QueryWindows, Scrollback, Session}
  alias Grappa.Visitors.Visitor
  alias GrappaWeb.Subject

  @doc """
  `GET /networks/:network_id/archive` — returns the archived target
  list as `%{"archive" => [...]}` sorted by `last_activity` DESC.

  Wire shape per entry: `%{target, kind, last_activity, row_count}`
  where `kind` is the wire string `"channel" | "query"`.
  """
  @spec index(Plug.Conn.t(), map()) :: Plug.Conn.t()
  def index(conn, _) do
    subject = conn.assigns.current_subject
    network = conn.assigns.network
    session_subject = Subject.to_session(subject)

    active_keyset = build_active_keyset(subject, session_subject, network.id)

    entries = Scrollback.list_archive(session_subject, network.id, active_keyset)
    render(conn, :index, archive: entries)
  end

  # Active keyset = currently-joined channels (live Session state) +
  # currently-open query windows (persisted, user-only). Visitors don't
  # get query-window persistence per `Grappa.QueryWindows` moduledoc, so
  # their keyset omits that source — channels-only, which matches the
  # only "live" surface a visitor session has.
  @spec build_active_keyset(
          {:user, User.t()} | {:visitor, Visitor.t()},
          Grappa.Scrollback.subject(),
          integer()
        ) :: MapSet.t(String.t())
  defp build_active_keyset(subject, session_subject, network_id) do
    channels =
      case Session.list_channels(session_subject, network_id) do
        {:ok, list} -> list
        {:error, :no_session} -> []
      end

    queries = open_query_targets(subject, network_id)

    MapSet.new(channels ++ queries)
  end

  @spec open_query_targets({:user, User.t()} | {:visitor, Visitor.t()}, integer()) ::
          [String.t()]
  defp open_query_targets({:user, %User{id: user_id}}, network_id) do
    {:user, user_id}
    |> QueryWindows.list_for_subject()
    |> Map.get(network_id, [])
    |> Enum.map(& &1.target_nick)
  end

  defp open_query_targets({:visitor, _}, _), do: []
end
