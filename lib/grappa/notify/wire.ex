defmodule Grappa.Notify.Wire do
  @moduledoc """
  Single source of truth for the public wire shape of
  `Grappa.Notify.Entry` rows (GH #247).

  Two doors emit this contract: the user-channel snapshot push at
  after_join in `GrappaWeb.GrappaChannel` and the PubSub broadcast
  fired on every `Grappa.Notify` mutation.

  Why a wire module: raw `%Entry{}` structs crash JSON serialization
  at the WS edge during fan-out — same rationale as
  `Grappa.QueryWindows.Wire`; context owns the wire conversion.

  Presence STATE is not part of this shape — the list is DB-owned,
  the online/offline map is session-owned and travels in the separate
  `presence` / `presence_snapshot` events (`Grappa.Session.Wire`).
  """

  alias Grappa.Notify.Entry

  @type entries_map :: %{integer() => [entry()]}

  @type entry :: %{
          required(:network_id) => integer(),
          required(:nick) => String.t(),
          required(:added_at) => String.t()
        }

  @typedoc """
  Full `notify_list` event envelope as pushed on `Topic.user/1` and on
  the per-socket after_join. Call `notify_list_payload/1` rather than
  rolling the map at the broadcast / push site.
  """
  @type notify_list_payload :: %{kind: String.t(), networks: entries_map()}

  @doc """
  Render one `%Entry{}` to the wire shape. `added_at` is normalised to
  ISO-8601 from the row's `inserted_at`.
  """
  @spec render(Entry.t()) :: entry()
  def render(%Entry{} = e) do
    %{
      network_id: e.network_id,
      nick: e.nick,
      added_at: DateTime.to_iso8601(e.inserted_at)
    }
  end

  @doc """
  Render the full per-network grouping returned by
  `Grappa.Notify.list_for_subject/1` to the wire shape.
  """
  @spec render_grouped(%{integer() => [Entry.t()]}) :: entries_map()
  def render_grouped(grouped) when is_map(grouped) do
    Map.new(grouped, fn {network_id, entries} -> {network_id, Enum.map(entries, &render/1)} end)
  end

  @doc """
  Build the `notify_list` event envelope from an already-rendered
  `entries_map/0` (typically the output of `render_grouped/1`).
  """
  @spec notify_list_payload(entries_map()) :: notify_list_payload()
  def notify_list_payload(networks) when is_map(networks) do
    %{kind: "notify_list", networks: networks}
  end
end
