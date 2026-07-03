defmodule Grappa.Networks.AdminWire do
  @moduledoc """
  Operator-facing JSON wire shape for `Grappa.Networks.Network` rows
  (M-cluster M-5 `GET /admin/networks`, `PATCH /admin/networks/:slug`).
  Sibling to `Grappa.Networks.Wire`, which serves cic + auth-facing
  surfaces.

  ## Why two wire modules

  `Networks.Wire` exposes per-(user, network) credential context (nick,
  connection_state) — the user-facing view. The admin console's view
  of a network is operator-facing: caps + (composed at the
  controller) circuit state. Splitting AdminWire from Wire keeps the
  public Wire's contract tight (a future cic feature wanting network
  caps would be a deliberate edit, not a side-effect of reusing admin
  shape). Same pattern as
  `Grappa.Visitors.AdminWire` ↔ `Grappa.Visitors.Wire`.

  ## Boundary note

  This module projects ONLY Network row fields. The M-5 controller
  (`GrappaWeb.Admin.NetworksController`) composes the result with
  `Grappa.Admission.NetworkCircuit.AdminWire.entry_to_admin_json/2`
  under a `circuit_state` key. The composition lives at the
  controller — not here — because a `Networks → Admission` reference
  would form a boundary cycle with the existing `Admission → Networks`
  edge (`Admission.check_capacity/1` reads `Network.max_*` caps). The
  `GrappaWeb` boundary already deps both, so composition there is
  cycle-free.
  """

  alias Grappa.Networks.Network

  @type t :: %{
          id: integer(),
          slug: String.t(),
          max_concurrent_visitor_sessions: non_neg_integer() | nil,
          max_concurrent_user_sessions: non_neg_integer() | nil,
          max_per_ip: non_neg_integer() | nil,
          inserted_at: DateTime.t(),
          updated_at: DateTime.t()
        }

  @doc """
  Render a Network row to the admin JSON shape. Controller composes
  the result with `circuit_state:` from
  `Grappa.Admission.NetworkCircuit.AdminWire`.
  """
  @spec network_to_admin_json(Network.t()) :: t()
  def network_to_admin_json(%Network{} = net) do
    %{
      id: net.id,
      slug: net.slug,
      max_concurrent_visitor_sessions: net.max_concurrent_visitor_sessions,
      max_concurrent_user_sessions: net.max_concurrent_user_sessions,
      max_per_ip: net.max_per_ip,
      inserted_at: net.inserted_at,
      updated_at: net.updated_at
    }
  end
end
