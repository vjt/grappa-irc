defmodule GrappaWeb.Admin.SettingsController do
  @moduledoc """
  Admin verbs over `Grappa.ServerSettings`. Behind `:admin_authn` —
  visitor + non-admin user collapse to 403 upstream.

  ## GET /admin/settings

  Returns the full settings view (today: the same `public_view/0` the
  authenticated `/api/server-settings` returns; admin-only settings,
  when added, will land here only). Wire shape:

      %{
        settings: %{
          upload: %{
            active_host: "embedded" | "litterbox",
            per_file_cap_bytes: pos_integer(),
            global_cap_bytes: pos_integer()
          }
        }
      }

  ## PUT /admin/settings

  Body shape:

      %{
        "upload" => %{
          "active_host" => "embedded" | "litterbox",
          "per_file_cap_bytes" => pos_integer(),
          "global_cap_bytes" => pos_integer()
        }
      }

  Each key in `upload` is optional — the controller upserts only
  the keys present in the body. Any invalid value (out-of-set host
  string, non-positive integer cap) collapses to 422
  `validation_failed` with a `field_errors` map naming the offending
  key.

  On success: 200 with the new full settings view AND fan-out of a
  `server_settings_changed` push on every live `Topic.user(name)`
  for cic reactive update without a poll. Same precedent +
  iterator as `AdminController.cic_bundle_changed/2` (CP23 S4 B5
  cic-bundle fan-out): one broadcast per operator with a live WS.
  Wire-shape lives at `Grappa.ServerSettings.Wire`.

  The intermediate `Grappa.ServerSettings.topic/0` broadcast that
  `put_*/1` emits stays as an in-process signal for tests + any
  future internal subscriber; the cic fan-out path lives HERE
  (single explicit door, parity with `cic_bundle_changed`).
  """

  use GrappaWeb, :controller

  alias Grappa.{PubSub, ServerSettings, WSPresence}
  alias Grappa.PubSub.Topic
  alias Grappa.ServerSettings.Wire, as: SettingsWire

  require Logger

  @doc false
  @spec index(Plug.Conn.t(), map()) :: Plug.Conn.t()
  def index(conn, _) do
    json(conn, %{settings: render_view(ServerSettings.public_view())})
  end

  @doc false
  @spec update(Plug.Conn.t(), map()) :: Plug.Conn.t() | {:error, atom() | Ecto.Changeset.t()}
  def update(conn, params) do
    with :ok <- apply_updates(params) do
      view = ServerSettings.public_view()
      :ok = fanout_changed(view)
      json(conn, %{settings: render_view(view)})
    end
  end

  # UX-6-B2 (2026-05-21): fan out the new view on every live
  # `Topic.user(name)`. Mirrors `AdminController.cic_bundle_changed/2`'s
  # `WSPresence.list_user_names/0` iterator + per-target
  # `broadcast_event/2` — same delivery contract (Phoenix Channel
  # fastlane → one WS frame per connected socket on the topic).
  # Telemetry attempted/succeeded/failed lets a downstream PromEx
  # alarm fire on per-target broadcast failure (HIGH-17 lesson:
  # never silently discard per-target return).
  defp fanout_changed(view) do
    payload = SettingsWire.server_settings_changed(view)
    user_names = WSPresence.list_user_names()
    attempted = length(user_names)

    succeeded =
      Enum.count(user_names, fn name ->
        PubSub.broadcast_event(Topic.user(name), payload) == :ok
      end)

    :telemetry.execute(
      [:grappa, :admin, :server_settings_fanout],
      %{attempted: attempted, succeeded: succeeded, failed: attempted - succeeded},
      %{}
    )

    :ok
  end

  # ---- Internal ----------------------------------------------------

  defp apply_updates(%{"upload" => upload}) when is_map(upload) do
    Enum.reduce_while(upload, :ok, fn {k, v}, _ -> halt_or_cont(apply_upload_key(k, v)) end)
  end

  defp apply_updates(%{}), do: :ok
  defp apply_updates(_), do: {:error, :bad_request}

  # Per-key dispatch so the surrounding fold stays a 2-line lambda
  # and Credo's cyclomatic-complexity check on `apply_updates/1`
  # stays below the 9 ceiling.
  defp apply_upload_key("active_host", "embedded"), do: ServerSettings.put_upload_active_host(:embedded)
  defp apply_upload_key("active_host", "litterbox"), do: ServerSettings.put_upload_active_host(:litterbox)
  defp apply_upload_key("active_host", _), do: {:error, {:invalid_setting, "upload.active_host"}}

  defp apply_upload_key("per_file_cap_bytes", n) when is_integer(n) and n > 0,
    do: ServerSettings.put_upload_per_file_cap_bytes(n)

  defp apply_upload_key("per_file_cap_bytes", _),
    do: {:error, {:invalid_setting, "upload.per_file_cap_bytes"}}

  defp apply_upload_key("global_cap_bytes", n) when is_integer(n) and n > 0,
    do: ServerSettings.put_upload_global_cap_bytes(n)

  defp apply_upload_key("global_cap_bytes", _),
    do: {:error, {:invalid_setting, "upload.global_cap_bytes"}}

  # Unknown key — ignore but log at warning level. Tolerant of
  # forward-compat shapes cic might send when an admin opens an
  # older deploy, while still discoverable when an admin typos
  # `globalcap_bytes` and wonders why nothing changed
  # (per `feedback_no_silent_drops_closed` — silent acceptance
  # absorbs the next class of bug).
  defp apply_upload_key(k, _) do
    Logger.warning("admin PUT /settings: unknown upload key", setting_key: k)
    :ok
  end

  # Translate per-key return to Enum.reduce_while continuation. `:ok`
  # → continue; `{:error, _}` → halt with the error preserved.
  defp halt_or_cont(:ok), do: {:cont, :ok}
  defp halt_or_cont({:error, _} = err), do: {:halt, err}

  defp render_view(%{upload: upload}) do
    %{upload: SettingsWire.upload_view(upload)}
  end
end
