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

  @typedoc "Wire shape for the show_peer_profiles envelope (M2)."
  @type show_peer_profiles_response :: %{show_peer_profiles: boolean()}

  @typedoc "Wire shape for the upload_confirm_enabled envelope (#1883)."
  @type upload_confirm_enabled_response :: %{upload_confirm_enabled: boolean()}

  @typedoc """
  Wire shape for the auto_away_debounce_seconds envelope (#348).

  `null` = no preference (the server default applies), `0` = auto-away
  OFF, any other integer = seconds.
  """
  @type auto_away_debounce_seconds_response :: %{
          auto_away_debounce_seconds: non_neg_integer() | nil
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

  @typedoc "Wire shape for the aliases envelope (#385 user-defined aliases)."
  @type aliases_response :: %{
          aliases: %{String.t() => String.t()}
        }

  @typedoc """
  Wire shape for the display_prefs envelope (#449). `persisted` is the
  seed-up discriminator: `false` means the subject has never written a
  well-formed blob (client pushes its local values up), `true` means the
  server carries prefs (server wins). Additive per #447 — old clients ignore it.
  """
  @type display_prefs_response :: %{
          display_prefs: UserSettings.display_prefs(),
          persisted: boolean()
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

  @doc "Renders the `:show_peer_profiles` action — GET/PUT 200 shape (M2)."
  @spec show_peer_profiles(%{enabled: boolean()}) :: show_peer_profiles_response()
  def show_peer_profiles(%{enabled: enabled}) do
    %{show_peer_profiles: enabled}
  end

  @doc "Renders the `:upload_confirm_enabled` action — GET/PUT 200 shape (#1883)."
  @spec upload_confirm_enabled(%{enabled: boolean()}) :: upload_confirm_enabled_response()
  def upload_confirm_enabled(%{enabled: enabled}) do
    %{upload_confirm_enabled: enabled}
  end

  @doc """
  Renders the `:auto_away_debounce_seconds` action — GET/PUT 200 shape (#348).

  The context's `:disabled` atom becomes the `0` sentinel here, the one
  place that translation is allowed to happen on the way out; `nil`
  stays JSON `null` and means "no preference, use the server default".
  """
  @spec auto_away_debounce_seconds(%{debounce: UserSettings.auto_away_debounce()}) ::
          auto_away_debounce_seconds_response()
  def auto_away_debounce_seconds(%{debounce: :disabled}), do: %{auto_away_debounce_seconds: 0}

  def auto_away_debounce_seconds(%{debounce: seconds}),
    do: %{auto_away_debounce_seconds: seconds}

  @doc "Renders the `:vhost` action — GET/PUT 200 response shape (#228, #251)."
  @spec vhost(%{available: [vhost_option()], selection: [String.t()]}) ::
          vhost_response()
  def vhost(%{available: available, selection: selection}) do
    %{available: available, selection: selection}
  end

  @doc "Renders the `:aliases` action — GET/PUT 200 response shape (#385)."
  @spec aliases(%{aliases: %{String.t() => String.t()}}) :: aliases_response()
  def aliases(%{aliases: aliases}) do
    %{aliases: aliases}
  end

  @doc "Renders the `:display_prefs` action — GET/PUT 200 response shape (#449)."
  @spec display_prefs(%{prefs: UserSettings.display_prefs(), persisted: boolean()}) ::
          display_prefs_response()
  def display_prefs(%{prefs: prefs, persisted: persisted}) do
    %{display_prefs: prefs, persisted: persisted}
  end
end
