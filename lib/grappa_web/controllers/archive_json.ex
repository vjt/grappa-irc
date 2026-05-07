defmodule GrappaWeb.ArchiveJSON do
  @moduledoc """
  Wire shape: `%{"archive" => [%{"target", "kind", "last_activity",
  "row_count"}]}`. `kind` atom is stringified at the boundary
  (`:channel | :query` → `"channel" | "query"`) so cic doesn't see
  Elixir-specific values.

  Sort order is fixed at the `Scrollback.list_archive/3` boundary
  (`last_activity` DESC); this view is pure pass-through.
  """

  @doc "Render the per-network archive list."
  @spec index(%{archive: [Grappa.Scrollback.archive_entry()]}) :: %{
          required(String.t()) => [%{required(String.t()) => term()}]
        }
  def index(%{archive: entries}) do
    %{
      "archive" =>
        Enum.map(entries, fn %{
                               target: target,
                               kind: kind,
                               last_activity: last_activity,
                               row_count: row_count
                             } ->
          %{
            "target" => target,
            "kind" => Atom.to_string(kind),
            "last_activity" => last_activity,
            "row_count" => row_count
          }
        end)
    }
  end
end
