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

  alias Grappa.{Subject, UserSettings, Vhosts}

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

  @doc """
  `GET /me/settings/upload-ttl-seconds` — returns the subject's
  stored upload-TTL preference (integer seconds) or `null` when no
  preference is set.

  UX-4 bucket M (2026-05-19). The image-upload orchestrator (cic-side)
  uses `null` as the "fall back to active host's defaultTtl" sentinel,
  so the UI can render a stable "Use site default (24h)" entry when
  the user has never picked a TTL.
  """
  @spec show_upload_ttl_seconds(Plug.Conn.t(), map()) :: Plug.Conn.t()
  def show_upload_ttl_seconds(conn, _) do
    subject = Subject.from_assigns(conn.assigns)
    seconds = UserSettings.get_upload_ttl_seconds(subject)
    render(conn, :upload_ttl_seconds, seconds: seconds)
  end

  @doc """
  `PUT /me/settings/upload-ttl-seconds` — persists the subject's
  upload-TTL preference. Body shape: `{"upload_ttl_seconds": N}` where
  `N` is a positive integer up to 31_536_000 (1 year), OR `null` to
  clear the preference (revert to the active host's default).

  Validation in `Grappa.UserSettings.put_upload_ttl_seconds/2`. 422 +
  `field_errors.upload_ttl_seconds` on rejection.
  """
  @spec update_upload_ttl_seconds(Plug.Conn.t(), map()) ::
          Plug.Conn.t() | {:error, :bad_request | Ecto.Changeset.t()}
  def update_upload_ttl_seconds(conn, %{"upload_ttl_seconds" => seconds})
      when is_integer(seconds) or is_nil(seconds) do
    subject = Subject.from_assigns(conn.assigns)

    with {:ok, _} <- UserSettings.put_upload_ttl_seconds(subject, seconds) do
      render(conn, :upload_ttl_seconds, seconds: UserSettings.get_upload_ttl_seconds(subject))
    end
  end

  def update_upload_ttl_seconds(_, _), do: {:error, :bad_request}

  @doc """
  `GET /me/settings/vhost` — the subject's vhost self-service view (#228):
  the allowed set (generally-available ∪ granted-to-subject, each marked
  `in_pool`), the current selection, and the pinned address (`null` when
  none / not pinned). A pin is admin-forced — the UI greys the selector
  when `pinned` is set.
  """
  @spec show_vhost(Plug.Conn.t(), map()) :: Plug.Conn.t()
  def show_vhost(conn, _) do
    subject = Subject.from_assigns(conn.assigns)
    render(conn, :vhost, vhost_view(subject))
  end

  @doc """
  `PUT /me/settings/vhost` — persist the subject's vhost selection. Body:
  `{"selection": ["<addr>", ...]}`. Each address MUST be in the subject's
  allowed set — `403 forbidden_vhost` otherwise (authz at the boundary,
  not just the UI). 200 with the refreshed view on success.
  """
  @spec update_vhost(Plug.Conn.t(), map()) ::
          Plug.Conn.t() | {:error, :bad_request | :forbidden_vhost | Ecto.Changeset.t()}
  def update_vhost(conn, %{"selection" => selection}) when is_list(selection) do
    subject = Subject.from_assigns(conn.assigns)

    with {:ok, _} <- Vhosts.set_selection(subject, selection) do
      render(conn, :vhost, vhost_view(subject))
    end
  end

  def update_vhost(_, _), do: {:error, :bad_request}

  # Builds the render assigns for the vhost view — allowed set (with
  # in_pool marking), current selection, pinned address.
  defp vhost_view(subject) do
    available =
      subject
      |> Vhosts.allowed_vhosts()
      |> Enum.map(fn v -> %{address: v.address, in_pool: v.in_pool} end)

    pinned =
      case Vhosts.pinned_vhost(subject) do
        %Vhosts.Vhost{address: address} -> address
        nil -> nil
      end

    %{available: available, selection: Vhosts.get_selection(subject), pinned: pinned}
  end
end
