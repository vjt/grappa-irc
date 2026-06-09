defmodule GrappaWeb.ServerSettingsController do
  @moduledoc """
  Operator-visible subset of `Grappa.ServerSettings`. Behind `:authn`
  — visitor OR user subject required; admin gate NOT applied (every
  operator needs to read the active upload host to know which form
  to render in ComposeBox).

  ## GET /api/server-settings

  Returns `Grappa.ServerSettings.public_view/0` re-shaped for the
  wire (atoms → strings). Cic boots once per session + on
  WS-pushed `server_settings_changed` event; this endpoint is the
  initial-snapshot path.

      %{
        upload: %{
          active_host: "embedded" | "litterbox",
          image_per_file_cap_bytes: pos_integer(),
          video_per_file_cap_bytes: pos_integer(),
          document_per_file_cap_bytes: pos_integer(),
          global_cap_bytes: pos_integer()
        }
      }
  """

  use GrappaWeb, :controller

  alias Grappa.ServerSettings
  alias Grappa.ServerSettings.Wire, as: SettingsWire

  @doc false
  @spec show(Plug.Conn.t(), map()) :: Plug.Conn.t()
  def show(conn, _) do
    %{upload: u} = ServerSettings.public_view()
    json(conn, %{upload: SettingsWire.upload_view(u)})
  end
end
