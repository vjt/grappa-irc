defmodule GrappaWeb.MessagesJSON do
  @moduledoc """
  Phoenix view layer for `Grappa.Scrollback.Message` rows.

  Thin web-layer adapter: `index/1` and `show/1` follow Phoenix's
  render-function naming convention and delegate to
  `Grappa.Scrollback.Wire.to_json/1` — the single source of truth for
  the public JSON wire shape.

  Per CLAUDE.md "no leaky abstractions: each context owns its
  domain. Return domain types" — wire shape is a domain concern (the
  same shape ships over REST, PubSub broadcasts, Phoenix Channel
  pushes, and the eventual Phase 6 IRCv3 `CHATHISTORY` listener
  facade). It lives in `Grappa.Scrollback.Wire`, not here.
  """

  alias Grappa.Scrollback.{Message, Wire}

  @doc "Renders the `:index` action — a flat JSON array of message maps."
  @spec index(%{messages: [Message.t()]}) :: [Wire.t()]
  def index(%{messages: messages}), do: Enum.map(messages, &Wire.to_json/1)

  @doc "Renders the `:show` action — a single serialized message map."
  @spec show(%{message: Message.t()}) :: Wire.t()
  def show(%{message: message}), do: Wire.to_json(message)
end
