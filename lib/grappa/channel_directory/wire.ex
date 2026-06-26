defmodule Grappa.ChannelDirectory.Wire do
  @moduledoc """
  Wire shape for the channel-directory REST resource. The `entries`
  are already plain maps from `ChannelDirectory.list/3`; this owns the
  outer envelope (atom->string `status`, DateTime->ISO8601 `captured_at`).
  Same convention as `Grappa.QueryWindows.Wire`.
  """
  alias Grappa.ChannelDirectory

  @type entry :: %{name: String.t(), topic: String.t() | nil, user_count: integer()}

  @type index_payload :: %{
          entries: [entry()],
          next_cursor: String.t() | nil,
          total: non_neg_integer(),
          captured_at: String.t() | nil,
          status: String.t()
        }

  @doc """
  Render a `ChannelDirectory.page()` to the JSON wire envelope, converting the `status` atom to a string and `captured_at` to ISO-8601.
  """
  @spec index_payload(ChannelDirectory.page()) :: index_payload()
  def index_payload(%{captured_at: ca} = page) do
    %{
      entries: page.entries,
      next_cursor: page.next_cursor,
      total: page.total,
      captured_at: ca && DateTime.to_iso8601(ca),
      status: Atom.to_string(page.status)
    }
  end
end
