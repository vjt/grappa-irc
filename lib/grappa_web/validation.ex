defmodule GrappaWeb.Validation do
  @moduledoc """
  Boundary-shape validators shared by the JSON REST controllers.

  These check input *shape* (channel-name well-formedness, etc.) before
  the controller hands the value to a context. They surface as
  `{:error, :bad_request}` so the `FallbackController` returns 400 —
  distinct from the wire-injection guard inside
  `Grappa.IRC.Identifier.safe_line_token?/1` which surfaces as
  `:invalid_line` once the channel name reaches `Grappa.Session`.

  Live here (not in a per-controller `defp`) so both
  `MessagesController` and `ChannelsController` share one definition
  per CLAUDE.md "Implement once, reuse everywhere." Belongs to the
  `GrappaWeb` boundary (no explicit `use Boundary`) — controllers
  import it the same way they import other helpers.
  """

  alias Grappa.IRC.Identifier

  @doc """
  Returns `:ok` if `name` is a syntactically valid IRC channel name
  (`#`/`&`/`+`/`!` sigil + chanstring per RFC 2812 §1.3), else
  `{:error, :bad_request}`.
  """
  @spec validate_channel_name(String.t()) :: :ok | {:error, :bad_request}
  def validate_channel_name(name) do
    if Identifier.valid_channel?(name), do: :ok, else: {:error, :bad_request}
  end
end
