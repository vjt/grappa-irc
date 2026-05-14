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

  @doc "Renders the `:notification_prefs` action — GET/PUT 200 response shape."
  @spec notification_prefs(%{prefs: UserSettings.notification_prefs()}) ::
          notification_prefs_response()
  def notification_prefs(%{prefs: prefs}) do
    %{notification_prefs: prefs}
  end
end
