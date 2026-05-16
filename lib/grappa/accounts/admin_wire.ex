defmodule Grappa.Accounts.AdminWire do
  @moduledoc """
  Operator-facing JSON wire shape for `Grappa.Accounts.User` rows
  (M-cluster M-6 `GET /admin/users`, `PATCH /admin/users/:id`).
  Sibling to `Grappa.Accounts.Wire` (cic/auth-facing).

  ## Why two wire modules

  `Accounts.Wire` is the public profile shape — what cic shows the
  authenticated user about themselves. The admin pane sees the
  operator-facing fields: `is_admin` flag, timestamps, the live
  session count.

  ## Defensive field exclusion (CRITICAL)

  Neither `:password_hash` (Argon2 hash) nor the virtual `:password`
  field is ever in the rendered map. The `redact: true` on the
  schema fields protects `inspect/1` + Logger output, but NOT
  `Jason.encode!/1` (which walks struct fields directly). Adding a
  field here = one explicit edit; never use `Map.from_struct/1`.

  Same posture as `Grappa.Visitors.AdminWire` /
  `Grappa.Networks.Credentials.AdminWire`.

  ## Live state — count only

  `live_session_count` is the count of `Session.Server`s registered
  as `{:user, user_id} × *` (any network). M-cluster M-6 ships the
  count-only projection per MD2; the per-network drill-down
  (`/admin/credentials` per credential) carries `live_state: nil |
  SessionEntry` for finer detail.
  """

  alias Grappa.Accounts.User

  @type t :: %{
          id: Ecto.UUID.t(),
          name: String.t(),
          is_admin: boolean(),
          inserted_at: DateTime.t(),
          updated_at: DateTime.t(),
          live_session_count: non_neg_integer()
        }

  @doc """
  Render a User row + injected live session count to the admin JSON
  shape. The count is supplied by the controller from a single
  `LiveIntrospection.count_sessions_by_user/0` scan so per-row
  rendering doesn't repeat the registry walk.
  """
  @spec user_to_admin_json(User.t(), non_neg_integer()) :: t()
  def user_to_admin_json(%User{} = user, live_session_count)
      when is_integer(live_session_count) and live_session_count >= 0 do
    %{
      id: user.id,
      name: user.name,
      is_admin: user.is_admin,
      inserted_at: user.inserted_at,
      updated_at: user.updated_at,
      live_session_count: live_session_count
    }
  end
end
