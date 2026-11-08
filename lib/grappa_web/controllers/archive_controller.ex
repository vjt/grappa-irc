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

  The listing is METERED — one token per call from a per-`(subject,
  network)` bucket of its own (#1404), because it is an aggregate over
  the partition rather than a paged read and the coarse request budget
  meters writes by design. An empty bucket answers 429 `rate_limited`
  with a `retry-after` and runs no query. The DELETE is a write and is
  already covered by the coarse budget, so it takes no archive token.

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
  alias Grappa.RateLimit.TokenBucket
  alias Grappa.Scrollback.Wire
  alias Grappa.Visitors.Visitor
  alias GrappaWeb.Subject

  # #1404 — the archive listing is the one authenticated READ that is a
  # per-network aggregate rather than a paged fetch: it answers from the
  # whole `(subject, network)` partition, so its cost tracks the partition
  # and not a `limit` param. The coarse `:request_budget` plug deliberately
  # lets reads through (paging and snapshots are legitimate high-volume
  # traffic), and its moduledoc says where a read of unusual cost belongs
  # instead — a bound of its own, at the door that knows the cost. This is
  # that bound: one token per listing from a per-`(subject, network)`
  # bucket, the same shared limiter the send door uses (#340), a distinct
  # bucket atom so a listing can never spend a send token.
  #
  # The numbers are set by the CLIENT's own shape, not by taste: cic
  # refetches this list on every `archive_changed` (one per PART) in every
  # open tab, so a hand-driven burst of parts across a few tabs must pass
  # untouched. Capacity covers that burst; the refill is the sustained
  # ceiling. Boot-time config per CLAUDE.md (`Application.get_env` at
  # runtime is banned).
  @archive_read_bucket :archive_read
  @archive_read_capacity Application.compile_env(:grappa, [:archive_read, :capacity], 20)
  @archive_read_refill_per_sec Application.compile_env(
                                 :grappa,
                                 [:archive_read, :refill_per_sec],
                                 0.2
                               )

  # Seconds until one token refills — the client-facing hint on the 429,
  # derived from THIS bucket's refill so cic paces against the bucket that
  # actually refused it. One knob pair, not two that drift. `ceil` so the
  # client never under-waits and re-trips instantly; `max(1, _)` guards a
  # sub-second config from flooring to 0. HTTP Retry-After is integer
  # seconds (RFC 7231 §7.1.3).
  @archive_read_retry_after_seconds max(1, ceil(1.0 / @archive_read_refill_per_sec))

  @doc """
  `GET /networks/:network_id/archive` — returns the archived target
  list as `%{"archive" => [...]}` sorted by `last_activity` DESC.

  Wire shape per entry: `%{target, kind, last_activity}` — `row_count`
  was removed by #1626 (protocol v8); see `Grappa.Protocol`.
  where `kind` is the wire string `"channel" | "query"`.

  Metered: one token per call from the per-`(subject, network)`
  `#{@archive_read_bucket}` bucket. An empty bucket answers 429
  `rate_limited` with a `retry-after` hint and runs no query.
  """
  @spec index(Plug.Conn.t(), map()) ::
          Plug.Conn.t() | {:error, {:rate_limited, pos_integer()} | :timeout}
  def index(conn, _) do
    subject = conn.assigns.current_subject
    network = conn.assigns.network
    session_subject = Subject.to_session(subject)

    with :ok <- take_archive_token(session_subject, network.id),
         {:ok, active_keyset} <- build_active_keyset(subject, session_subject, network.id) do
      entries = Scrollback.list_archive(session_subject, network.id, active_keyset)
      render(conn, :index, archive: entries)
    end
  end

  # The token is taken BEFORE the keyset is built, so a refused listing
  # costs no query at all — a bound that still pays for the work it
  # refuses is not a bound.
  @spec take_archive_token(Session.subject(), integer()) ::
          :ok | {:error, {:rate_limited, pos_integer()}}
  defp take_archive_token(session_subject, network_id) do
    case TokenBucket.take(
           @archive_read_bucket,
           {session_subject, network_id},
           @archive_read_capacity,
           @archive_read_refill_per_sec
         ) do
      :ok -> :ok
      {:error, :rate_limited} -> {:error, {:rate_limited, @archive_read_retry_after_seconds}}
    end
  end

  @doc """
  `DELETE /networks/:network_id/archive/:target` — drops scrollback for
  one window. Dispatch by `Scrollback.window_kind/1`:

    * channel-shaped target (`#`, `&`, `!`, `+` prefix) →
      `Scrollback.delete_for_channel/3` (pure channel = ^name filter).
    * `$server` → the same `delete_for_channel/3`. The pseudo-channel
      carries no sigil, so `target_kind/1` calls it `:query`; the carve-out
      is `window_kind/1`'s, and it is the reason this door is reachable for
      the NETWORK TAB at all (issue 2428 — an oper's server-notice window
      grows without bound and this is the one surface that can empty it).
    * query-shaped target (peer nick) → `Scrollback.delete_for_dm/3`
      (`dm_with = ^peer` case-insensitive, symmetric across inbound
      + outbound rows).

  ACTIVE windows are deletable. The active keyset (`build_active_keyset/3`)
  bounds what the LISTING offers; it is deliberately not a precondition
  here, because `/clear` acts on the window the operator is sitting in —
  a joined channel or an open query — which by construction is exactly what
  the listing hides.

  Returns 204 with no body. Broadcasts `archive_purged` on
  `Topic.user(subject_label)` after a successful delete so any
  connected cic tab listening on the user-topic refreshes its
  archive section AND invalidates the in-memory scrollback cache for
  the deleted target. See `Wire.archive_purged_payload/2` for the
  envelope shape rationale (separate kind from `archive_changed` —
  the PART arm uses the lighter envelope without scrollback purge).

  Validation is at-the-boundary per CLAUDE.md: invalid target name
  (not channel-shaped, not nick-shaped, not `$server`) → 400.
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
      # (`Grappa.Scrollback.Message.canonicalize_channel/1`). #537 INC-2.3 —
      # `canonical_target/2` folds network-aware to the live session's
      # CASEMAPPING (`:ascii` when no pid → byte-identical to the pure-ASCII
      # fold, so prod is unchanged), the stateless controller's twin of the
      # Server's write-time `fold_key/2`: an rfc1459 `#Foo[1]` deletes the one
      # window keyed `#foo{1}`. Shape-BLIND since #537: `canonical_target/2`
      # folds `A-Z` the same way for a channel and for a nick-shaped DM
      # target, and `delete_for_dm/3` re-folds the peer through the shared
      # ASCII `where_dm_peer/2` so the delete lands on the same window the
      # read path resolves.
      canonical_target =
        Grappa.IRC.Identifier.canonical_target(target, Session.casemapping(session_subject, network.id))

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
          {:ok, non_neg_integer()} | {:error, :db_unavailable}
  defp delete_for_target(canonical_target, session_subject, network_id) do
    case Scrollback.window_kind(canonical_target) do
      kind when kind in [:channel, :server] ->
        Scrollback.delete_for_channel(session_subject, network_id, canonical_target)

      :query ->
        Scrollback.delete_for_dm(session_subject, network_id, canonical_target)
    end
  end

  @doc """
  `GET /networks/:network_id/archive/:target/count` — how many rows the
  DELETE above would drop for that window, as `%{count: n}`.

  The confirm modal names the number before the operator commits (issue
  2428), the same way the admin network delete names its row count (issue
  2320, `GET /admin/networks/:id/message_count`). Asked once, when the
  confirm opens — never on a render, and never on the archive listing,
  whose whole cost argument (#1626) is that it does not count rows.

  NOT metered with the archive read token. That bucket bounds the listing
  because the listing is an aggregate over the partition; this is an
  indexed `COUNT` for ONE window, the same cost class as the gap probe
  (`GET …/messages/count`), which is unmetered for the same reason.

  A target with no rows answers `{"count": 0}` rather than a 404: an empty
  window is a legitimate answer to "how many", and the caller decides what
  to do with a zero (cic refuses to open the confirm at all).
  """
  @spec count(Plug.Conn.t(), map()) :: Plug.Conn.t() | {:error, :bad_request}
  def count(conn, %{"target" => target}) when is_binary(target) do
    session_subject = Subject.to_session(conn.assigns.current_subject)
    network = conn.assigns.network

    with :ok <- validate_target_name(target) do
      canonical_target =
        Grappa.IRC.Identifier.canonical_target(
          target,
          Session.casemapping(session_subject, network.id)
        )

      count = Scrollback.count_for_target(session_subject, network.id, canonical_target)
      render(conn, :count, count: count)
    end
  end

  def count(_, _), do: {:error, :bad_request}

  # Active keyset = currently-joined channels (live Session state) +
  # currently-open query windows (persisted, subject-scoped per V1's
  # XOR FK shape — both users and visitors get a row).
  #
  # NO LIVE SESSION MEANS AN EMPTY KEYSET, QUERY WINDOWS INCLUDED (issue
  # 1985). This module's own doc has always promised it — *"an absent session
  # simply means an empty `active_keyset`, which is the correct semantic
  # (everything with rows qualifies for the archive when no session is
  # live)"* — but only the channel arm delivered it: `Session.list_channels/2`
  # goes quiet on `:no_session` while `open_query_targets/2` is a DB read that
  # answers the same whether a session exists or not. So a parked network's
  # DMs were withheld from the archive by this function.
  #
  # Harmless while cic drew a greyed row for a parked network. Not harmless
  # since issue 1985 dropped parked networks from the sidebar: the DM then
  # had no sidebar row AND no archive row — one window, ZERO surfaces — and
  # no client-side filter can restore an entry the server never sent. The
  # asymmetry was the bug; the channel arm was right.
  #
  # Written as ONE `case` over the session lookup — both sources answered by
  # the same arm — rather than a channels-only fallback plus a separate query
  # read, so the two cannot drift apart again: there is exactly one place here
  # that says what an absent session means.
  #
  # A SESSION THAT DOES NOT ANSWER IS NOT AN EMPTY KEYSET (issue 2239). The
  # arm below used to be absent, so `{:error, :timeout}` — a real return of
  # `Session.list_channels/2`, which its `@spec` denied until 2239 — raised a
  # `CaseClauseError` and 500'd the page.
  #
  # It degrades to `{:error, :timeout}` rather than to `[]`, and the two are
  # opposite claims HERE more than anywhere else on the surface: an empty
  # keyset asserts "nothing is active", so `list_archive/3` returns everything
  # with rows and the page shows the user the conversations they are sitting in
  # RIGHT NOW as archived. `[]` does not blur this page, it inverts it. The
  # error travels to `GrappaWeb.FallbackController`'s existing `{:error,
  # :timeout}` clause — 504 + `retry-after: 10` + `session_timeout`, a token
  # cic already renders — so nothing new was invented for it.
  #
  # Note this is NOT the same answer the sibling doors take: `GET /boot`
  # degrades per network row rather than failing the envelope. The difference
  # is that this page is on no boot path and has one network in scope.
  #
  # The `case` still yields the TARGET LIST and the MapSet is still built once,
  # after it. That is a dialyzer constraint, not a style choice, and reverting
  # it to a `MapSet.new(...)` per arm reopens two errors — measured, both
  # directions: `MapSet.t/1` is OPAQUE, and a MapSet built from a
  # statically-empty list collapses to the concrete `%MapSet{map: %{}}` in the
  # success typing (it is the empty LITERAL, not the arity — `MapSet.new()` and
  # `MapSet.new([])` are red alike). Joined with the other arm the return is
  # then no longer purely opaque, so the `@spec` below reads as
  # `contract_with_opaque`, and handing the value to `Scrollback.list_archive/3`
  # — which specs the opaque type — reads as `call_without_opaque`. One
  # construction site from a list dialyzer cannot fold to a constant keeps the
  # opacity intact, which is why the error arm short-circuits the `with` below
  # instead of adding a second `MapSet.new/1`.
  @spec build_active_keyset(
          {:user, User.t()} | {:visitor, Visitor.t()},
          Grappa.Scrollback.subject(),
          integer()
        ) :: {:ok, MapSet.t(String.t())} | {:error, :timeout}
  defp build_active_keyset(subject, session_subject, network_id) do
    active_targets =
      case Session.list_channels(session_subject, network_id) do
        {:ok, channels} -> {:ok, channels ++ open_query_targets(subject, network_id)}
        {:error, :no_session} -> {:ok, []}
        {:error, :timeout} -> {:error, :timeout}
      end

    with {:ok, targets} <- active_targets, do: {:ok, MapSet.new(targets)}
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

  # The user-rooted topic label comes from `Subject.topic_label/1` — the
  # single source of the "user → `user.name`, visitor → `"visitor:" <>
  # id`" invariant (bucket I web/S7), which MUST match the `:user_name`
  # `UserSocket` assigns so visitor cic instances subscribed to their
  # user-rooted topic see the broadcast (V4 visitor-parity).
  #
  # UX-7-B (2026-05-22): event kind flipped from `archive_changed` to
  # `archive_purged` + `target` added. cic's userTopic dispatcher routes
  # the new kind through `purgeScrollback(channelKey(slug, target))`
  # BEFORE refreshing the archive list — without the invalidation the
  # pre-delete rows linger in the live Solid store and re-appear on
  # re-JOIN (refreshScrollback fetches `?after=cursor`, which is past
  # every deleted row).
  @spec broadcast_archive_purged(Subject.t(), String.t(), String.t()) :: :ok | {:error, term()}
  defp broadcast_archive_purged(subject, network_slug, target) do
    label = Subject.topic_label(subject)

    PubSub.broadcast_event(
      Topic.user(label),
      Wire.archive_purged_payload(network_slug, target)
    )
  end
end
