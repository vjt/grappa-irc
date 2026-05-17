defmodule GrappaWeb.ArchiveController do
  @moduledoc """
  Per-network Archive section read/write surface (CP15 B4 + UX-1).

  `GET /networks/:network_id/archive` returns the targets that have
  scrollback rows on this network for the authenticated subject AND
  are NOT currently active — joined channels (`Session.list_channels/2`)
  + open query window targets (`QueryWindows.list_for_subject/1`) form
  the active keyset; the controller hands it to
  `Scrollback.list_archive/3` which filters those + the `$server`
  pseudo-channel out before grouping.

  `DELETE /networks/:network_id/archive/:target` drops the scrollback
  rows for the given target — channel-shaped or query-shaped — for the
  authenticated subject + network. Sigil dispatch
  (`Scrollback.target_kind/1`): `:channel` → `delete_for_channel/3`;
  `:query` → `delete_for_dm/3`. Removes local history only: for
  channel-kind targets the IRC server retains state and the channel
  remains rejoinable from the operator's POV — the bouncer just
  forgets the scrollback. Confirm-modal copy in cic states this
  explicitly. Returns 204 + broadcasts `:archive_changed` on
  `Topic.user(subject_label)` so connected cic tabs refresh.

  Subject-dispatched: visitors share the controller (no separate
  endpoint). Both users and visitors persist DM windows under the
  XOR FK shape (V1 cluster), so the active keyset is symmetrical:
  `Session.list_channels/2` snapshot ∪ `QueryWindows.list_for_subject/1`
  for the network. The Scrollback query path is identical:
  `subject_where/2` partitions on `visitor_id` for `{:visitor, _}`
  subjects (per-subject iso mirror of the user path).

  Iso boundary: `Plugs.ResolveNetwork` collapses unknown-slug /
  not-your-network to 404 BEFORE this action runs. `:no_session` is
  not surfaced to the wire — an absent session simply means an empty
  `active_keyset`, which is the correct semantic (everything with rows
  qualifies for the archive when no session is live).
  """
  use GrappaWeb, :controller

  import GrappaWeb.Validation, only: [validate_target_name: 1]

  alias Grappa.Accounts.User
  alias Grappa.{PubSub, QueryWindows, Scrollback, Session}
  alias Grappa.PubSub.Topic
  alias Grappa.Scrollback.Wire
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

  @doc """
  `DELETE /networks/:network_id/archive/:target` — drops scrollback for
  one archive entry. Dispatch by sigil:

    * channel-shaped target (`#`, `&`, `!`, `+` prefix) →
      `Scrollback.delete_for_channel/3` (pure channel = ^name filter).
    * query-shaped target (peer nick) → `Scrollback.delete_for_dm/3`
      (`dm_with = ^peer` case-insensitive, symmetric across inbound
      + outbound rows).

  Returns 204 with no body. Broadcasts `archive_changed` on
  `Topic.user(subject_label)` after a successful delete so any
  connected cic tab listening on the user-topic refreshes its
  archive section.

  Validation is at-the-boundary per CLAUDE.md: invalid target name
  (not channel-shaped, not nick-shaped, not `$server`) → 400. Note
  the `$server` pseudo-channel cannot be deleted via this surface
  even when its name passes `validate_target_name/1` — it's filtered
  out of `list_archive/3`'s output, so the operator cannot select
  it from the UI in the first place; a hand-crafted DELETE against
  `$server` collapses to a no-op `delete_for_channel/3` call (the
  pseudo-channel has no rows ever stored at exactly `channel =
  "$server"` modulo system messages, which are scoped per-channel
  via the existing rules — leaving it as a soft no-op rather than a
  separate 404 keeps the path simple).
  """
  @spec delete(Plug.Conn.t(), map()) :: Plug.Conn.t() | {:error, :bad_request}
  def delete(conn, %{"target" => target}) when is_binary(target) do
    subject = conn.assigns.current_subject
    network = conn.assigns.network
    session_subject = Subject.to_session(subject)

    with :ok <- validate_target_name(target) do
      {:ok, _} =
        case Scrollback.target_kind(target) do
          :channel -> Scrollback.delete_for_channel(session_subject, network.id, target)
          :query -> Scrollback.delete_for_dm(session_subject, network.id, target)
        end

      _ = broadcast_archive_changed(subject, network.slug)

      send_resp(conn, :no_content, "")
    end
  end

  def delete(_, _), do: {:error, :bad_request}

  # Active keyset = currently-joined channels (live Session state) +
  # currently-open query windows (persisted, subject-scoped per V1's
  # XOR FK shape — both users and visitors get a row).
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
    list_query_target_nicks({:user, user_id}, network_id)
  end

  defp open_query_targets({:visitor, %Visitor{id: visitor_id}}, network_id) do
    list_query_target_nicks({:visitor, visitor_id}, network_id)
  end

  @spec list_query_target_nicks(Grappa.Subject.t(), integer()) :: [String.t()]
  defp list_query_target_nicks(subject, network_id) do
    subject
    |> QueryWindows.list_for_subject()
    |> Map.get(network_id, [])
    |> Enum.map(& &1.target_nick)
  end

  # Mirrors `ReadCursorController.maybe_broadcast/4`'s subject-label
  # derivation: user subjects use `user.name`; visitors use
  # `"visitor:" <> visitor.id` — same shape `UserSocket` assigns to
  # `:user_name` so visitor cic instances subscribed to their
  # user-rooted topic see the broadcast (V4 visitor-parity).
  @spec broadcast_archive_changed(
          {:user, User.t()} | {:visitor, Visitor.t()},
          String.t()
        ) :: :ok | {:error, term()}
  defp broadcast_archive_changed({:user, %User{name: name}}, network_slug) do
    PubSub.broadcast_event(Topic.user(name), Wire.archive_changed_payload(network_slug))
  end

  defp broadcast_archive_changed({:visitor, %Visitor{id: visitor_id}}, network_slug) do
    PubSub.broadcast_event(
      Topic.user("visitor:" <> visitor_id),
      Wire.archive_changed_payload(network_slug)
    )
  end
end
