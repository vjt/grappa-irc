defmodule GrappaWeb.UserSettingsController do
  @moduledoc """
  REST surface for `Grappa.UserSettings` — push notifications cluster
  B3 (2026-05-14).

  First exposed accessor: `notification_prefs`. Two endpoints, both
  behind `[:api, :authn]`:

    * `GET /me/settings/notification-prefs` — 200 with the full
      `notification_prefs()` map. Falls back to defaults when the
      user has no row yet (`Grappa.UserSettings.default_notification_prefs/0`).

    * `PUT /me/settings/notification-prefs` — body matches the
      `notification_prefs()` shape directly (5 booleans + 2 string
      lists). 200 with the persisted shape on success. Validation
      lives in `put_notification_prefs/2`: at least one trigger
      enabled, list elements non-empty strings, whitelists normalized
      (lowercase + trim). 422 with `field_errors.notification_prefs`
      on validation failure (uniform changeset envelope per
      `FallbackController`).

  ## User-only

  Notification prefs are tied to PWA-installed PUSH-receiving
  sessions. Visitors are ephemeral and don't install the PWA;
  push subscriptions are user-only (B1 controller already returns
  403 to visitors). The settings surface follows the same boundary
  — visitors get `:forbidden` from `require_user/1` here.

  ## Why a dedicated controller (not an extension of MeController)

  `MeController` returns a discriminated union (user|visitor) snapshot;
  it's a read-only profile + read-cursor envelope surface, not a
  settings mutation surface. Mutation belongs to a controller that
  owns the put-validate-respond contract for the settings boundary.
  Future per-key accessors (next: theme persistence, mention
  thresholds) plug in here as additional actions, not by widening
  `/me`.
  """

  use GrappaWeb, :controller

  alias Grappa.Accounts.User
  alias Grappa.UserSettings

  @doc """
  `GET /me/settings/notification-prefs` — return the authenticated
  user's notification preferences. Falls back to library defaults
  when the user has never persisted a value.
  """
  @spec show_notification_prefs(Plug.Conn.t(), map()) ::
          Plug.Conn.t() | {:error, :forbidden}
  def show_notification_prefs(conn, _) do
    with {:ok, user} <- require_user(conn) do
      prefs = UserSettings.get_notification_prefs({:user, user.id})
      render(conn, :notification_prefs, prefs: prefs)
    end
  end

  @doc """
  `PUT /me/settings/notification-prefs` — persist a new
  notification-prefs map.

  Body shape mirrors `Grappa.UserSettings.notification_prefs()` exactly
  (bare 5-bools + 2-lists map, NOT wrapped under any envelope key).
  Atom-vs-string keys are tolerated by the validator (Phoenix decodes
  the JSON body with string keys; the validator reads both via
  `Map.get/3` fall-throughs).
  """
  @spec update_notification_prefs(Plug.Conn.t(), map()) ::
          Plug.Conn.t() | {:error, :forbidden | :bad_request | Ecto.Changeset.t()}
  def update_notification_prefs(conn, params) when map_size(params) > 0 do
    with {:ok, user} <- require_user(conn),
         {:ok, _} <- UserSettings.put_notification_prefs({:user, user.id}, params) do
      render(conn, :notification_prefs, prefs: UserSettings.get_notification_prefs({:user, user.id}))
    end
  end

  def update_notification_prefs(_, _), do: {:error, :bad_request}

  # User-only boundary — see moduledoc.
  @spec require_user(Plug.Conn.t()) :: {:ok, User.t()} | {:error, :forbidden}
  defp require_user(conn) do
    case conn.assigns[:current_subject] do
      {:user, %User{} = user} -> {:ok, user}
      _ -> {:error, :forbidden}
    end
  end
end
