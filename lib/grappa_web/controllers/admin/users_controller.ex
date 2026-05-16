defmodule GrappaWeb.Admin.UsersController do
  @moduledoc """
  Admin verbs over the users namespace (M-cluster M-6). Behind the
  `:admin_authn` pipeline; visitor + non-admin user collapse to 403
  upstream.

  ## GET /admin/users — operator console list

  Combined DB intent (`Accounts.list_all_users/0`) + live BEAM state
  (count of `Session.Server`s registered as
  `{:user, user_id} × *`). Composition lives here, not in `Accounts`
  — Accounts keeps the lean `[Grappa.Repo]` deps list. `GrappaWeb`
  already deps both `Accounts` and `LiveIntrospection`; the cycle-
  free composition site IS the controller.

  Returns `200 OK` with `%{"users" => [...]}`. Per-row shape pinned
  by `Grappa.Accounts.AdminWire` (`live_session_count: integer`).

  ## PATCH /admin/users/:id — toggle is_admin

  Whitelist body to `is_admin` ONLY. Extra keys (`name`, `password`,
  etc.) collapse to `400 bad_request` rather than silent ignore —
  the changeset (`User.admin_changeset/2`) already ignores unknown
  keys, but the boundary's job is to be loud. Password reset is a
  separate future endpoint (cluster decision, plan M-6 exit note);
  user renames are deferred too (user_id is baked into PubSub
  topics + bind keys).

  Returns `200 OK` with the updated row in the same shape as one
  GET row. `404 not_found` on unknown id; `422 validation_failed`
  on bad changeset; `400 bad_request` on whitelist breach.

  ## Three-class parity matrix is N/A

  Per `feedback_e2e_user_class_parity_matrix` (vjt 2026-05-16
  STRONG): every USER-FACING IRC function must ship ONE
  parameterized e2e spec across visitor / nickserv / registered
  user. This endpoint is OPERATOR-FACING — admin-gated by
  `:admin_authn`. Visitor + non-admin user behavior is "403
  forbidden, no action runs"; M-2's `MeControllerTest` covers the
  gate. Same shape as M-3/M-4/M-5 admin controller tests.
  """
  use GrappaWeb, :controller

  alias Grappa.{Accounts, LiveIntrospection}
  alias Grappa.Accounts.AdminWire

  @doc """
  Enumerate every user row + project per-row live_session_count.
  """
  @spec index(Plug.Conn.t(), map()) :: Plug.Conn.t()
  def index(conn, _) do
    counts = LiveIntrospection.count_sessions_by_user()

    rows =
      for user <- Accounts.list_all_users() do
        AdminWire.user_to_admin_json(user, Map.get(counts, user.id, 0))
      end

    json(conn, %{users: rows})
  end

  @doc """
  Toggle `is_admin` on `:id`. Body whitelist: `is_admin` only.
  """
  @spec update(Plug.Conn.t(), map()) ::
          Plug.Conn.t() | {:error, :not_found | :bad_request | Ecto.Changeset.t()}
  def update(conn, %{"id" => id} = params) when is_binary(id) do
    with {:ok, attrs} <- admin_attrs(params),
         %Grappa.Accounts.User{} = user <- Accounts.get_user(id),
         {:ok, updated} <- Accounts.update_admin_flags(user, attrs) do
      counts = LiveIntrospection.count_sessions_by_user()
      json(conn, AdminWire.user_to_admin_json(updated, Map.get(counts, updated.id, 0)))
    else
      nil -> {:error, :not_found}
      other -> other
    end
  end

  # Whitelist the single editable flag. Extra keys → 400; matches
  # M-5 NetworksController.caps_attrs/1 pattern exactly.
  defp admin_attrs(params) do
    allowed = ["is_admin"]
    keys = Map.keys(params) -- ["id"]
    extra = keys -- allowed

    if extra == [] do
      {:ok, atomize(params, allowed)}
    else
      {:error, :bad_request}
    end
  end

  defp atomize(params, allowed) do
    Enum.reduce(allowed, %{}, fn key, acc ->
      case Map.fetch(params, key) do
        {:ok, v} -> Map.put(acc, String.to_existing_atom(key), v)
        :error -> acc
      end
    end)
  end
end
