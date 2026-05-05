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

  @doc """
  Returns `:ok` if `name` is a syntactically valid IRC PRIVMSG target —
  either a channel name (`#`/`&`/`+`/`!` sigil per RFC 2812 §1.3), a
  nick (RFC 2812 §2.3.1), or the Grappa-internal synthetic `"$server"`
  pseudo-target used for the server-messages window.

  `"$server"` is not a real IRC target — it is a Grappa-internal name
  written by `Grappa.Session.Server` when persisting server NOTICEs,
  MOTD lines, and other messages without an explicit channel context.
  The synthetic must be accepted here so `loadInitialScrollback` REST
  fetch succeeds for the Server window in cicchetto.

  Used by `MessagesController` (GET + POST) so that DM scrollback fetch and
  DM send work without a separate REST route. `ChannelsController` keeps
  `validate_channel_name/1` because JOIN/PART/TOPIC are channel-only IRC ops.
  """
  @spec validate_target_name(String.t()) :: :ok | {:error, :bad_request}
  def validate_target_name("$server"), do: :ok

  def validate_target_name(name) do
    if Identifier.valid_channel?(name) or Identifier.valid_nick?(name),
      do: :ok,
      else: {:error, :bad_request}
  end
end
