defmodule Grappa.E2ePairing.Message do
  @moduledoc "One opaque message on a pairing rendezvous: its order, its side, its bytes."
  alias Grappa.E2ePairing.Rendezvous

  @enforce_keys [:seq, :from, :payload]
  defstruct [:seq, :from, :payload]

  @type t :: %__MODULE__{seq: pos_integer(), from: Rendezvous.side(), payload: String.t()}
end
