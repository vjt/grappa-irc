defmodule Grappa.ChannelDirectory.Wire do
  @moduledoc """
  Wire shape for the channel-directory REST resource. The `entries`
  are already plain maps from `ChannelDirectory.list/3`; this owns the
  outer envelope (`status` atom passed through — Jason stringifies at the
  JSON edge — DateTime->ISO8601 `captured_at`).
  Same convention as `Grappa.QueryWindows.Wire`.
  """
  alias Grappa.ChannelDirectory
  alias Grappa.IRC.Identifier

  @type entry :: %{
          name: String.t(),
          topic: String.t() | nil,
          user_count: integer(),
          featured: boolean()
        }

  @type index_payload :: %{
          entries: [entry()],
          next_cursor: String.t() | nil,
          total: non_neg_integer(),
          captured_at: String.t() | nil,
          status: ChannelDirectory.status()
        }

  @doc """
  Render a `ChannelDirectory.page()` to the JSON wire envelope. The
  `status` atom (`:fresh | :stale | :empty | :refreshing`) passes
  through UNCHANGED — Jason stringifies it at the JSON edge (identical
  bytes to the former `Atom.to_string/1`), so the typed contract keeps
  the closed `ChannelDirectory.status()` union and
  `mix grappa.gen_wire_types` pins the literal TS union instead of a
  bare `string` (S14 convention — see `Grappa.Scrollback.Wire`).
  `captured_at` renders to ISO-8601. Each entry is marked
  `featured: true` when its
  ASCII-folded name is in `featured_names` — the network's enabled
  `network_featured_channels` set (GH #85). Directory names are stored
  VERBATIM (case-preserving display), the featured set canonical, so the
  compare MUST fold the directory name via `Identifier.canonical_target/1`
  (#364/#525 — a bare `String.downcase` would Unicode-over-fold non-ASCII
  like `#CAFÉ` and diverge from the ASCII-only stored set; brackets
  `[ ] \ ~` are NOT folded, so `#foo[1]` and `#foo{1}` are DISTINCT
  featured entries per CASEMAPPING=ascii). Sort order is unchanged.
  """
  @spec index_payload(ChannelDirectory.page(), MapSet.t(String.t())) :: index_payload()
  def index_payload(%{captured_at: ca, status: status} = page, featured_names)
      when status in [:fresh, :stale, :empty, :refreshing] do
    %{
      entries: Enum.map(page.entries, &mark_featured(&1, featured_names)),
      next_cursor: page.next_cursor,
      total: page.total,
      captured_at: ca && DateTime.to_iso8601(ca),
      status: status
    }
  end

  defp mark_featured(entry, featured_names) do
    featured? = MapSet.member?(featured_names, Identifier.canonical_target(entry.name))
    Map.put(entry, :featured, featured?)
  end
end
