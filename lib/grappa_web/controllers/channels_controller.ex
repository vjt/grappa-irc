defmodule GrappaWeb.ChannelsController do
  @moduledoc """
  Upstream JOIN / PART surface. Routes through the per-(user, network)
  `Grappa.Session.Server` to send the IRC command on the live socket.

  Sub-task 2g: lookup is keyed by `(conn.assigns.current_user_id,
  network.id)` end-to-end. The URL `:network_id` is a slug; this
  controller resolves it to the integer FK via
  `Networks.get_network_by_slug/1` so the session lookup matches the
  internal registry shape.

  Both endpoints require an active session for the network — without
  one, `Grappa.Session.send_*` returns `{:error, :no_session}` which
  the `FallbackController` maps to a 404 with `error: "no session"`.
  Unknown network slug returns `{:error, :not_found}` → 404 with
  `error: "not found"`. Channel-membership tracking + persistence of
  JOIN/PART events lands in Phase 5; for now these are pure
  upstream-fire-and-confirm.
  """
  use GrappaWeb, :controller

  alias Grappa.{Networks, Session}

  @doc """
  `POST /networks/:network_id/channels` — body `{"name": "#chan"}`.
  Casts `JOIN <name>` upstream through the session. Returns 202 +
  `{"ok": true}`.
  """
  @spec create(Plug.Conn.t(), map()) ::
          Plug.Conn.t() | {:error, :bad_request | :not_found | :no_session}
  def create(conn, %{"network_id" => slug, "name" => name})
      when is_binary(name) and name != "" do
    user_id = conn.assigns.current_user_id

    with {:ok, network} <- Networks.get_network_by_slug(slug),
         :ok <- Session.send_join(user_id, network.id, name) do
      conn
      |> put_status(:accepted)
      |> json(%{ok: true})
    end
  end

  def create(_, %{"network_id" => _}), do: {:error, :bad_request}

  @doc """
  `DELETE /networks/:network_id/channels/:channel_id` — casts
  `PART <channel_id>` upstream. Returns 202 + `{"ok": true}`.
  """
  @spec delete(Plug.Conn.t(), map()) ::
          Plug.Conn.t() | {:error, :not_found | :no_session}
  def delete(conn, %{"network_id" => slug, "channel_id" => channel}) do
    user_id = conn.assigns.current_user_id

    with {:ok, network} <- Networks.get_network_by_slug(slug),
         :ok <- Session.send_part(user_id, network.id, channel) do
      conn
      |> put_status(:accepted)
      |> json(%{ok: true})
    end
  end
end
