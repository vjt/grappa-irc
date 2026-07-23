defmodule Grappa.ChannelDirectory.Wire do
  @moduledoc """
  Wire shape for the channel-directory REST resource. The `entries`
  are already plain maps from `ChannelDirectory.list/3`; this owns the
  outer envelope (atom->string `status`, DateTime->ISO8601 `captured_at`).
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
          status: String.t()
        }

  @doc """
  Render a `ChannelDirectory.page()` to the JSON wire envelope,
  converting the `status` atom to a string and `captured_at` to
  ISO-8601. Each entry is marked `featured: true` when its
  rfc1459-folded name is in `featured_names` — the network's enabled
  `network_featured_channels` set (GH #85). Directory names are stored
  VERBATIM (case-preserving display), the featured set canonical, so the
  compare MUST fold the directory name via `Identifier.canonical_channel/1`
  (#364 — a bare `String.downcase` left `#foo[1]` unfolded and missed
  the canonical `#foo{1}` on bahamut). Sort order is unchanged.
  """
  @spec index_payload(ChannelDirectory.page(), MapSet.t(String.t())) :: index_payload()
  def index_payload(%{captured_at: ca} = page, featured_names) do
    %{
      entries: Enum.map(page.entries, &mark_featured(&1, featured_names)),
      next_cursor: page.next_cursor,
      total: page.total,
      captured_at: ca && DateTime.to_iso8601(ca),
      status: Atom.to_string(page.status)
    }
  end

  defp mark_featured(entry, featured_names) do
    featured? = MapSet.member?(featured_names, Identifier.canonical_channel(entry.name))
    Map.put(entry, :featured, featured?)
  end
end
