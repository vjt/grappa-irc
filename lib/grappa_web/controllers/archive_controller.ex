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
  explicitly. Returns 204 + broadcasts `:archive_purged` on
  `Topic.user(subject_label)` so connected cic tabs refresh the
  archive list AND invalidate the in-memory scrollback cache for the
  deleted target (UX-7-B 2026-05-22 — pre-fix the broadcast was
  `archive_changed` without `target`, so cic's `scrollbackByChannel`
  retained the deleted rows in the live Solid store and ghost rows
  re-appeared on re-JOIN).

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

  Returns 204 with no body. Broadcasts `archive_purged` on
  `Topic.user(subject_label)` after a successful delete so any
  connected cic tab listening on the user-topic refreshes its
  archive section AND invalidates the in-memory scrollback cache for
  the deleted target. See `Wire.archive_purged_payload/2` for the
  envelope shape rationale (separate kind from `archive_changed` —
  the PART arm uses the lighter envelope without scrollback purge).

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
      # REV-B / H17 (2026-05-22 codebase review): canonicalise the
      # target at the controller boundary BEFORE sigil dispatch so the
      # delete path observes the same normalisation as the write path
      # (`Grappa.Scrollback.Message.canonicalize_channel/1`). The
      # `Identifier.canonical_channel/1` helper is sigil-aware — it
      # lowercases channel-shaped names and passes nick-shaped names
      # through verbatim, so it is also safe for the `:query` branch
      # (DMs are nick-shaped and case-meaningful per the `dm_with`
      # column rule at `lib/grappa/scrollback/message.ex:252-254`,
      # which `canonical_channel/1` correctly preserves). Mirrors the
      # write-side single-sourcing pattern; the only consumer of
      # `delete_for_channel/3` is this controller so the upstream
      # canonicalisation is sufficient.
      canonical_target = Grappa.IRC.Identifier.canonical_channel(target)

      # M17 (REV-D 2026-05-22): pre-fix this was a strict-bind
      # `{:ok, _} =` against the Scrollback delete result. Even though
      # both `delete_for_channel/3` + `delete_for_dm/3` spec a
      # `{:ok, _}`-only return today, a future shape extension would
      # surface as `MatchError` → 500 bypassing FallbackController.
      # Routing through `with` keeps the controller resilient to
      # `{:error, _}` evolutions without a behavioural change for the
      # current happy path.
      with {:ok, _} <- delete_for_target(canonical_target, session_subject, network.id) do
        _ = broadcast_archive_purged(subject, network.slug, canonical_target)
        send_resp(conn, :no_content, "")
      end
    end
  end

  def delete(_, _), do: {:error, :bad_request}

  @spec delete_for_target(String.t(), Grappa.Subject.t(), pos_integer()) ::
          {:ok, non_neg_integer()}
  defp delete_for_target(canonical_target, session_subject, network_id) do
    case Scrollback.target_kind(canonical_target) do
      :channel ->
        Scrollback.delete_for_channel(session_subject, network_id, canonical_target)

      :query ->
        Scrollback.delete_for_dm(session_subject, network_id, canonical_target)
    end
  end

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
  #
  # UX-7-B (2026-05-22): event kind flipped from `archive_changed` to
  # `archive_purged` + `target` added. cic's userTopic dispatcher routes
  # the new kind through `purgeScrollback(channelKey(slug, target))`
  # BEFORE refreshing the archive list — without the invalidation the
  # pre-delete rows linger in the live Solid store and re-appear on
  # re-JOIN (refreshScrollback fetches `?after=cursor`, which is past
  # every deleted row).
  @spec broadcast_archive_purged(
          {:user, User.t()} | {:visitor, Visitor.t()},
          String.t(),
          String.t()
        ) :: :ok | {:error, term()}
  defp broadcast_archive_purged({:user, %User{name: name}}, network_slug, target) do
    PubSub.broadcast_event(
      Topic.user(name),
      Wire.archive_purged_payload(network_slug, target)
    )
  end

  defp broadcast_archive_purged({:visitor, %Visitor{id: visitor_id}}, network_slug, target) do
    PubSub.broadcast_event(
      Topic.user("visitor:" <> visitor_id),
      Wire.archive_purged_payload(network_slug, target)
    )
  end
end
