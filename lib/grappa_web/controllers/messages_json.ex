defmodule GrappaWeb.MessagesJSON do
  @moduledoc """
  Renders `Grappa.Scrollback.Message` rows for the JSON surface.

  `kind` round-trips as a string (`:privmsg` → `"privmsg"`) via Jason's
  default atom-to-string encoding; the schema's atom shape stays inside
  the BEAM.

  `server_time` is serialized as the raw epoch-millisecond integer the
  schema stores. Clients (cicchetto, the Phase 6 IRCv3 listener facade)
  convert to their preferred wire format — the public contract is
  "monotonic milliseconds since epoch."

  Field set is the public contract — adding fields is additive,
  removing or renaming is a breaking change for any client.
  """

  alias Grappa.Scrollback.Message

  @doc "Renders the `:index` action — a flat JSON array of message maps."
  @spec index(%{messages: [Message.t()]}) :: [map()]
  def index(%{messages: messages}), do: Enum.map(messages, &data/1)

  defp data(%Message{} = m) do
    %{
      id: m.id,
      network_id: m.network_id,
      channel: m.channel,
      server_time: m.server_time,
      kind: m.kind,
      sender: m.sender,
      body: m.body
    }
  end
end
