defmodule GrappaWeb.ThemesController do
  @moduledoc """
  REST surface for `Grappa.Themes` — the customizable/shareable theme gallery
  (#75). Every route is behind `[:api, :authn]`.

      GET    /themes               gallery (published + built-ins)   :index
      GET    /me/themes            the caller's owned library         :mine
      GET    /themes/unpublished   admin: stranded built-ins (#299)   :unpublished
      GET    /themes/:id           one theme (public read by id)      :show
      POST   /themes               create (rate-limited)              :create
      PATCH  /themes/:id           edit (owner|admin)                 :update
      DELETE /themes/:id           delete (owner|admin)               :delete
      POST   /themes/:id/publish   publish (owner|admin)              :publish
      POST   /themes/:id/unpublish unpublish (owner|admin)            :unpublish
      POST   /themes/:id/copy      copy into my account (rate-limited):copy
      POST   /themes/background    upload|url → re-hosted image slug  :background
      GET    /themes/backgrounds   built-in background catalog        :backgrounds

  ## Thin controller, thick context

  Actions parse params, call `Grappa.Themes`, and render the context-owned wire
  shape via `Grappa.Themes.Wire.to_wire/2` inline (no JSON view module). Authz +
  rate-limiting + sanitization all live in the context; the FallbackController
  maps the tagged errors to HTTP.

  ## Two subject shapes

  Authz + the wire's viewer-relative flags need the RICH subject
  (`conn.assigns.current_subject`, carrying `is_admin` + the owner id). The
  background pipeline persists an upload row, so it takes the bare-id subject
  (`Grappa.Subject.from_assigns/1`) that `Grappa.Uploads` scopes on. See the #75
  fork-3 decision.
  """

  use GrappaWeb, :controller

  alias Grappa.{Subject, Themes}
  alias Grappa.Themes.Wire

  @doc false
  @spec index(Plug.Conn.t(), map()) :: Plug.Conn.t()
  def index(conn, _) do
    viewer = conn.assigns.current_subject
    json(conn, %{themes: Enum.map(Themes.list_gallery(), &Wire.to_wire(&1, viewer))})
  end

  @doc false
  @spec mine(Plug.Conn.t(), map()) :: Plug.Conn.t()
  def mine(conn, _) do
    viewer = conn.assigns.current_subject
    json(conn, %{themes: Enum.map(Themes.list_owned(viewer), &Wire.to_wire(&1, viewer))})
  end

  @doc false
  @spec unpublished(Plug.Conn.t(), map()) :: Plug.Conn.t()
  def unpublished(conn, _) do
    viewer = conn.assigns.current_subject

    json(conn, %{
      themes: Enum.map(Themes.list_unpublished_builtins(viewer), &Wire.to_wire(&1, viewer))
    })
  end

  @doc false
  @spec show(Plug.Conn.t(), map()) :: Plug.Conn.t() | {:error, :not_found}
  def show(conn, %{"id" => id}) do
    viewer = conn.assigns.current_subject

    with {:ok, theme_id} <- parse_id(id),
         {:ok, theme} <- Themes.get_theme(theme_id) do
      json(conn, Wire.to_wire(theme, viewer))
    end
  end

  @doc false
  @spec create(Plug.Conn.t(), map()) ::
          Plug.Conn.t() | {:error, :rate_limited | :theme_cap_reached | Ecto.Changeset.t()}
  def create(conn, params) do
    viewer = conn.assigns.current_subject

    with {:ok, theme} <- Themes.create_theme(viewer, theme_attrs(params)) do
      render_theme(conn, :created, theme.id, viewer)
    end
  end

  @doc false
  @spec update(Plug.Conn.t(), map()) ::
          Plug.Conn.t() | {:error, :not_found | :forbidden | Ecto.Changeset.t()}
  def update(conn, %{"id" => id} = params) do
    viewer = conn.assigns.current_subject

    with {:ok, theme_id} <- parse_id(id),
         {:ok, theme} <- Themes.update_theme(viewer, theme_id, theme_attrs(params)) do
      render_theme(conn, :ok, theme.id, viewer)
    end
  end

  @doc false
  @spec delete(Plug.Conn.t(), map()) :: Plug.Conn.t() | {:error, :not_found | :forbidden}
  def delete(conn, %{"id" => id}) do
    viewer = conn.assigns.current_subject

    with {:ok, theme_id} <- parse_id(id),
         :ok <- Themes.delete_theme(viewer, theme_id) do
      send_resp(conn, :no_content, "")
    end
  end

  @doc false
  @spec publish(Plug.Conn.t(), map()) :: Plug.Conn.t() | {:error, :not_found | :forbidden}
  def publish(conn, %{"id" => id}), do: set_published(conn, id, &Themes.publish_theme/2)

  @doc false
  @spec unpublish(Plug.Conn.t(), map()) :: Plug.Conn.t() | {:error, :not_found | :forbidden}
  def unpublish(conn, %{"id" => id}), do: set_published(conn, id, &Themes.unpublish_theme/2)

  @doc false
  @spec copy(Plug.Conn.t(), map()) ::
          Plug.Conn.t() | {:error, :not_found | :rate_limited | :theme_cap_reached}
  def copy(conn, %{"id" => id}) do
    viewer = conn.assigns.current_subject

    with {:ok, theme_id} <- parse_id(id),
         {:ok, theme} <- Themes.copy_theme(viewer, theme_id) do
      render_theme(conn, :created, theme.id, viewer)
    end
  end

  @doc false
  @spec backgrounds(Plug.Conn.t(), map()) :: Plug.Conn.t()
  def backgrounds(conn, _) do
    json(conn, %{backgrounds: Themes.builtin_backgrounds()})
  end

  @doc false
  @spec background(Plug.Conn.t(), map()) ::
          Plug.Conn.t()
          | {:error, :bad_request | :not_raster | :too_large | :ssrf_blocked | :fetch_failed | :image_reencode_failed}
  def background(conn, %{"file" => %Plug.Upload{} = upload}) do
    store_background(conn, {:upload, upload})
  end

  def background(conn, %{"url" => url}) when is_binary(url) do
    store_background(conn, {:url, url})
  end

  def background(_, _), do: {:error, :bad_request}

  ## Internals

  defp store_background(conn, source) do
    subject = Subject.from_assigns(conn.assigns)

    with {:ok, slug} <- Themes.store_background(subject, source) do
      json(conn, %{image_id: slug})
    end
  end

  defp set_published(conn, id, fun) do
    viewer = conn.assigns.current_subject

    with {:ok, theme_id} <- parse_id(id),
         {:ok, theme} <- fun.(viewer, theme_id) do
      render_theme(conn, :ok, theme.id, viewer)
    end
  end

  # Re-fetch to preload :user (context write functions don't preload it) so the
  # wire's `author` + `built_in` are available. The theme was just written in
  # this request, so the read is guaranteed to hit.
  defp render_theme(conn, status, id, viewer) do
    {:ok, theme} = Themes.get_theme(id)
    conn |> put_status(status) |> json(Wire.to_wire(theme, viewer))
  end

  # Controller attrs MUST be atom-keyed (`%{name:, payload:}`) — the context does
  # `Subject.put_subject_id(attrs, …)` (which `Map.put`s `:user_id`/`:visitor_id`),
  # and a mixed string+atom map crashes `Ecto.Changeset.cast`. The payload VALUE
  # stays string-keyed (`"colors"` …).
  defp theme_attrs(params) do
    for {k, v} <- Map.take(params, ["name", "payload"]),
        into: %{},
        do: {String.to_existing_atom(k), v}
  end

  # URL path params arrive as strings; a non-integer id is a miss, not a 500.
  defp parse_id(id) when is_binary(id) do
    case Integer.parse(id) do
      {n, ""} -> {:ok, n}
      _ -> {:error, :not_found}
    end
  end
end
