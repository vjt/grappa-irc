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
    * visitor → `{kind: "visitor", id, expires_at, registered,
      read_cursors, unread_counts, badge_count, home_data}` — delegates to
      `Grappa.Visitors.Wire.visitor_to_json/2`. #211 phase 7 —
      nick/ident/realname are DROPPED from the subject: a visitor is
      multi-network, so per-network identity (nick) lives on the
      `GET /networks` rows, not the identity-wide subject. `registered` is
      the DERIVED permanence flag (≥1 credential holding a committed
      NickServ secret — resolved by the controller via
      `Networks.Credentials.visitor_registered?/1` and passed in); see
      `Grappa.Visitors.Wire` moduledoc. `home_data` is POPULATED for
      visitors (ruling A — the user + visitor home pages are the SAME
      data-driven component) via `Networks.home_data_for_visitor/1`.

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
              registered: boolean(),
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
        registered: registered,
        read_cursors: cursors,
        unread_counts: unread_counts,
        badge_count: badge_count,
        home_data: home_data
      })
      when is_boolean(registered) and is_map(home_data) do
    visitor
    |> VisitorsWire.visitor_to_json(registered)
    |> Map.put(:kind, "visitor")
    |> Map.put(:read_cursors, cursors)
    |> Map.put(:unread_counts, unread_counts)
    |> Map.put(:badge_count, badge_count)
    # #211 phase 6 (ruling A) — visitors now carry a POPULATED `home_data`
    # (was `nil`): the user + visitor home pages are the SAME data-driven
    # component. `:registered` (derived from credentials) rides in via
    # `visitor_to_json/2`.
    |> Map.put(:home_data, home_data)
  end
end
