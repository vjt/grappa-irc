defmodule GrappaWeb.MeJSON do
  @moduledoc """
  Phoenix view layer for `GrappaWeb.MeController` — discriminated
  `MeResponse` mirroring `GrappaWeb.AuthJSON.subject_wire` plus a
  per-kind timestamp:

    * user    → `{kind: "user", id, name, inserted_at, read_cursors}` —
      delegates to `Grappa.Accounts.Wire.user_to_json/1` so the
      `:password_hash` / virtual `:password` allowlist lives in one
      place.
    * visitor → `{kind: "visitor", id, nick, network_slug, expires_at,
      read_cursors}` — delegates to `Grappa.Visitors.Wire.visitor_to_json/1`
      so the `:password_encrypted` allowlist lives in one place. See
      `Grappa.Visitors.Wire` moduledoc for the full leak-defense
      rationale (Cloak `:load` decrypts to plaintext-in-memory at
      Repo.get).

  ## read_cursors envelope (CP29 R-3)

  Nested map: `%{network_slug => %{channel => last_read_message_id}}`.
  Loaded once at login by cic so it can render correct unread badges
  without a per-window REST round-trip. Empty `%{}` for a fresh
  subject. Per plan O1.
  """
  alias Grappa.Accounts.{User, Wire}
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
            inserted_at: DateTime.t(),
            read_cursors: read_cursors()
          }
          | %{
              kind: String.t(),
              id: Ecto.UUID.t(),
              nick: String.t(),
              network_slug: String.t(),
              expires_at: DateTime.t() | nil,
              read_cursors: read_cursors()
            }

  @doc "Renders the `:show` action — discriminated union per subject kind."
  @spec show(
          %{user: User.t(), read_cursors: read_cursors()}
          | %{visitor: Visitor.t(), read_cursors: read_cursors()}
        ) :: me_json()
  def show(%{user: %User{} = user, read_cursors: cursors}) do
    user
    |> Wire.user_to_json()
    |> Map.put(:kind, "user")
    |> Map.put(:read_cursors, cursors)
  end

  def show(%{visitor: %Visitor{} = visitor, read_cursors: cursors}) do
    visitor
    |> VisitorsWire.visitor_to_json()
    |> Map.put(:kind, "visitor")
    |> Map.put(:read_cursors, cursors)
  end
end
