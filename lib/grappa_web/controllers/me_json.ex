defmodule GrappaWeb.MeJSON do
  @moduledoc """
  Phoenix view layer for `GrappaWeb.MeController` — discriminated
  `MeResponse` mirroring `GrappaWeb.AuthJSON.subject_wire` plus a
  per-kind timestamp:

    * user    → `{kind: "user", id, name, is_admin, inserted_at,
      read_cursors, unread_counts, home_data}` — delegates to
      `Grappa.Accounts.Wire.user_to_json/1` so the `:password_hash` /
      virtual `:password` allowlist lives in one place. `is_admin`
      (M-cluster M-1) lands here so cic can gate the admin-drawer
      entry off the `me` envelope without a second round-trip to
      `GET /admin/me`. `home_data` (UX-4 bucket B) carries the
      networks list cic's HomePane renders.
    * visitor → `{kind: "visitor", id, nick, ident, realname,
      expires_at, registered, read_cursors, unread_counts, badge_count,
      home_data}` — delegates to
      `Grappa.Visitors.Wire.visitor_to_json/1` so the
      `:password_encrypted` allowlist lives in one place (and the
      derived `:registered` = password present rides in from there). See
      `Grappa.Visitors.Wire` moduledoc for the full leak-defense
      rationale. #211 phase 6 — `network_slug` + the singular `connected`
      scalar are DROPPED: a visitor is multi-network now, so per-network
      live status lives on the `GET /networks` rows' `connection_state`
      (ruling A/D). `home_data` is now POPULATED for visitors too (ruling
      A — the user + visitor home pages are the SAME data-driven
      component) via `Networks.home_data_for_visitor/1`.

  ## read_cursors envelope (CP29 R-3)

  Nested map: `%{network_slug => %{channel => last_read_message_id}}`.
  Loaded once at login by cic so it can render correct unread badges
  without a per-window REST round-trip. Empty `%{}` for a fresh
  subject.

  ## unread_counts envelope (bucket C, 2026-06-01)

  Nested map: `%{network_slug => %{channel => %{messages: int, events:
  int}}}`. Same nesting as `read_cursors`; same nested-by-network grouping.
  Built inline by `MeController.show/2` from
  `Grappa.Scrollback.count_after_split/5` per cursor (slug→id index
  resolved controller-side to keep `Scrollback` free of a `Networks`
  dep edge). Channels without a cursor row are absent — cic falls
  back to the per-channel join reply seed (bucket B1) for those. Cic
  consumes via `selection.ts`'s `applySeedEnvelope`.

  ## badge_count (PWA icon badge, 2026-06-21)

  Top-level `badge_count: non_neg_integer()` (0..99) — door #2 of the
  PWA icon-badge feature. The notify-worthy unread total
  (`Grappa.Push.BadgeCount.count/1`): the same predicate Web Push fires
  on, capped at 99. cic seeds its badge signal from this at login so the
  home-screen icon / `document.title` reflect the count before any push
  or `read_cursor_set` arrives. Unlike `unread_counts` it is a single
  scalar, not a per-channel envelope.

  ## home_data envelope (UX-4 bucket B)

  `%{networks: [home_network_row, ...], available_networks: [...]}` for
  BOTH subjects (#211 phase 6, ruling A — the user + visitor home pages
  are the SAME data-driven component). Per-row shape matches the
  `connection_state_changed` typed event payload's `:network` key exactly
  (REV-J M15 fold), so cic patches `home_data.networks` slots in-place
  from live updates without re-fetching `GET /me`. `available_networks`
  is the visitor on-demand-connect tier (empty for users).
  """
  alias Grappa.Accounts.{User, Wire}
  alias Grappa.Networks.Wire, as: NetworksWire
  alias Grappa.Visitors.Visitor
  alias Grappa.Visitors.Wire, as: VisitorsWire

  @typedoc """
  Read-cursor envelope: nested `%{slug => %{channel => id}}`.
  """
  @type read_cursors :: %{String.t() => %{String.t() => integer()}}

  @typedoc """
  Unread-count envelope: nested `%{slug => %{channel => %{messages,
  events}}}`. The pair shape mirrors cic
  `selection.ts`'s `ServerSeedCount` type byte-for-byte.
  """
  @type unread_counts :: %{
          String.t() => %{
            String.t() => %{messages: non_neg_integer(), events: non_neg_integer()}
          }
        }

  @type me_json ::
          %{
            kind: String.t(),
            id: Ecto.UUID.t(),
            name: String.t(),
            is_admin: boolean(),
            inserted_at: DateTime.t(),
            read_cursors: read_cursors(),
            unread_counts: unread_counts(),
            badge_count: non_neg_integer(),
            home_data: NetworksWire.home_data()
          }
          | %{
              kind: String.t(),
              id: Ecto.UUID.t(),
              nick: String.t(),
              expires_at: DateTime.t() | nil,
              registered: boolean(),
              read_cursors: read_cursors(),
              unread_counts: unread_counts(),
              badge_count: non_neg_integer(),
              home_data: NetworksWire.home_data()
            }

  @doc "Renders the `:show` action — discriminated union per subject kind."
  @spec show(
          %{
            user: User.t(),
            read_cursors: read_cursors(),
            unread_counts: unread_counts(),
            badge_count: non_neg_integer(),
            home_data: NetworksWire.home_data()
          }
          | %{
              visitor: Visitor.t(),
              read_cursors: read_cursors(),
              unread_counts: unread_counts(),
              badge_count: non_neg_integer(),
              home_data: NetworksWire.home_data()
            }
        ) :: me_json()
  def show(%{
        user: %User{} = user,
        read_cursors: cursors,
        unread_counts: unread_counts,
        badge_count: badge_count,
        home_data: home_data
      })
      when is_map(home_data) do
    user
    |> Wire.user_to_json()
    |> Map.put(:kind, "user")
    |> Map.put(:read_cursors, cursors)
    |> Map.put(:unread_counts, unread_counts)
    |> Map.put(:badge_count, badge_count)
    |> Map.put(:home_data, home_data)
  end

  def show(%{
        visitor: %Visitor{} = visitor,
        read_cursors: cursors,
        unread_counts: unread_counts,
        badge_count: badge_count,
        home_data: home_data
      })
      when is_map(home_data) do
    visitor
    |> VisitorsWire.visitor_to_json()
    |> Map.put(:kind, "visitor")
    |> Map.put(:read_cursors, cursors)
    |> Map.put(:unread_counts, unread_counts)
    |> Map.put(:badge_count, badge_count)
    # #211 phase 6 (ruling A) — visitors now carry a POPULATED `home_data`
    # (was `nil`): the user + visitor home pages are the SAME data-driven
    # component. `:registered` rides in from `visitor_to_json/1`.
    |> Map.put(:home_data, home_data)
  end

  @doc """
  #152 — response for `PATCH /me/identity`. The updated visitor profile
  (via `VisitorsWire.visitor_to_json/1`, so ident/realname/registered
  ride the same allowlist as `GET /me`) plus the `connected` flag so cic
  can reflect the post-reconnect live state. No cursors/badge/home_data
  envelope — this is an identity mutation response, not a full profile
  reload.
  """
  @spec identity(%{visitor: Visitor.t(), connected: boolean()}) :: map()
  def identity(%{visitor: %Visitor{} = visitor, connected: connected})
      when is_boolean(connected) do
    visitor
    |> VisitorsWire.visitor_to_json()
    |> Map.put(:kind, "visitor")
    |> Map.put(:connected, connected)
  end
end
