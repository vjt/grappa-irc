defmodule Grappa.E2ePairing.Wire do
  @moduledoc """
  The wire shape of `Grappa.E2ePairing` (grappa-irc#2430, X1): the REST
  bodies of `GrappaWeb.E2ePairingController` and the two user-topic
  events. A payload is relayed as the opaque string it arrived as, and
  only over REST.
  """
  alias Grappa.E2ePairing.{Message, Rendezvous}

  @type side :: :creator | :joiner
  @type close_reason :: :closed | :expired | :replaced

  @type rendezvous :: %{
          required(:id) => String.t(),
          required(:role) => side(),
          required(:expires_at) => String.t()
        }

  @type message :: %{
          required(:seq) => pos_integer(),
          required(:from) => side(),
          required(:payload) => String.t()
        }

  @typedoc "The body of `POST /e2e/pairings` and of `POST .../join`."
  @type rendezvous_response :: %{rendezvous: rendezvous()}

  @typedoc "The body of `POST /e2e/pairings/:id/messages`."
  @type message_response :: %{message: message()}

  @typedoc "The body of `GET /e2e/pairings/:id/messages`: the other side's, oldest first."
  @type messages_response :: %{messages: [message()]}

  @typedoc """
  A side posted message `seq`, pushed on the subject's user topic. A
  doorbell only: the payload is fetched over REST, which answers the two
  sides alone, while the push reaches every device of the account.
  """
  @type e2e_pairing_message_payload :: %{
          kind: :e2e_pairing_message,
          rendezvous_id: String.t(),
          seq: pos_integer(),
          from: side()
        }

  @typedoc "A rendezvous closed by a side, expired, or replaced by a newer open."
  @type e2e_pairing_closed_payload :: %{
          kind: :e2e_pairing_closed,
          rendezvous_id: String.t(),
          reason: close_reason()
        }

  @doc "The `{rendezvous}` body of an open or a join, naming the caller's side."
  @spec rendezvous_response(Rendezvous.t(), side()) :: rendezvous_response()
  def rendezvous_response(%Rendezvous{} = r, role) when role in [:creator, :joiner],
    do: %{rendezvous: %{id: r.id, role: role, expires_at: DateTime.to_iso8601(r.expires_at)}}

  @doc "The `{message}` body of a post."
  @spec message_response(Message.t()) :: message_response()
  def message_response(%Message{} = m), do: %{message: message(m)}

  @doc "The `{messages}` body of a fetch, in `seq` order."
  @spec messages_response([Message.t()]) :: messages_response()
  def messages_response(msgs) when is_list(msgs), do: %{messages: Enum.map(msgs, &message/1)}

  defp message(%Message{} = m), do: %{seq: m.seq, from: m.from, payload: m.payload}

  @doc "The user-topic doorbell for a posted message. No payload: the fetch answers the two sides only."
  @spec message_payload(String.t(), Message.t()) :: e2e_pairing_message_payload()
  def message_payload(id, %Message{} = m),
    do: %{kind: :e2e_pairing_message, rendezvous_id: id, seq: m.seq, from: m.from}

  @doc "The user-topic push for a rendezvous that is gone, with why."
  @spec closed_payload(String.t(), close_reason()) :: e2e_pairing_closed_payload()
  def closed_payload(id, reason) when reason in [:closed, :expired, :replaced],
    do: %{kind: :e2e_pairing_closed, rendezvous_id: id, reason: reason}
end
