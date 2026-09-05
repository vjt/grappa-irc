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
      lists + the `muted_targets` map). EVERY boolean must be present:
      a bundle older than a boolean-adding release 422s until it
      reloads. 200 with the persisted shape on success. Validation
      lives in `put_notification_prefs/2`: at least one MESSAGE trigger
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

  alias Grappa.{ServerSettings, Subject, UserSettings, Vhosts}

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
          Plug.Conn.t() | {:error, :bad_request | Ecto.Changeset.t() | :db_unavailable}
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
          Plug.Conn.t() | {:error, :bad_request | Ecto.Changeset.t() | :db_unavailable}
  def update_upload_ttl_seconds(conn, %{"upload_ttl_seconds" => seconds})
      when is_integer(seconds) or is_nil(seconds) do
    subject = Subject.from_assigns(conn.assigns)

    with {:ok, _} <- UserSettings.put_upload_ttl_seconds(subject, seconds) do
      render(conn, :upload_ttl_seconds, seconds: UserSettings.get_upload_ttl_seconds(subject))
    end
  end

  def update_upload_ttl_seconds(_, _), do: {:error, :bad_request}

  @doc """
  `GET /me/settings/show-peer-profiles` — M2: whether this subject has
  opted in to grappa querying OTHER users' CTCP USERINFO profile (the
  gender badge's source). Default `false`.
  """
  @spec show_show_peer_profiles(Plug.Conn.t(), map()) :: Plug.Conn.t()
  def show_show_peer_profiles(conn, _) do
    subject = Subject.from_assigns(conn.assigns)
    enabled = UserSettings.get_show_peer_profiles(subject)
    render(conn, :show_peer_profiles, enabled: enabled)
  end

  @doc """
  `PUT /me/settings/show-peer-profiles` — persists the opt-in. Body:
  `{"show_peer_profiles": true | false}`. Takes effect on a live
  session's next (re)spawn, not instantly — see
  `Grappa.UserSettings.get_show_peer_profiles/1`.
  """
  @spec update_show_peer_profiles(Plug.Conn.t(), map()) ::
          Plug.Conn.t() | {:error, :bad_request | Ecto.Changeset.t() | :db_unavailable}
  def update_show_peer_profiles(conn, %{"show_peer_profiles" => enabled}) when is_boolean(enabled) do
    subject = Subject.from_assigns(conn.assigns)

    with {:ok, _} <- UserSettings.put_show_peer_profiles(subject, enabled) do
      render(conn, :show_peer_profiles, enabled: UserSettings.get_show_peer_profiles(subject))
    end
  end

  def update_show_peer_profiles(_, _), do: {:error, :bad_request}

  @doc """
  `GET /me/settings/upload-confirm-enabled` — whether the subject has
  opted in to the pre-upload confirm (#1883).

  Default `false`, so a subject who has never touched the setting is
  never asked before an upload leaves the device.
  """
  @spec show_upload_confirm_enabled(Plug.Conn.t(), map()) :: Plug.Conn.t()
  def show_upload_confirm_enabled(conn, _) do
    subject = Subject.from_assigns(conn.assigns)
    enabled = UserSettings.get_upload_confirm_enabled(subject)
    render(conn, :upload_confirm_enabled, enabled: enabled)
  end

  @doc """
  `PUT /me/settings/upload-confirm-enabled` — persists the opt-in. Body:
  `{"upload_confirm_enabled": true | false}`.

  Read by the client at UPLOAD time, so a flip takes effect on the next
  upload with no session involvement — unlike `show_peer_profiles`, which
  waits for a respawn because the bouncer acts on it.
  """
  @spec update_upload_confirm_enabled(Plug.Conn.t(), map()) ::
          Plug.Conn.t() | {:error, :bad_request | Ecto.Changeset.t() | :db_unavailable}
  def update_upload_confirm_enabled(conn, %{"upload_confirm_enabled" => enabled})
      when is_boolean(enabled) do
    subject = Subject.from_assigns(conn.assigns)

    with {:ok, _} <- UserSettings.put_upload_confirm_enabled(subject, enabled) do
      render(conn, :upload_confirm_enabled, enabled: UserSettings.get_upload_confirm_enabled(subject))
    end
  end

  def update_upload_confirm_enabled(_, _), do: {:error, :bad_request}

  @doc """
  `GET /me/settings/auto-away-debounce-seconds` — the subject's
  auto-away grace period (#348).

  `null` = no preference, so the session keeps the server-wide default;
  `0` = auto-away is OFF for this subject; any other integer = seconds.
  """
  @spec show_auto_away_debounce_seconds(Plug.Conn.t(), map()) :: Plug.Conn.t()
  def show_auto_away_debounce_seconds(conn, _) do
    subject = Subject.from_assigns(conn.assigns)
    debounce = UserSettings.get_auto_away_debounce_seconds(subject)
    render(conn, :auto_away_debounce_seconds, debounce: debounce)
  end

  @doc """
  `PUT /me/settings/auto-away-debounce-seconds` — persists the subject's
  auto-away grace period. Body: `{"auto_away_debounce_seconds": N}` with
  `N` an integer in the accepted range, `0` to switch auto-away off, or
  `null` to clear the preference.

  Validation in `Grappa.UserSettings.put_auto_away_debounce_seconds/2`.
  422 + `field_errors.auto_away_debounce_seconds` on rejection; a
  non-integer, non-null body is a 400.
  """
  @spec update_auto_away_debounce_seconds(Plug.Conn.t(), map()) ::
          Plug.Conn.t() | {:error, :bad_request | Ecto.Changeset.t() | :db_unavailable}
  def update_auto_away_debounce_seconds(conn, %{"auto_away_debounce_seconds" => seconds})
      when is_integer(seconds) or is_nil(seconds) do
    subject = Subject.from_assigns(conn.assigns)
    subject_label = GrappaWeb.Subject.topic_label(conn.assigns.current_subject)

    with {:ok, _} <-
           UserSettings.put_auto_away_debounce_seconds(
             subject,
             decode_auto_away_debounce(seconds),
             subject_label
           ) do
      debounce = UserSettings.get_auto_away_debounce_seconds(subject)
      render(conn, :auto_away_debounce_seconds, debounce: debounce)
    end
  end

  def update_auto_away_debounce_seconds(_, _), do: {:error, :bad_request}

  # `0` is the OFF sentinel on the wire (JSON has no atoms); the context
  # speaks `:disabled`. Every other integer travels untouched so the
  # range verdict — including a negative one — stays the context's to
  # give, as a 422 rather than a silent reinterpretation here.
  @spec decode_auto_away_debounce(integer() | nil) :: UserSettings.auto_away_debounce()
  defp decode_auto_away_debounce(0), do: :disabled
  defp decode_auto_away_debounce(seconds), do: seconds

  @doc """
  `GET /me/settings/vhost` — the subject's vhost self-service view
  (#228, #251): the allowed set, each option marked `in_pool` + `granted`,
  plus the current selection. The allowed set is mode-dependent (#596):
  mode 1 = generally-available ∪ in_pool ∪ granted-to-subject; mode 2
  (`static_mapping_with_reservations`) = granted-to-subject ONLY (in_pool /
  generally-available are inert at bind, so they are not offered). No admin
  pin (#251) — the user always self-selects within that set.
  """
  @spec show_vhost(Plug.Conn.t(), map()) :: Plug.Conn.t()
  def show_vhost(conn, _) do
    subject = Subject.from_assigns(conn.assigns)
    render(conn, :vhost, vhost_view(subject, ServerSettings.addressing_mode()))
  end

  @doc """
  `PUT /me/settings/vhost` — persist the subject's vhost selection. Body:
  `{"selection": ["<addr>", ...]}`. Each address MUST be in the subject's
  allowed set — `403 forbidden_vhost` otherwise (authz at the boundary,
  not just the UI). 200 with the refreshed view on success.
  """
  @spec update_vhost(Plug.Conn.t(), map()) ::
          Plug.Conn.t() | {:error, :bad_request | :forbidden_vhost | Ecto.Changeset.t() | :db_unavailable}
  def update_vhost(conn, %{"selection" => selection}) when is_list(selection) do
    subject = Subject.from_assigns(conn.assigns)
    mode = ServerSettings.addressing_mode()

    with {:ok, _} <- Vhosts.set_selection(subject, selection, mode) do
      render(conn, :vhost, vhost_view(subject, mode))
    end
  end

  def update_vhost(_, _), do: {:error, :bad_request}

  @doc """
  `GET /me/settings/aliases` — return the subject's user-defined command
  aliases as `{"aliases": {"<name>": "<expansion>", ...}}`. Empty map when
  the subject has never defined one (#385).
  """
  @spec show_aliases(Plug.Conn.t(), map()) :: Plug.Conn.t()
  def show_aliases(conn, _) do
    subject = Subject.from_assigns(conn.assigns)
    render(conn, :aliases, aliases: UserSettings.get_aliases(subject))
  end

  @doc """
  `PUT /me/settings/aliases` — replace the subject's alias map. Body:
  `{"aliases": {"<name>": "<expansion>", ...}}`. An empty map clears all
  aliases (that is why the map is wrapped under an `aliases` key — a bare
  `{}` body would be indistinguishable from a malformed request).

  Structural validation (name/expansion shape, count cap) lives in
  `Grappa.UserSettings.set_aliases/2`; 422 + `field_errors.aliases` on
  rejection. Expansion grammar + builtin-collision precedence are
  client-side (cic owns the DISPATCH table).
  """
  @spec update_aliases(Plug.Conn.t(), map()) ::
          Plug.Conn.t() | {:error, :bad_request | Ecto.Changeset.t() | :db_unavailable}
  def update_aliases(conn, %{"aliases" => aliases}) when is_map(aliases) do
    subject = Subject.from_assigns(conn.assigns)

    with {:ok, _} <- UserSettings.set_aliases(subject, aliases) do
      render(conn, :aliases, aliases: UserSettings.get_aliases(subject))
    end
  end

  def update_aliases(_, _), do: {:error, :bad_request}

  @doc """
  `GET /me/settings/display-prefs` — return the subject's server-backed
  display preferences (#449): `{"display_prefs": {...}, "persisted": bool}`.
  Falls back to defaults when the subject has never persisted them; the
  `persisted` flag lets the client tell "never written" from "written ==
  defaults" so its seed-up-once never clobbers another device's config.
  """
  @spec show_display_prefs(Plug.Conn.t(), map()) :: Plug.Conn.t()
  def show_display_prefs(conn, _) do
    subject = Subject.from_assigns(conn.assigns)

    render(conn, :display_prefs,
      prefs: UserSettings.get_display_prefs(subject),
      persisted: UserSettings.display_prefs_persisted?(subject)
    )
  end

  @doc """
  `PUT /me/settings/display-prefs` — replace the subject's display prefs.
  Body: `{"display_prefs": {"time_format": ..., "colored_nicklist": ...,
  "presence_filter": {...}}}` (wrapped so an empty/cleared object is
  distinguishable from a malformed body). Full-map PUT, no PATCH/diff.

  Validation (closed sets, tri-state presence values, DOS bounds) lives in
  `Grappa.UserSettings.put_display_prefs/2`; 422 + `field_errors.display_prefs`
  on rejection. The tri-state (`show`/`hide`/unset) round-trips verbatim —
  unset is the ABSENCE of a channel key and is never flattened server-side.
  """
  @spec update_display_prefs(Plug.Conn.t(), map()) ::
          Plug.Conn.t() | {:error, :bad_request | Ecto.Changeset.t() | :db_unavailable}
  def update_display_prefs(conn, %{"display_prefs" => prefs}) when is_map(prefs) do
    subject = Subject.from_assigns(conn.assigns)

    with {:ok, _} <- UserSettings.put_display_prefs(subject, prefs) do
      # The write just merged a well-formed blob, so it is persisted by
      # definition — no redundant re-query of display_prefs_persisted?/1.
      render(conn, :display_prefs, prefs: UserSettings.get_display_prefs(subject), persisted: true)
    end
  end

  def update_display_prefs(_, _), do: {:error, :bad_request}

  # Builds the render assigns for the vhost view — allowed set (each option
  # marked in_pool + granted + a resolved rDNS name), current selection.
  # `granted` reflects a real per-subject grant row, NOT allow-set
  # membership (which in mode 1 also includes in_pool + generally-available
  # vhosts — #251), so cic V2 can bucket exclusive (granted) / in-pool /
  # out-of-pool. `mode` (from `ServerSettings.addressing_mode/0`) gates the
  # allowed set: in mode 2 it is the granted set ONLY (#596), so the view
  # never offers an in_pool / generally-available option the resolver would
  # silently ignore at bind.
  #
  # `name` is the address's reverse-DNS (cloak) string — #252. The DNS is
  # the source of truth (nothing persisted); `Grappa.Net.PtrCache.names_for/1`
  # is a LOCK-FREE ETS read that NEVER blocks this response on a resolve. A
  # cold/expired/no-PTR address reads back as `nil` and falls back to the
  # raw IP here; the cache resolves it out of band so a later GET shows the
  # name (cic re-reads the view on entering the vhost sub-page).
  defp vhost_view(subject, mode) do
    granted_ids = MapSet.new(Vhosts.granted_vhost_ids(subject))
    allowed = Vhosts.allowed_vhosts(subject, mode)
    names = Grappa.Net.PtrCache.names_for(Enum.map(allowed, & &1.address))

    available =
      Enum.map(allowed, fn v ->
        %{
          address: v.address,
          in_pool: v.in_pool,
          granted: MapSet.member?(granted_ids, v.id),
          name: names[v.address] || v.address
        }
      end)

    %{available: available, selection: Vhosts.get_selection(subject, mode)}
  end
end
