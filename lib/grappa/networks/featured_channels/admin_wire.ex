defmodule Grappa.Networks.FeaturedChannels.AdminWire do
  @moduledoc """
  Admin JSON shape for a `Grappa.Networks.FeaturedChannel` row, scoped
  under `/admin/networks/:network_id/featured_channels`. Mirrors
  `Grappa.Networks.Servers.AdminWire`.

  Codegen-visible: #428 widened the walk to `**/*wire.ex`, so this
  module is emitted like any `wire.ex` one and cic's
  `AdminFeaturedChannel` is a plain alias to the generated
  `NetworksFeaturedChannelsAdminWireT`, not a hand-roll.
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

  @type index_payload :: %{featured_channels: [t()]}

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

  @doc "Wraps the rendered rows as the network's `featured_channels` index envelope."
  @spec index_payload([t()]) :: index_payload()
  def index_payload(rows) when is_list(rows), do: %{featured_channels: rows}
end
