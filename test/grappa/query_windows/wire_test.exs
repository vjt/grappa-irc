defmodule Grappa.QueryWindows.WireTest do
  @moduledoc """
  Tests for `Grappa.QueryWindows.Wire` — single source of truth for the
  per-window wire shape AND the `query_windows_list` event envelope
  pushed on `Topic.user/1` (broadcast on every `open/4` / `close/4` and
  on the GrappaChannel after_join snapshot).

  The envelope helper exists so the broadcast site, the channel push
  site, and any future cold-snapshot caller share one Jason-encodable
  shape; bucket Z (H-Z1 carry-forward) lifted three inlined sites onto
  this helper.
  """
  use ExUnit.Case, async: true

  alias Grappa.QueryWindows.Wire

  describe "render/1" do
    test "renders %Window{} to the snake_case wire entry" do
      opened = ~U[2026-05-12 12:34:56Z]

      window = %Grappa.QueryWindows.Window{
        network_id: 7,
        target_nick: "Alice",
        opened_at: opened
      }

      assert Wire.render(window) == %{
               network_id: 7,
               target_nick: "Alice",
               opened_at: DateTime.to_iso8601(opened)
             }
    end
  end

  describe "render_grouped/1" do
    test "preserves integer keys and renders each entry" do
      opened = ~U[2026-05-12 12:34:56Z]

      grouped = %{
        7 => [
          %Grappa.QueryWindows.Window{network_id: 7, target_nick: "a", opened_at: opened}
        ],
        9 => []
      }

      assert Wire.render_grouped(grouped) == %{
               7 => [%{network_id: 7, target_nick: "a", opened_at: DateTime.to_iso8601(opened)}],
               9 => []
             }
    end

    test "empty input returns empty map" do
      assert Wire.render_grouped(%{}) == %{}
    end
  end

  describe "windows_list_payload/1" do
    test "wraps a windows_map in the canonical %{kind, windows} envelope" do
      windows = %{1 => [%{network_id: 1, target_nick: "x", opened_at: "2026-05-12T00:00:00Z"}]}

      assert Wire.windows_list_payload(windows) == %{
               kind: "query_windows_list",
               windows: windows
             }
    end

    test "kind is always the string literal 'query_windows_list'" do
      assert Wire.windows_list_payload(%{}).kind == "query_windows_list"
    end

    test "windows passes through verbatim (no transformation)" do
      windows = %{42 => []}
      assert Wire.windows_list_payload(windows).windows == windows
    end

    test "empty windows map yields a valid envelope" do
      assert Wire.windows_list_payload(%{}) == %{kind: "query_windows_list", windows: %{}}
    end
  end
end
