defmodule GrappaWeb.MeThemeController do
  @moduledoc """
  The subject's ACTIVE theme — a server-persisted, per-subject pointer (#75
  fork-1, cross-device). Behind `[:api, :authn]`.

      GET /me/theme   resolved active-theme wire, or JSON `null`   :show
      PUT /me/theme   set the active theme id                       :update

  `GET` returns the fully-resolved theme wire (not a scalar id) so the client
  applies it directly; `null` means "no theme chosen / pointer dangling" and cic
  falls back to its own default look. Distinct from `GrappaWeb.ThemesController`
  because active-theme selection is a `UserSettings`-backed pointer, not a theme
  resource CRUD op — same split as `MeController` vs the resource controllers.
  """

  use GrappaWeb, :controller

  alias Grappa.{Subject, Themes}
  alias Grappa.Themes.Wire

  @doc false
  @spec show(Plug.Conn.t(), map()) :: Plug.Conn.t()
  def show(conn, _) do
    viewer = conn.assigns.current_subject
    subject = Subject.from_assigns(conn.assigns)

    case Themes.get_active_theme(subject) do
      nil -> json(conn, nil)
      theme -> json(conn, Wire.to_wire(theme, viewer, Themes.count_theme_usage(theme.id)))
    end
  end

  @doc false
  @spec update(Plug.Conn.t(), map()) ::
          Plug.Conn.t() | {:error, :bad_request | :not_found | Ecto.Changeset.t()}
  def update(conn, %{"id" => id}) do
    viewer = conn.assigns.current_subject
    subject = Subject.from_assigns(conn.assigns)

    with {:ok, theme_id} <- parse_id(id),
         {:ok, theme} <- Themes.set_active_theme(subject, theme_id) do
      # set_active_theme returns the theme via get_theme/1, which preloads :user.
      json(conn, Wire.to_wire(theme, viewer, Themes.count_theme_usage(theme.id)))
    end
  end

  def update(_, _), do: {:error, :bad_request}

  defp parse_id(id) when is_integer(id), do: {:ok, id}

  defp parse_id(id) when is_binary(id) do
    case Integer.parse(id) do
      {n, ""} -> {:ok, n}
      _ -> {:error, :not_found}
    end
  end
end
