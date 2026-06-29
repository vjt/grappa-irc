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
    * visitor → `{kind: "visitor", id, nick, network_slug, expires_at,
      registered, connected, read_cursors, unread_counts, home_data:
      nil}` — delegates to `Grappa.Visitors.Wire.visitor_to_json/1` so
      the `:password_encrypted` allowlist lives in one place (and the
      derived `:registered` = password present rides in from there). See
      `Grappa.Visitors.Wire` moduledoc for the full leak-defense
      rationale. `:connected` (#126) is the whereis-derived live-upstream
      flag the controller computes (visitors have no `connection_state`
      column); it drives cic's SettingsDrawer disconnect ⇄ reconnect
      toggle. `home_data` is `nil` for visitors by design — visitor home
      is cic-only help text (per the no-localized-strings-server-side
      rule).

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

  Either `%{networks: [home_network_row, ...]}` (user) or `nil`
  (visitor). Per-row shape matches the `connection_state_changed`
  typed event payload's `:network` key exactly (REV-J M15 fold),
  so cic patches `home_data.networks` slots in-place from live
  updates without re-fetching `GET /me`.
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
              network_slug: String.t(),
              expires_at: DateTime.t() | nil,
              registered: boolean(),
              connected: boolean(),
              read_cursors: read_cursors(),
              unread_counts: unread_counts(),
              badge_count: non_neg_integer(),
              home_data: nil
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
              connected: boolean(),
              home_data: nil
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
        connected: connected,
        home_data: nil
      })
      when is_boolean(connected) do
    visitor
    |> VisitorsWire.visitor_to_json()
    |> Map.put(:kind, "visitor")
    |> Map.put(:read_cursors, cursors)
    |> Map.put(:unread_counts, unread_counts)
    |> Map.put(:badge_count, badge_count)
    # #126 — whereis-derived live-upstream flag (visitors have no
    # connection_state column). `:registered` rides in from
    # `VisitorsWire.visitor_to_json/1` (= password_encrypted present).
    |> Map.put(:connected, connected)
    |> Map.put(:home_data, nil)
  end
end
