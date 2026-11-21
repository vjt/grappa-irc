defmodule GrappaWeb.ArchiveJSON do
  @moduledoc """
  Wire shape: `%{archive: [%{target, kind, last_activity}]}`,
  with `kind` (`:channel | :query`) atom-stringified at the wire
  boundary so cic doesn't see Elixir-specific values. The per-window
  count door (issue 2428) renders `%{target, kind, count}` instead,
  with the three-way kind (`:channel | :query | :server`) — same
  atom-through convention, one more value the archive listing never
  carries.

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

  @doc "Render one window's row count (issue 2428 — the `/clear` confirm modal)."
  @spec count(%{
          target: String.t(),
          kind: Grappa.Scrollback.window_kind(),
          count: non_neg_integer()
        }) :: Wire.archive_count()
  def count(%{target: target, kind: kind, count: count}),
    do: Wire.archive_count(target, kind, count)
end
