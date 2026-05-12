defmodule Grappa.QueryWindows.Wire do
  @moduledoc """
  Single source of truth for the public wire shape of
  `Grappa.QueryWindows.Window` rows.

  Two doors emit this contract: the user-channel push at after_join
  in `GrappaWeb.GrappaChannel` and the PubSub broadcast fired on
  every `Grappa.QueryWindows.open/4` / `Grappa.QueryWindows.close/4`.

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

  @typedoc """
  Full `query_windows_list` event envelope as pushed on `Topic.user/1`
  and on the per-socket after_join. The single source of truth for the
  outer `%{kind: "query_windows_list", windows: ...}` shape — call
  `windows_list_payload/1` rather than rolling the map at the
  broadcast / push site.
  """
  @type windows_list_payload :: %{kind: String.t(), windows: windows_map()}

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

  @doc """
  Build the `query_windows_list` event envelope from an already-rendered
  `windows_map/0` (typically the output of `render_grouped/1`).

  Use this instead of inlining `%{kind: "query_windows_list", windows: ...}`
  at every broadcast / push site so the outer envelope stays in one place;
  per CLAUDE.md "Wire conversion is per-context responsibility" + bucket D's
  cross-module/S4 lift of `Cic.Bundle.bundle_hash_payload/1`.
  """
  @spec windows_list_payload(windows_map()) :: windows_list_payload()
  def windows_list_payload(windows) when is_map(windows) do
    %{kind: "query_windows_list", windows: windows}
  end
end
