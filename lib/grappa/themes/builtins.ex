defmodule Grappa.Themes.Builtins do
  @moduledoc """
  The curated built-in theme gallery (#75 fork-2): ~12 hand-picked schemes
  written directly into the closed token model. Materialised into the DB as
  system-owned, published themes by `mix grappa.seed_themes`.

  Fork-2 (vjt authoritative): built-ins are CURATED, not parsed from the irssi
  `.theme` corpus (a separate follow-up). Each entry is a `%{name, payload}` map
  whose payload is ALREADY canonical — every hex lowercase 6-digit, opacity a
  float — so `Grappa.Themes.TokenModel.sanitize/1` is the identity on it (the
  `builtins_test` pins this; a mis-authored palette fails there, not in prod).

  The palette shape per theme: 11 base color tokens + 16 nick colors
  (`nick_0..15`) + `font_family` (all `mono-default` — the self-hosted font set
  ships in a later cic sub-task) + a default background (`image_id: nil`,
  `opacity: 0.3`).
  """

  alias Grappa.Themes.TokenModel

  @type builtin :: %{name: String.t(), payload: TokenModel.token_map()}

  @doc "The curated built-in schemes, in gallery-display order."
  @spec all() :: [builtin()]
  def all do
    [
      %{name: "irssi-dark", payload: payload(TokenModel.default_colors())},
      %{
        name: "mirc-light",
        payload:
          payload(
            colors(
              %{
                "bg" => "#ffffff",
                "bg_alt" => "#f5f5f5",
                "fg" => "#000000",
                "accent" => "#00007f",
                "muted" => "#7f7f7f",
                "border" => "#c0c0c0",
                "mention" => "#fff8c0",
                "mode_op" => "#7f0000",
                "mode_halfop" => "#7f5f00",
                "mode_voiced" => "#007f00",
                "mode_plain" => "#000000"
              },
              ~w(#c03030 #c06020 #a07000 #607000 #207020 #008060 #007080 #005090
                 #2030a0 #5020a0 #800070 #a02060 #804020 #404040 #206040 #806020)
            )
          )
      },
      %{
        name: "solarized-dark",
        payload:
          payload(
            colors(
              %{
                "bg" => "#002b36",
                "bg_alt" => "#073642",
                "fg" => "#839496",
                "accent" => "#268bd2",
                "muted" => "#586e75",
                "border" => "#094f5c",
                "mention" => "#164450",
                "mode_op" => "#dc322f",
                "mode_halfop" => "#b58900",
                "mode_voiced" => "#859900",
                "mode_plain" => "#839496"
              },
              ~w(#dc322f #cb4b16 #b58900 #859900 #2aa198 #268bd2 #6c71c4 #d33682
                 #e07a70 #d79a4b #b0c060 #6fc0a8 #74b0e0 #9a8fd0 #d777b0 #93a1a1)
            )
          )
      },
      %{
        name: "solarized-light",
        payload:
          payload(
            colors(
              %{
                "bg" => "#fdf6e3",
                "bg_alt" => "#eee8d5",
                "fg" => "#657b83",
                "accent" => "#268bd2",
                "muted" => "#93a1a1",
                "border" => "#ddd6c1",
                "mention" => "#fbefc8",
                "mode_op" => "#dc322f",
                "mode_halfop" => "#b58900",
                "mode_voiced" => "#859900",
                "mode_plain" => "#657b83"
              },
              ~w(#dc322f #cb4b16 #b58900 #859900 #2aa198 #268bd2 #6c71c4 #d33682
                 #a03030 #a0601a #7a8500 #1a8a80 #1a7ac0 #5a50b0 #b02a70 #586e75)
            )
          )
      },
      %{
        name: "gruvbox-dark",
        payload:
          payload(
            colors(
              %{
                "bg" => "#282828",
                "bg_alt" => "#3c3836",
                "fg" => "#ebdbb2",
                "accent" => "#83a598",
                "muted" => "#928374",
                "border" => "#504945",
                "mention" => "#3c3021",
                "mode_op" => "#fb4934",
                "mode_halfop" => "#fabd2f",
                "mode_voiced" => "#b8bb26",
                "mode_plain" => "#ebdbb2"
              },
              ~w(#fb4934 #fe8019 #fabd2f #b8bb26 #8ec07c #83a598 #d3869b #d65d0e
                 #cc241d #d79921 #98971a #689d6a #458588 #b16286 #a89984 #ebdbb2)
            )
          )
      },
      %{
        name: "gruvbox-light",
        payload:
          payload(
            colors(
              %{
                "bg" => "#fbf1c7",
                "bg_alt" => "#ebdbb2",
                "fg" => "#3c3836",
                "accent" => "#076678",
                "muted" => "#928374",
                "border" => "#d5c4a1",
                "mention" => "#f2e5bc",
                "mode_op" => "#9d0006",
                "mode_halfop" => "#b57614",
                "mode_voiced" => "#79740e",
                "mode_plain" => "#3c3836"
              },
              ~w(#9d0006 #af3a03 #b57614 #79740e #427b58 #076678 #8f3f71 #d65d0e
                 #cc241d #d79921 #98971a #689d6a #458588 #b16286 #7c6f64 #504945)
            )
          )
      },
      %{
        name: "nord",
        payload:
          payload(
            colors(
              %{
                "bg" => "#2e3440",
                "bg_alt" => "#3b4252",
                "fg" => "#d8dee9",
                "accent" => "#88c0d0",
                "muted" => "#616e88",
                "border" => "#434c5e",
                "mention" => "#3b4a52",
                "mode_op" => "#bf616a",
                "mode_halfop" => "#ebcb8b",
                "mode_voiced" => "#a3be8c",
                "mode_plain" => "#d8dee9"
              },
              ~w(#bf616a #d08770 #ebcb8b #a3be8c #8fbcbb #88c0d0 #81a1c1 #b48ead
                 #e0a0a8 #e0b090 #d8c090 #b0d0a0 #90cfe0 #a0b0d0 #c0a0d0 #eceff4)
            )
          )
      },
      %{
        name: "dracula",
        payload:
          payload(
            colors(
              %{
                "bg" => "#282a36",
                "bg_alt" => "#343746",
                "fg" => "#f8f8f2",
                "accent" => "#bd93f9",
                "muted" => "#6272a4",
                "border" => "#44475a",
                "mention" => "#3a3d4d",
                "mode_op" => "#ff5555",
                "mode_halfop" => "#f1fa8c",
                "mode_voiced" => "#50fa7b",
                "mode_plain" => "#f8f8f2"
              },
              ~w(#ff5555 #ffb86c #f1fa8c #50fa7b #8be9fd #bd93f9 #ff79c6 #ff6e6e
                 #ffa07a #e0d070 #a0e0b0 #79e0e0 #a0b0f0 #d0a0f0 #ff9ad0 #f8f8f2)
            )
          )
      },
      %{
        name: "monokai",
        payload:
          payload(
            colors(
              %{
                "bg" => "#272822",
                "bg_alt" => "#3e3d32",
                "fg" => "#f8f8f2",
                "accent" => "#66d9ef",
                "muted" => "#75715e",
                "border" => "#49483e",
                "mention" => "#3a3a2a",
                "mode_op" => "#f92672",
                "mode_halfop" => "#e6db74",
                "mode_voiced" => "#a6e22e",
                "mode_plain" => "#f8f8f2"
              },
              ~w(#f92672 #fd971f #e6db74 #a6e22e #a1efe4 #66d9ef #ae81ff #f45c8b
                 #f0a060 #e0d070 #b0e060 #80e0d0 #80c0f0 #c090f0 #f070b0 #f8f8f2)
            )
          )
      },
      %{
        name: "tokyo-night",
        payload:
          payload(
            colors(
              %{
                "bg" => "#1a1b26",
                "bg_alt" => "#24283b",
                "fg" => "#c0caf5",
                "accent" => "#7aa2f7",
                "muted" => "#565f89",
                "border" => "#292e42",
                "mention" => "#2a2f45",
                "mode_op" => "#f7768e",
                "mode_halfop" => "#e0af68",
                "mode_voiced" => "#9ece6a",
                "mode_plain" => "#c0caf5"
              },
              ~w(#f7768e #ff9e64 #e0af68 #9ece6a #73daca #7aa2f7 #bb9af7 #7dcfff
                 #f0808f #f0a878 #e0c080 #90d0a0 #a0b0f0 #c0a0f0 #90d8f0 #c0caf5)
            )
          )
      },
      %{
        name: "catppuccin-mocha",
        payload:
          payload(
            colors(
              %{
                "bg" => "#1e1e2e",
                "bg_alt" => "#313244",
                "fg" => "#cdd6f4",
                "accent" => "#89b4fa",
                "muted" => "#6c7086",
                "border" => "#45475a",
                "mention" => "#302d41",
                "mode_op" => "#f38ba8",
                "mode_halfop" => "#f9e2af",
                "mode_voiced" => "#a6e3a1",
                "mode_plain" => "#cdd6f4"
              },
              ~w(#f38ba8 #fab387 #f9e2af #a6e3a1 #94e2d5 #89b4fa #cba6f7 #f5c2e7
                 #eba0ac #f2cdcd #f5e0dc #b4befe #89dceb #74c7ec #b4a0e0 #cdd6f4)
            )
          )
      },
      %{
        name: "one-dark",
        payload:
          payload(
            colors(
              %{
                "bg" => "#282c34",
                "bg_alt" => "#21252b",
                "fg" => "#abb2bf",
                "accent" => "#61afef",
                "muted" => "#5c6370",
                "border" => "#3b4048",
                "mention" => "#2c313a",
                "mode_op" => "#e06c75",
                "mode_halfop" => "#e5c07b",
                "mode_voiced" => "#98c379",
                "mode_plain" => "#abb2bf"
              },
              ~w(#e06c75 #d19a66 #e5c07b #98c379 #56b6c2 #61afef #c678dd #be5046
                 #e0808a #e0b080 #d0b090 #a0d090 #70c0d0 #80b0f0 #d090e0 #abb2bf)
            )
          )
      }
    ]
  end

  # 11 base tokens + 16 nick colors → the full 27-key color map. The guards make
  # a mis-authored palette (wrong base count / nick count) a loud
  # FunctionClauseError caught by the builtins_test, not a silent invalid theme.
  defp colors(base, nicks) when map_size(base) == 11 and length(nicks) == 16 do
    nicks
    |> Enum.with_index()
    |> Enum.reduce(base, fn {hex, i}, acc -> Map.put(acc, "nick_#{i}", hex) end)
  end

  # Wrap a 27-key color map into a full canonical token payload.
  defp payload(colors) do
    %{
      "colors" => colors,
      "font_family" => "mono-default",
      "background" => %{"image_id" => nil, "opacity" => 0.3}
    }
  end
end
