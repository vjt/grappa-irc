defmodule GrappaWeb.MeJSON do
  @moduledoc """
  Phoenix view layer for `GrappaWeb.MeController` — discriminated
  `MeResponse` mirroring `GrappaWeb.AuthJSON.subject_wire` plus a
  per-kind timestamp:

    * user    → `{kind: "user", id, name, is_admin, inserted_at,
      read_cursors, home_data}` — delegates to
      `Grappa.Accounts.Wire.user_to_json/1` so the `:password_hash` /
      virtual `:password` allowlist lives in one place. `is_admin`
      (M-cluster M-1) lands here so cic can gate the admin-drawer
      entry off the `me` envelope without a second round-trip to
      `GET /admin/me`. `home_data` (UX-4 bucket B) carries the
      networks list cic's HomePane renders.
    * visitor → `{kind: "visitor", id, nick, network_slug, expires_at,
      read_cursors, home_data: nil}` — delegates to
      `Grappa.Visitors.Wire.visitor_to_json/1` so the
      `:password_encrypted` allowlist lives in one place. See
      `Grappa.Visitors.Wire` moduledoc for the full leak-defense
      rationale. `home_data` is `nil` for visitors by design —
      visitor home is cic-only help text (per the
      no-localized-strings-server-side rule).

  ## read_cursors envelope (CP29 R-3)

  Nested map: `%{network_slug => %{channel => last_read_message_id}}`.
  Loaded once at login by cic so it can render correct unread badges
  without a per-window REST round-trip. Empty `%{}` for a fresh
  subject. Per plan O1.

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
  Read-cursor envelope: nested `%{slug => %{channel => id}}` per plan O1.
  """
  @type read_cursors :: %{String.t() => %{String.t() => integer()}}

  @type me_json ::
          %{
            kind: String.t(),
            id: Ecto.UUID.t(),
            name: String.t(),
            is_admin: boolean(),
            inserted_at: DateTime.t(),
            read_cursors: read_cursors(),
            home_data: NetworksWire.home_data()
          }
          | %{
              kind: String.t(),
              id: Ecto.UUID.t(),
              nick: String.t(),
              network_slug: String.t(),
              expires_at: DateTime.t() | nil,
              read_cursors: read_cursors(),
              home_data: nil
            }

  @doc "Renders the `:show` action — discriminated union per subject kind."
  @spec show(
          %{user: User.t(), read_cursors: read_cursors(), home_data: NetworksWire.home_data()}
          | %{visitor: Visitor.t(), read_cursors: read_cursors(), home_data: nil}
        ) :: me_json()
  def show(%{user: %User{} = user, read_cursors: cursors, home_data: home_data})
      when is_map(home_data) do
    user
    |> Wire.user_to_json()
    |> Map.put(:kind, "user")
    |> Map.put(:read_cursors, cursors)
    |> Map.put(:home_data, home_data)
  end

  def show(%{visitor: %Visitor{} = visitor, read_cursors: cursors, home_data: nil}) do
    visitor
    |> VisitorsWire.visitor_to_json()
    |> Map.put(:kind, "visitor")
    |> Map.put(:read_cursors, cursors)
    |> Map.put(:home_data, nil)
  end
end
