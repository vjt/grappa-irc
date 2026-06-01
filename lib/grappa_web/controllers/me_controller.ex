defmodule GrappaWeb.MeController do
  @moduledoc """
  `GET /me` — returns the authenticated subject's public profile as a
  discriminated union mirroring `GrappaWeb.AuthJSON.subject_wire`:

    * user    → `{kind: "user", id, name, inserted_at, home_data}`
    * visitor → `{kind: "visitor", id, nick, network_slug, expires_at,
      home_data: nil}`

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

  alias Grappa.{Networks, ReadCursor, Scrollback}

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
  id}}` (per plan O1: nested by network) so cic doesn't need a
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
  Networks` cycle). One `Networks.network_id_by_slug_index/0` call
  feeds an Enum.reduce over the cursor envelope; per-cursor
  `count_after_split/5` is a single SQL round-trip — bounded by the
  same ~600 worst-case cursor count `bulk_for_subject/1` carries.
  `own_nick` is passed `nil` here — the `/me` seed is a coarse cold-
  load fallback that the per-channel join reply (which DOES resolve
  the per-network own_nick via `Session.current_nick/2`) refines once
  the user joins. Skipping per-network nick resolution keeps the /me
  path off of `Grappa.Session`.

  ## home_data envelope (UX-4 bucket B)

  The response carries `home_data: %{networks: [...]} | nil`. For
  user subjects it lists every credential's `(slug, nick,
  connection_state, ...)` so cic's HomePane can render the networks
  pane without a second REST round-trip; the per-row live nick is
  resolved via `Networks.resolve_network_nick/2` (same lookup
  `GET /networks` uses). For visitor subjects it is `nil` outright —
  visitor home is cic-only help text by design (no server roundtrip,
  per the no-localized-strings-server-side rule).

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
          home_data: home_data
        )

      {:visitor, visitor} ->
        subject = {:visitor, visitor.id}
        cursors = ReadCursor.bulk_for_subject(subject)
        unread_counts = build_unread_counts(subject, cursors)

        render(conn, :show,
          visitor: visitor,
          read_cursors: cursors,
          unread_counts: unread_counts,
          home_data: nil
        )

      _ ->
        {:error, :unauthorized}
    end
  end

  # Walks the cursor envelope and resolves each (slug, channel, cursor)
  # to a `count_after_split/5` per-channel pair. Returns the nested
  # `%{slug => %{channel => %{messages, events}}}` shape that mirrors
  # the cursor envelope; missing slugs (stale cursor referencing a
  # network that's since been deleted) are dropped.
  @spec build_unread_counts(
          Grappa.Scrollback.subject(),
          %{String.t() => %{String.t() => integer()}}
        ) :: %{String.t() => %{String.t() => %{messages: non_neg_integer(), events: non_neg_integer()}}}
  defp build_unread_counts(_, cursor_envelope) when map_size(cursor_envelope) == 0,
    do: %{}

  defp build_unread_counts(subject, cursor_envelope) do
    slug_to_id = Networks.network_id_by_slug_index()

    for {slug, per_channel} <- cursor_envelope,
        Map.has_key?(slug_to_id, slug),
        reduce: %{} do
      acc ->
        net_id = Map.fetch!(slug_to_id, slug)

        channel_counts =
          for {channel, cursor} <- per_channel,
              reduce: %{} do
            inner ->
              Map.put(
                inner,
                channel,
                Scrollback.count_after_split(subject, net_id, channel, cursor)
              )
          end

        Map.put(acc, slug, channel_counts)
    end
  end
end
