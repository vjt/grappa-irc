defmodule Grappa.IRC do
  @moduledoc """
  IRC protocol layer.

  Owns the line parser (`Grappa.IRC.Parser`), the parsed message struct
  (`Grappa.IRC.Message`), the GenServer-owned upstream client
  (`Grappa.IRC.Client`), the pure auth state machine
  (`Grappa.IRC.AuthFSM`), and identifier validators
  (`Grappa.IRC.Identifier`). Phase 6's IRCv3 listener facade reuses the
  parser + message struct directly and reuses the AuthFSM SHAPE (pure
  FSM with `(state, [iodata])` step contract) for a peer
  server-side registration FSM. The module set is intentionally
  factored as a reusable library — see the `project_extract_irc_libs`
  memory for the eventual extraction plan.

  This module exists to host the `Boundary` annotation for the IRC
  namespace; it has no runtime API of its own.
  """

  use Boundary, top_level?: true, deps: [], exports: [AuthFSM, Client, Identifier, Message]
end
