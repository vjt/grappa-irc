defmodule GrappaWeb.SessionController do
  @moduledoc """
  Visitor multi-network ACCRETION surface (#211 phase 4c + phase 6).

    * `POST /session/networks` — attach an ADDITIONAL `visitor_enabled`
      network to the authenticated visitor identity + spawn its upstream
      session. The identity stays ONE `%Visitor{}` spanning both
      networks (NOT a new visitor row).

  ## #211 phase 6 — the disconnect ⇄ reconnect pair is RETIRED

  The `#126` `POST /session/{disconnect,reconnect}` verbs are GONE.
  Visitors now carry a real per-network `connection_state` (ruling D),
  so they park/reconnect each network through the SAME
  `PATCH /networks/:network_id {connection_state}` users do — visitors
  are equal to users on the connection-state surface. A global
  disconnect-all is composed client-side (park each attached network),
  mirroring the user `quit.ts` quit-all. The singular
  `resolve_network_id/1` scalar reader died with the retired verbs.

  ## Accretion is anon-allowed (ruling C, follow-up 2)

  `POST /session/networks` is gated by `require_visitor/1` — ANY visitor
  (anon or registered) may one-tap connect an available network from the
  home page (still bounded by the `visitor_enabled` allowlist + the #171
  per-IP cap inside `accrete_network/3`). Pre-phase-6 this was
  registered-visitor-only; ruling C relaxes it: "always reduce the
  friction for visitors to get on irc."
  """
  use GrappaWeb, :controller

  alias Grappa.Visitors
  alias Grappa.Visitors.Visitor

  @doc """
  `POST /session/networks` — visitor only (anon OR registered). #211
  phase 4c ACCRETION, phase-6-relaxed: attach an ADDITIONAL
  `visitor_enabled` network to the authenticated visitor identity and
  spawn its upstream session. Body: `{"network": "<slug>"}`.

  204 on success; 400 if the `network` param is missing/blank; 403 for a
  non-visitor (user) subject; the accretion / admission / spawn error
  atoms flow through `FallbackController` (403 network_not_visitor_enabled,
  409 already_attached, 503 cap/circuit, 502 upstream, etc.).

  The cic home-page "connect available network" affordance drives this.
  """
  @spec add_network(Plug.Conn.t(), map()) ::
          Plug.Conn.t()
          | {:error, :forbidden | :bad_request | :network_not_visitor_enabled | term()}
  def add_network(conn, %{"network" => slug}) when is_binary(slug) and slug != "" do
    with {:ok, visitor} <- require_visitor(conn),
         {:ok, _} <-
           Visitors.accrete_network(visitor, slug, GrappaWeb.RemoteIP.format(conn)) do
      send_resp(conn, :no_content, "")
    end
  end

  def add_network(_, _), do: {:error, :bad_request}

  # ---------------------------------------------------------------------------
  # Private helpers
  # ---------------------------------------------------------------------------

  # #211 phase 6 — accretion is anon-allowed (ruling C follow-up 2): any
  # visitor subject passes. A USER subject gets 403 — users bind networks
  # via the operator credential surface, not this visitor accretion door.
  # The `visitor_enabled` allowlist + per-IP cap inside `accrete_network/3`
  # remain the abuse gate. (Retired: the pre-phase-6
  # `require_registered_visitor/1` gate, which the disconnect/reconnect
  # pair also used before those verbs were removed.)
  @spec require_visitor(Plug.Conn.t()) :: {:ok, Visitor.t()} | {:error, :forbidden}
  defp require_visitor(%{assigns: %{current_subject: {:visitor, %Visitor{} = visitor}}}),
    do: {:ok, visitor}

  defp require_visitor(_), do: {:error, :forbidden}
end
