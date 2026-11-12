defmodule GrappaWeb.ArchiveJSON do
  @moduledoc """
  Wire shape: `%{archive: [%{target, kind, last_activity}]}`,
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

  issue 2428 adds a second, much smaller shape on the same resource:
  `%{count: n}` for ONE window, the number `/clear`'s confirm names.
  """

  alias Grappa.Scrollback.Wire

  @doc "Render the per-network archive list."
  @spec index(%{archive: [Grappa.Scrollback.archive_entry()]}) :: Wire.archive_wire_index()
  def index(%{archive: entries}), do: Wire.archive_index(entries)

  @doc """
  Render the per-window row count (issue 2428) — `%{count: n}`, the number
  the `/clear` confirm names before it drops the window's scrollback.
  Delegated to `Wire.archive_count/1` like `index/1` above, so the shape
  lives beside the typespec `mix grappa.gen_wire_types` reads.
  """
  @spec count(%{count: non_neg_integer()}) :: Wire.archive_wire_count()
  def count(%{count: count}), do: Wire.archive_count(count)
end
