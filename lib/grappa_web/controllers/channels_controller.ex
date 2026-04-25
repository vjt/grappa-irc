defmodule GrappaWeb.ChannelsController do
  @moduledoc """
  Upstream JOIN / PART surface. Routes through the per-(user, network)
  `Grappa.Session.Server` to send the IRC command on the live socket.

  Phase 1 hardcodes the user to `"vjt"`. Phase 2 replaces the lookup
  with the authenticated client identity.

  Both endpoints require an active session for the network — without
  one, `Grappa.Session.send_*` returns `{:error, :no_session}` which
  the `FallbackController` maps to a 404 with `error: "no session"`.
  Channel-membership tracking + persistence of JOIN/PART events lands
  in Phase 5; for now these are pure upstream-fire-and-confirm.
  """
  use GrappaWeb, :controller

  alias Grappa.Session

  @doc """
  `POST /networks/:network_id/channels` — body `{"name": "#chan"}`.
  Casts `JOIN <name>` upstream through the session. Returns 202 +
  `{"ok": true}`.
  """
  @spec create(Plug.Conn.t(), map()) ::
          Plug.Conn.t() | {:error, :bad_request | :no_session}
  def create(conn, %{"network_id" => network, "name" => name})
      when is_binary(name) and name != "" do
    with :ok <- Session.send_join(Session.placeholder_user(), network, name) do
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
  @spec delete(Plug.Conn.t(), map()) :: Plug.Conn.t() | {:error, :no_session}
  def delete(conn, %{"network_id" => network, "channel_id" => channel}) do
    with :ok <- Session.send_part(Session.placeholder_user(), network, channel) do
      conn
      |> put_status(:accepted)
      |> json(%{ok: true})
    end
  end
end
