defmodule Grappa.IRC.E2e.Fragment do
  @moduledoc """
  One parsed E2E line (issue 2430): which logical message it belongs to
  (`msgid`), where in it it sits (`index` of `total`, 1-based), and its
  slice of the payload's base64 (`chunk`), byte for byte as received.

  Produced by `Grappa.IRC.E2e.parse/1` and consumed by
  `Grappa.Session.E2eReassembly`; it never leaves the server.
  """

  @enforce_keys [:verb, :msgid, :index, :total, :chunk]
  defstruct @enforce_keys

  @type t :: %__MODULE__{
          verb: Grappa.IRC.E2e.verb(),
          msgid: String.t(),
          index: pos_integer(),
          total: pos_integer(),
          chunk: String.t()
        }
end
