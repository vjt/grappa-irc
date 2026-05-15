defmodule GrappaWeb.UserSettingsController do
  @moduledoc """
  REST surface for `Grappa.UserSettings` — push notifications cluster
  B3 (2026-05-14) + visitor-parity V4 (2026-05-15).

  First exposed accessor: `notification_prefs`. Two endpoints, both
  behind `[:api, :authn]`:

    * `GET /me/settings/notification-prefs` — 200 with the full
      `notification_prefs()` map. Falls back to defaults when the
      subject has no row yet (`Grappa.UserSettings.default_notification_prefs/0`).

    * `PUT /me/settings/notification-prefs` — body matches the
      `notification_prefs()` shape directly (5 booleans + 2 string
      lists). 200 with the persisted shape on success. Validation
      lives in `put_notification_prefs/2`: at least one trigger
      enabled, list elements non-empty strings, whitelists normalized
      (lowercase + trim). 422 with `field_errors.notification_prefs`
      on validation failure (uniform changeset envelope per
      `FallbackController`).

  ## Subject-scoped — V4 (2026-05-15)

  Both registered users and visitors persist notification preferences
  through this controller. The action body delegates to
  `Grappa.Subject.from_assigns/1` for the bare-id tuple and hands it
  straight to `Grappa.UserSettings` accessors; the FK XOR invariant
  is enforced at the schema layer (per-subject partial unique
  indexes). Anon visitors' settings CASCADE-delete on Reaper sweep;
  identified visitors keep them indefinitely (NickServ identity proof
  = permanent subject). V3 lifted the push-fan-out trigger reads to
  the same subject shape — visitor mention notifications now fire
  per the visitor's stored prefs.

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

  alias Grappa.{Subject, UserSettings}

  @doc """
  `GET /me/settings/notification-prefs` — return the authenticated
  subject's notification preferences. Falls back to library defaults
  when the subject has never persisted a value.
  """
  @spec show_notification_prefs(Plug.Conn.t(), map()) :: Plug.Conn.t()
  def show_notification_prefs(conn, _) do
    subject = Subject.from_assigns(conn.assigns)
    prefs = UserSettings.get_notification_prefs(subject)
    render(conn, :notification_prefs, prefs: prefs)
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
          Plug.Conn.t() | {:error, :bad_request | Ecto.Changeset.t()}
  def update_notification_prefs(conn, params) when map_size(params) > 0 do
    subject = Subject.from_assigns(conn.assigns)

    with {:ok, _} <- UserSettings.put_notification_prefs(subject, params) do
      render(conn, :notification_prefs, prefs: UserSettings.get_notification_prefs(subject))
    end
  end

  def update_notification_prefs(_, _), do: {:error, :bad_request}
end
