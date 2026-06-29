defmodule GrappaWeb.SessionController do
  @moduledoc """
  #126 — visitor session-disposition surface: the `disconnect` ⇄
  `reconnect` verb pair (drop the upstream IRC connection but KEEP the
  cic/web session open; reconnect restores it).

    * `POST /session/disconnect` — tear the upstream down via the shared
      `Visitors.disconnect_session/2` (→ `Session.stop_session/3`). The
      visitor row + scrollback + the bearer survive.
    * `POST /session/reconnect` — respawn the upstream via the shared
      `Visitors.reconnect_session/3` (→ `SpawnOrchestrator.spawn/4`).

  ## Subject scoping (persistent-identity-only)

  Both verbs are gated to a **registered (NickServ-identified) visitor**
  (`password_encrypted` non-nil) via `require_registered_visitor/1`.
  Everyone else gets 403:

    * a **user** disconnects/reconnects PER NETWORK through the existing
      `PATCH /networks/:network_id {connection_state}` surface — the
      whole-session verb here would be ambiguous across their many
      networks;
    * an **anon visitor** has no persistent identity to come back to, so
      its only teardown verb is `quit` (= `DELETE /auth/logout`, which
      stops + purges in its anon branch).

  This mirrors `NetworksController`'s `require_user_subject/1` gate from
  the other side: there, visitors are rejected; here, users + anon
  visitors are. Server-side defense-in-depth — cic also gates the
  buttons by subject kind, but the boundary refuses regardless.

  Quit for a registered visitor is NOT a verb here: the client composes
  it from `disconnect` (this controller) + `detach` (`DELETE
  /auth/logout`). One teardown core, every door.
  """
  use GrappaWeb, :controller

  alias Grappa.{Networks, Visitors}
  alias Grappa.Visitors.Visitor

  @doc """
  `POST /session/disconnect` — registered visitor only. Drops the
  upstream IRC connection, keeps the row + web session. 204 on success;
  403 for any non-registered-visitor subject.
  """
  @spec disconnect(Plug.Conn.t(), map()) ::
          Plug.Conn.t() | {:error, :forbidden | :not_found}
  def disconnect(conn, _params) do
    with {:ok, visitor} <- require_registered_visitor(conn),
         {:ok, network_id} <- resolve_network_id(visitor) do
      :ok = Visitors.disconnect_session(visitor, network_id)
      send_resp(conn, :no_content, "")
    end
  end

  @doc """
  `POST /session/reconnect` — registered visitor only. Respawns the
  upstream IRC session. 204 on success; 403 for any non-registered
  -visitor subject; the admission / spawn failure atoms flow through
  `FallbackController` (503 cap/circuit, 502 upstream, etc.).
  """
  @spec reconnect(Plug.Conn.t(), map()) ::
          Plug.Conn.t() | {:error, :forbidden | :not_found | :resolve_failed | term()}
  def reconnect(conn, _params) do
    with {:ok, visitor} <- require_registered_visitor(conn),
         {:ok, network_id} <- resolve_network_id(visitor),
         {:ok, _pid} <-
           Visitors.reconnect_session(visitor, network_id, capacity_input(conn, visitor, network_id)) do
      send_resp(conn, :no_content, "")
    end
  end

  # ---------------------------------------------------------------------------
  # Private helpers
  # ---------------------------------------------------------------------------

  @spec require_registered_visitor(Plug.Conn.t()) :: {:ok, Visitor.t()} | {:error, :forbidden}
  defp require_registered_visitor(%{
         assigns: %{current_subject: {:visitor, %Visitor{password_encrypted: pwd} = visitor}}
       })
       when not is_nil(pwd),
       do: {:ok, visitor}

  defp require_registered_visitor(_), do: {:error, :forbidden}

  @spec resolve_network_id(Visitor.t()) :: {:ok, integer()} | {:error, :not_found}
  defp resolve_network_id(%Visitor{network_slug: slug}) do
    case Networks.get_network_by_slug(slug) do
      {:ok, %Networks.Network{id: id}} -> {:ok, id}
      {:error, :not_found} -> {:error, :not_found}
    end
  end

  # Mirror of `NetworksController.orchestrate_spawn/4`'s capacity_input,
  # with the visitor-flow discriminant. `requesting_subject` is the
  # visitor itself so `Admission.check_client_cap`'s self-exclusion keeps
  # the visitor's own live browser session from counting against the cap
  # on the reconnect respawn (same rationale as the user PATCH /connect).
  @spec capacity_input(Plug.Conn.t(), Visitor.t(), integer()) :: Grappa.Admission.capacity_input()
  defp capacity_input(conn, %Visitor{id: id}, network_id) do
    %{
      network_id: network_id,
      client_id: conn.assigns[:current_client_id],
      flow: :visitor_reconnect,
      requesting_subject: {:visitor, id}
    }
  end
end
