defmodule Grappa.Scrollback.Wire do
  @moduledoc """
  Single source of truth for the public wire shape of
  `Grappa.Scrollback.Message` rows + the broadcast event that wraps
  them.

  Three doors emit this contract today: REST (`MessagesJSON`),
  PubSub (`MessagesController` + `Session.Server` broadcasts), and
  Phoenix.Channel pushes (consumed verbatim by `GrappaChannel`).
  Phase 6 IRCv3 `CHATHISTORY` listener will be the fourth — different
  serializer (IRC bytes, not JSON) but same domain event. Centralising
  the shape here separates "data" (`Scrollback.Message` schema) from
  "verb" (this module's `to_json/1` and `message_payload/1`).

  ## Phase 2 sub-task 2e — wire-shape changes

    * The wire emits the network **slug** (string) under key
      `:network`, NOT the integer `network_id` FK. Callers must
      preload `:network` on the message before calling `to_json/1`;
      the function pattern-matches and crashes loudly if the assoc
      is unloaded — invariant violation worth crashing on, per
      CLAUDE.md "let it crash."
    * The wire does NOT carry `user_id` (decision G3). The user
      identity is a topic discriminator (in the PubSub topic string
      and the channel join URL), not a payload field — the client
      already knows who it is from `/me`. Leaking user_id into the
      payload would also cross the per-user iso boundary.

  Adding a field to a Message row that should appear on the wire =
  one edit here. Removing a field = breaking change visible at this
  one site.
  """

  alias Grappa.Networks.Network
  alias Grappa.Scrollback.{Message, Meta}

  @type t :: %{
          id: integer(),
          network: String.t(),
          channel: String.t(),
          server_time: integer(),
          kind: Message.kind(),
          sender: String.t(),
          body: String.t() | nil,
          meta: Meta.t()
        }

  @type event :: %{kind: :message, message: t()}

  @doc """
  Renders a `Grappa.Scrollback.Message` row to its public JSON wire
  shape. The `:network` association MUST be preloaded — pattern match
  fails loudly otherwise. Adding a field to the wire requires
  extending the schema first, then this function and `t/0`.
  """
  @spec to_json(Message.t()) :: t()
  def to_json(%Message{network: %Network{slug: slug}} = m) do
    %{
      id: m.id,
      network: slug,
      channel: m.channel,
      server_time: m.server_time,
      kind: m.kind,
      sender: m.sender,
      body: m.body,
      meta: m.meta
    }
  end

  @doc """
  Wraps a `Message` row as the canonical broadcast event payload —
  the inner map of the `"event"` push delivered to cicchetto via
  `GrappaWeb.GrappaChannel`.

  Use this with `Grappa.PubSub.broadcast_event/2`:

      Grappa.PubSub.broadcast_event(topic, Wire.message_payload(message))

  The caller is responsible for preloading `:network` before calling.

  Renamed from `message_event/1` (which returned the legacy `{:event,
  payload}` tuple shape used with raw `Phoenix.PubSub.broadcast/3`)
  when BUG 6 forced a switch to the framework-native fastlane path.
  See `Grappa.PubSub.broadcast_event/2` for the new broadcast surface.
  """
  @spec message_payload(Message.t()) :: event()
  def message_payload(%Message{} = m) do
    %{kind: :message, message: to_json(m)}
  end
end
