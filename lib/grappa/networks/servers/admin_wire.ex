defmodule Grappa.Networks.Servers.AdminWire do
  @moduledoc """
  Operator-facing JSON wire shape for `Grappa.Networks.Server` rows
  (admin-panel bucket 1 — `POST/PUT/DELETE /admin/networks/:nid/servers[/:id]`).
  Sibling to `Grappa.Networks.AdminWire`; standalone module so future
  fail-over-policy fields (decision F follow-up, weighted picker, etc.)
  land here in one cohesive surface instead of growing the network wire.

  Servers carry NO secrets, but the projection still goes through an
  explicit per-field map: adding a Server schema field is a deliberate
  edit here per CLAUDE.md "no leaky abstractions" — a wildcard
  `Map.take/2` would auto-expose any future field (think `cookie_secret`,
  `ircop_pass`) the moment the schema gained it.
  """
  alias Grappa.Networks.Server

  @type t :: %{
          id: integer(),
          network_id: integer(),
          host: String.t(),
          port: :inet.port_number(),
          tls: boolean(),
          priority: integer(),
          enabled: boolean(),
          inserted_at: DateTime.t(),
          updated_at: DateTime.t()
        }

  @doc """
  Renders a Server row to the admin JSON shape. The `:network`
  preloaded association is intentionally NOT projected — it would leak
  the network's caps + slug into every server payload; callers that
  need that shape go through `Grappa.Networks.AdminWire`.
  """
  @spec server_to_admin_json(Server.t()) :: t()
  def server_to_admin_json(%Server{} = server) do
    %{
      id: server.id,
      network_id: server.network_id,
      host: server.host,
      port: server.port,
      tls: server.tls,
      priority: server.priority,
      enabled: server.enabled,
      inserted_at: server.inserted_at,
      updated_at: server.updated_at
    }
  end
end
