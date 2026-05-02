defmodule GrappaWeb.NickController do
  @moduledoc """
  `POST /networks/:network_id/nick` — change the operator's nick on the
  upstream IRC connection.

  Iso boundary: `Plugs.ResolveNetwork` collapses unknown-slug /
  not-your-network to 404 BEFORE this action runs. The `:no_session`
  tag from `Session.send_nick/3` collapses to the same 404 wire body
  via `FallbackController` (S14 oracle close).

  Cluster: P4-1 — backs the `/nick <new>` slash command in cicchetto's
  ComposeBox.
  """
  use GrappaWeb, :controller

  alias Grappa.Session

  @doc """
  `POST /networks/:network_id/nick` — body `{"nick": "newname"}`. Sends
  `NICK <new>` upstream through the session. Returns 202 + `{"ok": true}`.
  Empty / non-string nick → 400. `:no_session` / `:invalid_line` collapse
  through `FallbackController` to 404 / 400 respectively.
  """
  @spec create(Plug.Conn.t(), map()) ::
          Plug.Conn.t() | {:error, :bad_request | :no_session | :invalid_line}
  def create(conn, %{"nick" => nick}) when is_binary(nick) and nick != "" do
    user_id = conn.assigns.current_user_id
    network = conn.assigns.network

    with :ok <- Session.send_nick({:user, user_id}, network.id, nick) do
      conn
      |> put_status(:accepted)
      |> json(%{ok: true})
    end
  end

  def create(_, _), do: {:error, :bad_request}
end
