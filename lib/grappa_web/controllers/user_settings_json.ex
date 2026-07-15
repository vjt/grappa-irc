defmodule GrappaWeb.UserSettingsJSON do
  @moduledoc """
  Phoenix view layer for `GrappaWeb.UserSettingsController` — push
  notifications cluster B3 (2026-05-14).

  Currently exposes one wire shape: `notification_prefs`. Wire keys
  match `Grappa.UserSettings.notification_prefs()` exactly so cic +
  server share a single source of truth for the spelling. Future
  per-key accessors plug in here as additional `render/1` clauses.
  """

  alias Grappa.UserSettings

  @typedoc "Wire shape for the notification_prefs envelope."
  @type notification_prefs_response :: %{
          notification_prefs: UserSettings.notification_prefs()
        }

  @typedoc "Wire shape for the upload_ttl_seconds envelope (UX-4 bucket M)."
  @type upload_ttl_seconds_response :: %{
          upload_ttl_seconds: pos_integer() | nil
        }

  @typedoc """
  One allowed vhost in the self-service view (#228, #251, #252).

  `name` is the address's reverse-DNS (cloak) string — the human label
  cic renders as the primary choice, with `address` as the muted `/128`
  subline. Resolved server-side from DNS (the source of truth; never
  persisted — #252); falls back to the raw `address` when no PTR record
  exists or the name isn't cached yet, so it is ALWAYS a string.
  """
  @type vhost_option :: %{
          address: String.t(),
          in_pool: boolean(),
          granted: boolean(),
          name: String.t()
        }

  @typedoc "Wire shape for the vhost self-service view (#228, #251)."
  @type vhost_response :: %{
          available: [vhost_option()],
          selection: [String.t()]
        }

  @doc "Renders the `:notification_prefs` action — GET/PUT 200 response shape."
  @spec notification_prefs(%{prefs: UserSettings.notification_prefs()}) ::
          notification_prefs_response()
  def notification_prefs(%{prefs: prefs}) do
    %{notification_prefs: prefs}
  end

  @doc """
  Renders the `:upload_ttl_seconds` action — GET/PUT 200 response shape.

  `null` (the absence-of-preference sentinel) round-trips through Jason
  as JSON `null`; cic reads it as "use the active host's defaultTtl."
  """
  @spec upload_ttl_seconds(%{seconds: pos_integer() | nil}) ::
          upload_ttl_seconds_response()
  def upload_ttl_seconds(%{seconds: seconds}) do
    %{upload_ttl_seconds: seconds}
  end

  @doc "Renders the `:vhost` action — GET/PUT 200 response shape (#228, #251)."
  @spec vhost(%{available: [vhost_option()], selection: [String.t()]}) ::
          vhost_response()
  def vhost(%{available: available, selection: selection}) do
    %{available: available, selection: selection}
  end
end
