defmodule GrappaWeb.ErrorJSON do
  @moduledoc """
  Default JSON error renderer wired through `render_errors` in
  `config/config.exs`. Phoenix invokes `render/2` with the template
  matching the HTTP status (`"404.json"`, `"500.json"`, …); falling
  back to `status_message_from_template/1` keeps responses stable
  even before per-status overrides exist.
  """

  @doc ~S|Renders a JSON error body for the given Phoenix error template (`"404.json"`, `"500.json"`, …).|
  @spec render(String.t(), map()) :: %{errors: %{detail: String.t()}}
  def render(template, _) do
    %{errors: %{detail: Phoenix.Controller.status_message_from_template(template)}}
  end
end
