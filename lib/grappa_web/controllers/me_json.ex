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
      mirrors the visitor branch of `AuthJSON.subject_wire` extended
      with `expires_at` (the column the SPA needs to render the
      visitor's session-end countdown). `:password_encrypted` is
      `redact: true` at the schema layer; the explicit field
      allowlist here belt-and-braces against accidental wire leak
      via Jason struct walks (see `Grappa.Accounts.Wire` moduledoc
      for the full rationale).
  """
  alias Grappa.Accounts.{User, Wire}
  alias Grappa.Visitors.Visitor

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
    %{
      kind: "visitor",
      id: visitor.id,
      nick: visitor.nick,
      network_slug: visitor.network_slug,
      expires_at: visitor.expires_at
    }
  end
end
