defmodule Grappa.E2ePairing.Rendezvous do
  @moduledoc """
  One pairing rendezvous (`Grappa.E2ePairing`): its subject, the auth
  session of each side, its messages, newest first, and its deadline on
  both clocks (monotonic for the timer, wall-clock for the wire).
  """
  alias Grappa.E2ePairing.{Message, Wire}
  alias Grappa.Subject

  @enforce_keys [:id, :subject, :topic_label, :creator, :expires_at, :expires_at_ms]
  defstruct [:id, :subject, :topic_label, :creator, :expires_at, :expires_at_ms, joiner: nil, messages: [], bytes: 0]

  @type side :: Wire.side()

  @type t :: %__MODULE__{
          id: String.t(),
          subject: Subject.t(),
          topic_label: String.t(),
          creator: String.t(),
          joiner: String.t() | nil,
          expires_at: DateTime.t(),
          expires_at_ms: integer(),
          messages: [Message.t()],
          bytes: non_neg_integer()
        }

  @doc "A fresh rendezvous with a random 128-bit id, url-safe base64 (22 characters)."
  @spec new(Subject.t(), String.t(), String.t(), pos_integer()) :: t()
  def new(subject, topic_label, creator, ttl_ms) do
    %__MODULE__{
      id: Base.url_encode64(:crypto.strong_rand_bytes(16), padding: false),
      subject: subject,
      topic_label: topic_label,
      creator: creator,
      expires_at: DateTime.add(DateTime.utc_now(), ttl_ms, :millisecond),
      expires_at_ms: System.monotonic_time(:millisecond) + ttl_ms
    }
  end

  @doc "The side `session_id` holds in `r`, or nil."
  @spec role(t(), String.t()) :: side() | nil
  def role(%__MODULE__{creator: session_id}, session_id), do: :creator
  def role(%__MODULE__{joiner: session_id}, session_id) when is_binary(session_id), do: :joiner
  def role(%__MODULE__{}, _), do: nil
end
