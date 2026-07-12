defmodule GrappaWeb.MeController do
  @moduledoc """
  `GET /me` — returns the authenticated subject's public profile as a
  discriminated union mirroring `GrappaWeb.AuthJSON.subject_wire`:

    * user    → `{kind: "user", id, name, inserted_at, home_data}`
    * visitor → `{kind: "visitor", id, expires_at, registered, home_data}`
      (`registered` = DERIVED from the credentials — ≥1 holding a NickServ
      secret). #211 phase 7 — `nick`/`ident`/`realname` are DROPPED from
      the subject (a visitor is multi-network; per-network identity lives
      on the `GET /networks` rows); `network_slug` + the singular
      `connected` scalar went in phase 6. `home_data` is populated for
      visitors too (ruling A).

  Lives behind `:authn`; missing / invalid / revoked / expired Bearer
  all collapse to a uniform 401 via `GrappaWeb.Plugs.Authn`.

  Reads `:current_subject` (assigned by `Plugs.Authn` for both kinds)
  and dispatches to the matching `MeJSON.show/1` clause. The plug
  performs the subject load once per request so this controller does
  no DB work (S42). M-web-1: the loaded struct lives inside the
  `:current_subject` tagged tuple — no parallel `:current_user` /
  `:current_visitor` assigns to drift.
  """
  use GrappaWeb, :controller

  alias Grappa.{AccountDeletion, Networks, ReadCursor, Scrollback}
  alias Grappa.Networks.Credentials
  alias Grappa.Push.BadgeCount
  alias GrappaWeb.UserSocket

  @doc """
  `GET /me` — discriminated profile for the bearer's subject + the
  per-(network, channel) read cursor envelope (CP29 R-3) + the
  per-(network, channel) unread-count envelope (bucket C, 2026-06-01)
  + the `home_data` envelope (UX-4 bucket B).

  W8: defensive fall-through clause guards against a regressed pipeline
  (`/me` mounted outside `:authn`, or a future subject kind added without
  updating this controller). With the fall-through the failure mode is a
  uniform 401 via `FallbackController`, not a `KeyError` 500.

  ## Read cursor envelope

  The response carries `read_cursors: %{network_slug => %{channel =>
  id}}` (nested by network) so cic doesn't need a
  per-window REST round-trip on login. Built from
  `Grappa.ReadCursor.bulk_for_subject/1` — single query bounded by
  ~600 rows in the worst case.

  Empty `%{}` for a fresh subject with no cursors yet — cic treats
  missing keys as "no cursor for this window" and falls back to
  unread-everything semantics until the first POST advances one.

  ## Unread-counts envelope (bucket C, 2026-06-01)

  The response carries `unread_counts: %{network_slug => %{channel =>
  %{messages: int, events: int}}}` — the per-channel
  `Scrollback.count_after_split/5` for every cursor in `read_cursors`,
  with the same nested shape. cic's `applySeedEnvelope` consumes the
  `selection.ts` `serverSeedCounts` signal so cold-load sidebar badges
  render the right counts for channels the user has a cursor on but
  hasn't focused yet in this session. Channels without a cursor are
  absent — cic falls back to the per-channel join reply seed (bucket
  B1) for those.

  Built inline here (not in `Scrollback`) so the slug→id resolution
  stays controller-side and `Scrollback` doesn't grow a dependency
  edge onto `Networks` (that would close a `Networks → Scrollback →
  Networks` cycle). Inclusion is keyed on the GLOBAL
  `Networks.network_id_by_slug_index/0` (every existing network row) —
  NOT the credential-scoped window map — so a network the user unbound
  but whose scrollback + cursors it retained (GH #105) still seeds, same
  as the WS `join_reply` door. Per-cursor `count_after_split/5` is a
  single SQL round-trip — bounded by the same ~600 worst-case cursor
  count `bulk_for_subject/1` carries.

  `own_nick` is threaded per-network from the CONFIGURED credential nick
  — the same off-Session resolver `Push.BadgeCount` uses
  (`configured_nick_windows/1`), `nil` when the subject holds no
  credential on that slug (the unbound-but-retained case). It narrows
  the own-nick query window (`channel == own_nick`) to self-msgs so
  inbound DMs don't over-count it; without it the seed disagreed with
  the per-channel WS `join_reply` (which threads the live session nick)
  by every inbound DM ever received (S2, 2026-07-08 review — the
  CP14-B3 leak re-opened by `count_after_split/5`'s former
  `own_nick \\ nil` default). Resolving from the configured nick keeps
  the /me path off of `Grappa.Session` (a `GenServer.call` per network
  at cold-load is unacceptable — DESIGN_NOTES 2026-06-21); accepted
  staleness after a `/nick` until reconnect rewrites the credential.

  ## badge_count (PWA icon badge door #2, 2026-06-21)

  Top-level `badge_count` — `Grappa.Push.BadgeCount.count/1` for the
  subject: the notify-worthy unread total (same predicate as Web Push),
  capped at 99. Like `unread_counts` it is computed at boot and stays
  OFF `Grappa.Session` (BadgeCount resolves own_nick from the configured
  credential nick, not the live session nick), so `/me` remains a
  Session-free path. cic seeds its icon-badge / `document.title` from it.

  ## home_data envelope (UX-4 bucket B)

  The response carries `home_data: %{networks: [...],
  available_networks: [...]}` for BOTH subjects (#211 phase 6, ruling A —
  the user + visitor home pages are the SAME data-driven component). It
  lists every credential's `(slug, nick, connection_state, ...)` so cic's
  HomePane renders the networks pane without a second REST round-trip;
  the per-row live nick is resolved via `Networks.resolve_network_nick/2`
  (same lookup `GET /networks` uses). `available_networks` is the visitor
  on-demand-connect tier (`visitor_enabled − attached`; empty for users).
  Built via `Networks.home_data_for_{user,visitor}/1`.

  Live updates land via the `connection_state_changed` typed event
  on `Topic.user/1` (REV-J M15 folded the prior
  `home_network_state_changed` arm into this payload's `:network`
  field, eliminating the temporal window where two separate events
  carried half-views of the same transition).
  """
  @spec show(Plug.Conn.t(), map()) :: Plug.Conn.t() | {:error, :unauthorized}
  def show(conn, _) do
    case conn.assigns[:current_subject] do
      {:user, user} ->
        subject = {:user, user.id}
        cursors = ReadCursor.bulk_for_subject(subject)
        unread_counts = build_unread_counts(subject, cursors)
        home_data = Networks.home_data_for_user(user)

        render(conn, :show,
          user: user,
          read_cursors: cursors,
          unread_counts: unread_counts,
          badge_count: BadgeCount.count(subject),
          home_data: home_data
        )

      {:visitor, visitor} ->
        subject = {:visitor, visitor.id}
        cursors = ReadCursor.bulk_for_subject(subject)
        unread_counts = build_unread_counts(subject, cursors)
        home_data = Networks.home_data_for_visitor(visitor.id)

        render(conn, :show,
          visitor: visitor,
          # #211 phase 7 — registration is DERIVED from the credentials.
          registered: Credentials.visitor_registered?(visitor.id),
          read_cursors: cursors,
          unread_counts: unread_counts,
          badge_count: BadgeCount.count(subject),
          home_data: home_data
        )

      _ ->
        {:error, :unauthorized}
    end
  end

  @doc """
  `DELETE /me` — #157 self-service account deletion. Tears down the
  caller's live session(s), wipes the account + ALL state (DB cascade),
  and closes the live WebSocket. Returns 204 on a completed wipe.

  Subject-routed in `Grappa.AccountDeletion`: an admin user or an anon
  visitor is NOT offered self-delete (`{:error, :forbidden}` → 403 via
  FallbackController). There is no cross-subject delete — the SELF is
  `conn.assigns.current_subject`, with no `:id` param to spoof.

  Distinct from `DELETE /auth/logout` (#126 detach, which PRESERVES a
  persistent identity): this is the ONLY door that destroys it. After the
  cascade the auth-session row is already gone; the remaining teardown is
  the socket close (mid-flight WS enforcement, same rationale as logout's
  H2 — reused via `UserSocket.disconnect_subject/1`).

  The fall-through clause guards a regressed pipeline (`/me` mounted
  outside `:authn`) with a uniform 401, mirroring `show/2`'s W8 clause.
  """
  @spec delete(Plug.Conn.t(), map()) ::
          Plug.Conn.t() | {:error, :forbidden | :not_found | :unauthorized}
  def delete(conn, _) do
    case conn.assigns[:current_subject] do
      {:user, _} = subject -> wipe(conn, subject)
      {:visitor, _} = subject -> wipe(conn, subject)
      _ -> {:error, :unauthorized}
    end
  end

  @spec wipe(Plug.Conn.t(), GrappaWeb.Subject.t()) ::
          Plug.Conn.t() | {:error, :forbidden | :not_found}
  defp wipe(conn, subject) do
    with :ok <- AccountDeletion.delete_account(subject) do
      :ok = UserSocket.disconnect_subject(subject)
      send_resp(conn, :no_content, "")
    end
  end

  # Walks the cursor envelope and resolves each (slug, channel, cursor)
  # to a `count_after_split/5` per-channel pair. Returns the nested
  # `%{slug => %{channel => %{messages, events}}}` shape that mirrors
  # the cursor envelope; missing slugs (stale cursor referencing a
  # network that's since been deleted) are dropped.
  #
  # Nil-cursor entries are dropped too: `ReadCursor.bulk_for_subject/1`
  # selects `c.last_read_message_id` as-is, and the column is nullable
  # (a cursor row may exist with `nil` id from a legacy POST or an
  # explicit-no-cursor state). The bucket C contract — documented in
  # the `Unread-counts envelope` moduledoc and asserted in
  # `me_controller_test.exs:"channels without a cursor are absent
  # from unread_counts"` — is "channels without a cursor are absent;
  # cic falls back to the per-channel join_reply seed (bucket B1)".
  # A nil cursor IS "no cursor", so skipping matches the contract.
  # Without this guard, `count_after_split/5`'s `is_integer(after_id)`
  # head clause throws FunctionClauseError and the entire /me response
  # 500s — cic then has no `user()` value and the Shell renders the
  # cold "select a channel below" placeholder with no admin console.
  # PROD HOTFIX 2026-06-01: vjt's `#bofh` cursor row had nil id.
  @spec build_unread_counts(
          Grappa.Scrollback.subject(),
          %{String.t() => %{String.t() => integer() | nil}}
        ) :: %{String.t() => %{String.t() => %{messages: non_neg_integer(), events: non_neg_integer()}}}
  defp build_unread_counts(_, cursor_envelope) when map_size(cursor_envelope) == 0,
    do: %{}

  defp build_unread_counts(subject, cursor_envelope) do
    # Inclusion stays keyed on the GLOBAL network index (every existing
    # network row), NOT on the credential-scoped window map: a user can
    # unbind a network yet retain its scrollback + read cursors (GH #105
    # — unbind deletes only the credential row). Those cursors must still
    # seed unread_counts, matching the WS `join_reply` door (which keys on
    # `get_network_by_slug`, credential-independent). Scoping inclusion to
    # credentials would silently drop unbound-but-retained networks from
    # the cold-load seed.
    slug_to_id = Networks.network_id_by_slug_index()

    # own_nick is resolved SEPARATELY from the off-Session configured-nick
    # window map (`Push.BadgeCount.configured_nick_windows/1`); `nil` when
    # the subject holds no credential on that slug (unbound network). nil
    # own_nick falls back to channel-shape narrowing — the same shape the
    # WS door uses when it has no live session, so the two doors stay
    # consistent for the unbound case too.
    own_nicks = BadgeCount.configured_nick_windows(subject)

    for {slug, per_channel} <- cursor_envelope,
        Map.has_key?(slug_to_id, slug),
        reduce: %{} do
      acc ->
        net_id = Map.fetch!(slug_to_id, slug)
        own_nick = own_nick_for_slug(own_nicks, slug)

        channel_counts =
          for {channel, cursor} <- per_channel,
              is_integer(cursor),
              reduce: %{} do
            inner ->
              Map.put(
                inner,
                channel,
                Scrollback.count_after_split(subject, net_id, channel, cursor, own_nick)
              )
          end

        # Skip slugs whose channels all had nil cursors — keeps the
        # envelope shape uniform with the "no cursor at all" case
        # (`refute Map.has_key?`) downstream consumers already test.
        if map_size(channel_counts) == 0 do
          acc
        else
          Map.put(acc, slug, channel_counts)
        end
    end
  end

  # Configured own-nick for `slug`, or `nil` when the subject holds no
  # credential there (unbound-but-retained network). `nil` selects
  # channel-shape narrowing in `Scrollback.count_after_split/5`.
  @spec own_nick_for_slug(%{String.t() => {integer(), String.t()}}, String.t()) ::
          String.t() | nil
  defp own_nick_for_slug(own_nicks, slug) do
    case Map.fetch(own_nicks, slug) do
      {:ok, {_, own_nick}} -> own_nick
      :error -> nil
    end
  end
end
