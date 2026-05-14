defmodule GrappaWeb.BodyLimit do
  @moduledoc """
  Boundary-side body-size guard for REST + Channel verbs that thread
  user-supplied text into upstream IRC traffic or the scrollback DB.

  ## Why (no-silent-drops B6.9a HIGH-19)

  Pre-fix, `MessagesController.create/2`, `ChannelsController.topic/2`,
  and the Channel verbs that POST a `body` / `text` / `reason` /
  `modes` field had NO upper bound on the field length. A 1MB request
  body would round-trip through `Session.send_privmsg/4` (or sibling
  verbs) into `IRC.Client.transport_send/2`, where the IRC framing
  layer either truncates silently (RFC 1459 caps a single line at 512
  bytes including framing) or the upstream peer disconnects on the
  oversize line. Either way the UI claimed `:ok` while the message
  never reached its target — a silent drop at the very entrance of
  the streaming surface.

  ## Cap

  Default 4096 bytes per body field — generous so legitimate paste
  workflows + upstream multi-line splitters (Phase 5) keep working,
  but tight enough that pathological clients are rejected at the
  boundary BEFORE Session/Client see them. The cap is operator-
  configurable via:

      config :grappa, :web, max_body_bytes: 8192

  in `config/runtime.exs` for operators that intentionally allow
  larger pastes (with the understanding that upstream framing limits
  still apply downstream).

  Read at COMPILE time per CLAUDE.md `Application.{put,get}_env`
  boundary rule — runtime reads are banned. Operators rebuild the
  image (cold deploy) to change the cap; the recompile cost is
  negligible vs the predictability gain.

  ## Usage

      with :ok <- BodyLimit.check(body),
           {:ok, message} <- Session.send_privmsg(...) do

  Returns `:ok` for in-bounds input, `{:error, :body_too_large}` for
  over-cap input. The error tag flows through `FallbackController` ↦
  413 Payload Too Large with a JSON error envelope so cic can render
  a coherent rejection.

  Bytewise (`byte_size/1`) not graphemewise — the IRC framing layer
  cares about UTF-8 bytes, not user-perceived characters. A
  4-byte emoji counts as 4, not 1.
  """

  use Boundary, top_level?: true, deps: []

  @default_max_body_bytes 4096
  @max_body_bytes Application.compile_env(:grappa, [:web, :max_body_bytes], @default_max_body_bytes)

  @doc """
  Whether `body` is within the configured byte cap. Returns `:ok` for
  in-bounds (or `nil` / non-binary — the upstream verb's own validation
  surfaces those as `:bad_request` / `:invalid_line`), `{:error,
  :body_too_large}` otherwise.
  """
  @spec check(binary() | nil | term()) :: :ok | {:error, :body_too_large}
  def check(body) when is_binary(body) do
    if byte_size(body) > @max_body_bytes do
      {:error, :body_too_large}
    else
      :ok
    end
  end

  def check(_), do: :ok

  @doc false
  @spec max_body_bytes() :: unquote(@max_body_bytes)
  def max_body_bytes, do: @max_body_bytes
end
