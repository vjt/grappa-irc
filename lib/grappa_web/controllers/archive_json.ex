defmodule GrappaWeb.ArchiveJSON do
  @moduledoc """
  Wire shape: `%{archive: [%{target, kind, last_activity, row_count}]}`,
  with `kind` (`:channel | :query`) atom-stringified at the wire
  boundary so cic doesn't see Elixir-specific values.

  Pre-bucket-D this view handcrafted the per-target map inline with
  string keys, duplicating the contract that `Scrollback.list_archive/3`
  produces. Bucket D moved the wire-shape source of truth into
  `Grappa.Scrollback.Wire.archive_index/1` per CLAUDE.md "Wire
  conversion is per-context responsibility" — the controller now
  delegates and contributes only the controller wiring.

  Sort order is fixed at the `Scrollback.list_archive/3` boundary
  (`last_activity` DESC); this view is pure pass-through.
  """

  alias Grappa.Scrollback.Wire

  @doc "Render the per-network archive list."
  @spec index(%{archive: [Grappa.Scrollback.archive_entry()]}) :: Wire.archive_wire_index()
  def index(%{archive: entries}), do: Wire.archive_index(entries)
end
