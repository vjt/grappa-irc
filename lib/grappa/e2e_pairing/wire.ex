defmodule Grappa.E2ePairing.Wire do
  @moduledoc """
  The wire shape of `Grappa.E2ePairing` (grappa-irc#2430, X1): the REST
  bodies of `GrappaWeb.E2ePairingController` and the three user-topic
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
  A rendezvous offered to the account's other devices (issue 2537): the code
  its QR carries (`rendezvous_id` and the creator's ephemeral `curve`), and
  when it ends.
  """
  @type offer :: %{
          required(:rendezvous_id) => String.t(),
          required(:curve) => String.t(),
          required(:expires_at) => String.t()
        }

  @typedoc "The body of `GET /e2e/pairings/offer`: the account's offer, or null."
  @type offer_response :: %{offer: offer() | nil}

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

  @typedoc """
  A rendezvous opened with the creator's key, offered to every device of the
  account (issue 2537). Pushed once, at the open, and again in each
  user-topic join snapshot while nobody has joined it.
  """
  @type e2e_pairing_offered_payload :: %{
          kind: :e2e_pairing_offered,
          rendezvous_id: String.t(),
          curve: String.t(),
          expires_at: String.t()
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

  @doc "The `{offer}` body of `GET /e2e/pairings/offer`."
  @spec offer_response(Rendezvous.t() | nil) :: offer_response()
  def offer_response(nil), do: %{offer: nil}

  def offer_response(%Rendezvous{} = r), do: %{offer: offer(r)}

  @doc "The `{messages}` body of a fetch, in `seq` order."
  @spec messages_response([Message.t()]) :: messages_response()
  def messages_response(msgs) when is_list(msgs), do: %{messages: Enum.map(msgs, &message/1)}

  defp message(%Message{} = m), do: %{seq: m.seq, from: m.from, payload: m.payload}

  @doc "The user-topic doorbell for a posted message. No payload: the fetch answers the two sides only."
  @spec message_payload(String.t(), Message.t()) :: e2e_pairing_message_payload()
  def message_payload(id, %Message{} = m),
    do: %{kind: :e2e_pairing_message, rendezvous_id: id, seq: m.seq, from: m.from}

  @doc "The user-topic push offering a rendezvous opened with the creator's key."
  @spec offered_payload(Rendezvous.t()) :: e2e_pairing_offered_payload()
  def offered_payload(%Rendezvous{} = r), do: Map.put(offer(r), :kind, :e2e_pairing_offered)

  # The one shape of an offer, for the push and the REST body alike. Only a
  # rendezvous opened with a key is one.
  defp offer(%Rendezvous{curve: curve} = r) when is_binary(curve),
    do: %{rendezvous_id: r.id, curve: curve, expires_at: DateTime.to_iso8601(r.expires_at)}

  @doc "The user-topic push for a rendezvous that is gone, with why."
  @spec closed_payload(String.t(), close_reason()) :: e2e_pairing_closed_payload()
  def closed_payload(id, reason) when reason in [:closed, :expired, :replaced],
    do: %{kind: :e2e_pairing_closed, rendezvous_id: id, reason: reason}
end
