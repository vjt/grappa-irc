defmodule GrappaWeb.MeJSON do
  @moduledoc """
  Phoenix view layer for `GrappaWeb.MeController` — discriminated
  `MeResponse` mirroring `GrappaWeb.AuthJSON.subject_wire` plus a
  per-kind timestamp:

    * user    → `{kind: "user", id, name, inserted_at}` —
      delegates to `Grappa.Accounts.Wire.user_to_json/1` so the
      `:password_hash` / virtual `:password` allowlist lives in one
      place.
    * visitor → `{kind: "visitor", id, nick, network_slug, expires_at}` —
      delegates to `Grappa.Visitors.Wire.visitor_to_json/1` so the
      `:password_encrypted` allowlist lives in one place. See
      `Grappa.Visitors.Wire` moduledoc for the full leak-defense
      rationale (Cloak `:load` decrypts to plaintext-in-memory at
      Repo.get).
  """
  alias Grappa.Accounts.{User, Wire}
  alias Grappa.Visitors.Visitor
  alias Grappa.Visitors.Wire, as: VisitorsWire

  @type me_json ::
          %{
            kind: String.t(),
            id: Ecto.UUID.t(),
            name: String.t(),
            inserted_at: DateTime.t()
          }
          | %{
              kind: String.t(),
              id: Ecto.UUID.t(),
              nick: String.t(),
              network_slug: String.t(),
              expires_at: DateTime.t()
            }

  @doc "Renders the `:show` action — discriminated union per subject kind."
  @spec show(%{user: User.t()} | %{visitor: Visitor.t()}) :: me_json()
  def show(%{user: %User{} = user}) do
    user
    |> Wire.user_to_json()
    |> Map.put(:kind, "user")
  end

  def show(%{visitor: %Visitor{} = visitor}) do
    visitor
    |> VisitorsWire.visitor_to_json()
    |> Map.put(:kind, "visitor")
  end
end
