defmodule Grappa.Accounts.Wire do
  @moduledoc """
  Single source of truth for the public JSON wire shape of
  `Grappa.Accounts.User` rows.

  ## Why this module exists (read before adding fields)

  `User` carries an Argon2 `password_hash` and a virtual `password`
  field. `redact: true` on the virtual field protects `inspect/1`
  and Logger metadata, BUT does NOT protect `Jason.encode!/1` (which
  walks struct fields directly). Without an explicit allowlist
  serializer, any controller that does `json(conn, user)` leaks the
  password hash to the world. (The hash is salted + Argon2id, so a
  leak is far less catastrophic than the upstream IRC password
  exposure that `Grappa.Networks.Wire` defends against — but it is
  still credential material that must never appear on the wire.)

  Two output shapes today:

    * `user_to_json/1` — full profile shape `{id, name, inserted_at}`.
      Used by `GrappaWeb.MeJSON.show/1` for `GET /me`.
    * `user_to_credential_json/1` — minimal credential-exchange shape
      `{id, name}`. Used by `GrappaWeb.AuthJSON.login/1` for the
      `POST /auth/login` response, where `inserted_at` would be
      gratuitous (login is a credential-exchange surface, not a
      profile lookup; clients call `GET /me` after login when they
      need the full profile).

  Adding a field to either wire shape = one edit here. Removing a
  field = a breaking change visible at this single site.

  See `Grappa.Networks.Wire` and `Grappa.Scrollback.Wire` for the
  same pattern on credential and scrollback rows respectively.
  """

  alias Grappa.Accounts.User

  @type user_json :: %{
          id: Ecto.UUID.t(),
          name: String.t(),
          inserted_at: DateTime.t()
        }

  @type credential_json :: %{
          id: Ecto.UUID.t(),
          name: String.t()
        }

  @doc """
  Renders a `User` row to its full public JSON shape —
  `{id, name, inserted_at}`. Excludes `:password_hash` and the
  virtual `:password`; both must NEVER appear on the wire.
  """
  @spec user_to_json(User.t()) :: user_json()
  def user_to_json(%User{} = user) do
    %{id: user.id, name: user.name, inserted_at: user.inserted_at}
  end

  @doc """
  Renders a `User` row to the minimal credential-exchange shape —
  `{id, name}`. Used for the `POST /auth/login` response body. See
  the moduledoc for why this is a separate shape from the full
  profile.
  """
  @spec user_to_credential_json(User.t()) :: credential_json()
  def user_to_credential_json(%User{} = user) do
    %{id: user.id, name: user.name}
  end
end
