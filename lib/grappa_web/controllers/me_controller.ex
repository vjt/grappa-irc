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

  alias Grappa.{AccountDeletion, Networks, ReadCursor, UserSettings, WindowCounts}
  alias Grappa.Networks.Credentials
  alias Grappa.PresenceFilter.Resolver
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

  ## Unread-counts envelope (bucket C, 2026-06-01; #396 bulk 2026-07-25)

  The response carries `unread_counts: %{network_slug => %{channel =>
  %{messages, mentions, events, severity}}}` — one entry per cursor in
  `read_cursors`, nested by network. cic's `applySeedEnvelope` consumes the
  `selection.ts` `serverSeedCounts` signal so cold-load sidebar badges
  render the right counts + severity colour for channels the user has a
  cursor on but hasn't focused yet — with NO client-side count derivation
  (#267: server is authority, client renders). Channels without a cursor
  are absent — cic falls back to the per-channel join-reply seed (bucket
  B1) for those.

  #396 — built via `Grappa.WindowCounts.bulk_snapshot/4` in a CONSTANT
  number of queries (2), NOT 2 per window. The old path issued
  `count_after_split/6` + `unread_content_tail/6` per cursor (~2N ≈ 100
  round trips at a ~50-window logon); #393's single
  `nick_fold(COALESCE(dm_with, channel))` predicate unified channel + DM
  windows into ONE `read_cursors ⋈ messages` join (served by the live prod
  indexes), so the count split and the mention tails are one statement
  each. The `read_cursors ⋈ networks` join keeps the GH #105 inclusion
  (unbound-but-retained networks' cursors seed too, since unbind deletes
  only the credential row) and drops nil-cursor windows + all-nil slugs
  identically (`refute Map.has_key?`).

  own_nick is threaded per-network from the LIVE nick
  (`Push.BadgeCount.live_nick_windows/1`; `nil` on an unbound network →
  `mentions: 0`) for the mention fold. #498 converged this off the former
  CONFIGURED-nick shortcut (which went permanently stale after a `/nick`)
  now that `current_nick/2` is a cheap `Registry` lookup — no per-network
  `GenServer.call` at cold-load (DESIGN_NOTES 2026-07-28). **Behaviour change
  (#396, user-visible):** the single COALESCE predicate no longer applies
  the old own-nick SELF-window narrowing (`channel == own AND dm_with ==
  own`), so a self (own-nick) window now counts rows that narrowing
  missed — legacy `(channel = own, dm_with IS NULL)` rows AND mixed-case
  self rows (the old narrowing compared `dm_with` RAW). Deliberate, and
  scoped to the self window only; every channel + DM-peer window count is
  byte-identical. See DESIGN_NOTES 2026-07-25.

  ## badge_count (PWA icon badge door #2, 2026-06-21)

  Top-level `badge_count` — `Grappa.Push.BadgeCount.count/1` for the
  subject: the notify-worthy unread total (same predicate as Web Push),
  capped at 99. Like `unread_counts` it is computed at boot; #498 —
  BadgeCount resolves own_nick from the LIVE nick via a cheap `Registry`
  lookup (no per-network `GenServer.call`), so the count follows a `/nick`
  immediately. cic seeds its icon-badge / `document.title` from it.

  ## home_data envelope (UX-4 bucket B)

  The response carries `home_data: %{networks: [...],
  available_networks: [...]}` for BOTH subjects (#211 phase 6, ruling A —
  the user + visitor home pages are the SAME data-driven component). It
  lists every credential's `(slug, nick, connection_state, ...)` so cic's
  HomePane renders the networks pane without a second REST round-trip;
  the per-row live nick is resolved via `Networks.resolve_network_nick/2`
  (same lookup `GET /networks` uses). `available_networks` is the on-demand
  self-serve tier (`visitor_enabled − attached`) — populated for BOTH
  subjects (#481; was visitor-only). Built via
  `Networks.home_data_for_{user,visitor}/1`.

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
  # to a `count_after_split/6` per-channel pair. Returns the nested
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
  # Without this guard, `count_after_split/6`'s `is_integer(after_id)`
  # head clause throws FunctionClauseError and the entire /me response
  # 500s — cic then has no `user()` value and the Shell renders the
  # cold "select a channel below" placeholder with no admin console.
  # PROD HOTFIX 2026-06-01: vjt's `#bofh` cursor row had nil id.
  @spec build_unread_counts(
          Grappa.Scrollback.subject(),
          %{String.t() => %{String.t() => integer() | nil}}
        ) :: %{String.t() => %{String.t() => WindowCounts.t()}}
  defp build_unread_counts(_, cursor_envelope) when map_size(cursor_envelope) == 0,
    do: %{}

  defp build_unread_counts(subject, cursor_envelope) do
    # #396 — the ENTIRE cold-load unread envelope in a CONSTANT number of
    # queries (2), not 2 per window. `WindowCounts.bulk_snapshot/4` drives
    # both the count split and the mention tails from the read cursors via
    # #393's single `nick_fold(COALESCE(dm_with, channel))` predicate (one
    # join condition for channel + DM windows, served by the live prod
    # indexes). The `read_cursors ⋈ networks` join includes unbound-but-
    # retained networks' cursors the same way the old
    # `Networks.network_id_by_slug_index/0` inclusion did (GH #105 — unbind
    # deletes only the credential row; the scrollback + cursors survive and
    # must still seed the envelope), and it drops nil-cursor windows +
    # all-nil slugs identically (`refute Map.has_key?`).
    #
    # own_nick (LIVE nick via `Push.BadgeCount.live_nick_windows/1`;
    # `nil` for an unbound network → `mentions: 0`) and the subject-wide
    # highlight `patterns` (#267) are resolved ONCE here and threaded into
    # the bulk fold — the part of the old loop that was already right.
    own_nicks = BadgeCount.live_nick_windows(subject)
    patterns = UserSettings.get_highlight_patterns(subject)

    # #505 — the presence-hiding decision for EVERY window, resolved once
    # and pushed into the same split statement. Without it this door seeds
    # the faint `events` badge with join/part/quit rows the pane will never
    # render, and the count visibly drops as soon as cic hydrates the
    # channel and recomputes through `presenceRowVisible`. This is the door
    # the #505 report describes first: a channel never opened this session
    # is seeded HERE, not by `snapshot/7`.
    #
    # The cursor envelope is threaded in as the window universe — it is what
    # lets the resolver skip the member-count call for a network whose every
    # window is explicitly pinned, and it bounds the exclusion list to
    # windows that can actually produce a row (the split is driven FROM
    # read_cursors).
    hidden = Resolver.hidden_channels(subject, own_nicks, cursor_envelope)

    WindowCounts.bulk_snapshot(subject, own_nicks, patterns, hidden)
  end
end
