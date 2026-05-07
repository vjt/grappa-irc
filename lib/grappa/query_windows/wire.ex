defmodule Grappa.QueryWindows.Wire do
  @moduledoc """
  Single source of truth for the public wire shape of
  `Grappa.QueryWindows.Window` rows.

  Two doors emit this contract: the user-channel push at after_join
  (`GrappaWeb.GrappaChannel.push_query_windows_list/2`) and the
  PubSub broadcast fired on every `QueryWindows.open/4` /
  `.close/4` (`Grappa.QueryWindows.broadcast_windows_list/2`).

  Why a wire module: the raw `%Window{}` struct doesn't
  derive `Jason.Encoder`, so JSON serialization at the WS edge
  crashes the channel process when the broadcast fan-out reaches a
  subscriber. Same shape as `Grappa.Scrollback.Wire` and
  `Grappa.Networks.Wire` — context owns the wire conversion;
  controllers + channels delegate.
  """

  alias Grappa.QueryWindows.Window

  @type windows_map :: %{integer() => [windows_entry()]}

  @type windows_entry :: %{
          required(:network_id) => integer(),
          required(:target_nick) => String.t(),
          required(:opened_at) => String.t()
        }

  @doc """
  Render one `%Window{}` to the wire shape.

  `opened_at` is normalised to ISO-8601; the schema stores
  `:utc_datetime` so JSON encoders (DateTime) would otherwise emit
  a less stable shape.
  """
  @spec render(Window.t()) :: windows_entry()
  def render(%Window{} = w) do
    %{
      network_id: w.network_id,
      target_nick: w.target_nick,
      opened_at: DateTime.to_iso8601(w.opened_at)
    }
  end

  @doc """
  Render the full per-network grouping returned by
  `QueryWindows.list_for_user/1` to the wire shape.
  """
  @spec render_grouped(%{integer() => [Window.t()]}) :: windows_map()
  def render_grouped(grouped) when is_map(grouped) do
    Map.new(grouped, fn {network_id, ws} -> {network_id, Enum.map(ws, &render/1)} end)
  end
end
