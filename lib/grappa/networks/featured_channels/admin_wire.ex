defmodule Grappa.Networks.FeaturedChannels.AdminWire do
  @moduledoc """
  Admin JSON shape for a `Grappa.Networks.FeaturedChannel` row, scoped
  under `/admin/networks/:network_id/featured_channels`. Mirrors
  `Grappa.Networks.Servers.AdminWire`. Not a `wire.ex` file → not
  emitted by `mix grappa.gen_wire_types`; the cic mirror is the
  hand-rolled `AdminFeaturedChannel` in `api.ts`.
  """
  alias Grappa.Networks.FeaturedChannel

  @type t :: %{
          id: integer(),
          network_id: integer(),
          name: String.t(),
          description: String.t() | nil,
          position: integer(),
          enabled: boolean(),
          inserted_at: DateTime.t(),
          updated_at: DateTime.t()
        }

  @doc "Renders a featured-channel row to the admin JSON shape."
  @spec featured_channel_to_admin_json(FeaturedChannel.t()) :: t()
  def featured_channel_to_admin_json(%FeaturedChannel{} = fc) do
    %{
      id: fc.id,
      network_id: fc.network_id,
      name: fc.name,
      description: fc.description,
      position: fc.position,
      enabled: fc.enabled,
      inserted_at: fc.inserted_at,
      updated_at: fc.updated_at
    }
  end
end
