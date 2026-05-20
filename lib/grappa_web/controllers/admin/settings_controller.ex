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

  On success: 200 with the new full settings view. The
  `Grappa.ServerSettings.put_*/1` accessors broadcast
  `:server_settings_changed` on `Grappa.ServerSettings.topic/0`;
  the `GrappaWeb.ServerSettingsBroadcaster` (B1 commit 7) fans the
  message out to cic sockets so reactive UI updates without a poll.
  """

  use GrappaWeb, :controller

  alias Grappa.ServerSettings

  @doc false
  @spec index(Plug.Conn.t(), map()) :: Plug.Conn.t()
  def index(conn, _) do
    json(conn, %{settings: render_view(ServerSettings.public_view())})
  end

  @doc false
  @spec update(Plug.Conn.t(), map()) :: Plug.Conn.t() | {:error, atom() | Ecto.Changeset.t()}
  def update(conn, params) do
    with :ok <- apply_updates(params) do
      json(conn, %{settings: render_view(ServerSettings.public_view())})
    end
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

  # Unknown key — ignore. Tolerant of forward-compat shapes cic might
  # send when an admin opens an older deploy.
  defp apply_upload_key(_, _), do: :ok

  # Translate per-key return to Enum.reduce_while continuation. `:ok`
  # → continue; `{:error, _}` → halt with the error preserved.
  defp halt_or_cont(:ok), do: {:cont, :ok}
  defp halt_or_cont({:error, _} = err), do: {:halt, err}

  defp render_view(%{upload: upload}) do
    %{
      upload: %{
        active_host: Atom.to_string(upload.active_host),
        per_file_cap_bytes: upload.per_file_cap_bytes,
        global_cap_bytes: upload.global_cap_bytes
      }
    }
  end
end
