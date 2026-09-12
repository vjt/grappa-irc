defmodule Grappa.IRC do
  @moduledoc """
  IRC protocol layer.

  Owns the line parser (`Grappa.IRC.Parser`), the parsed message struct
  (`Grappa.IRC.Message`), the GenServer-owned upstream client
  (`Grappa.IRC.Client`), the pure auth state machine
  (`Grappa.IRC.AuthFSM`), identifier validators
  (`Grappa.IRC.Identifier`), the shared IRC-registration identity tuple
  validators (`Grappa.IRC.Identity`, #211 phase 2), the measured
  JOIN-failure numeric set (`Grappa.IRC.JoinFailure`, #1345), CTCP
  framing classification (`Grappa.IRC.CTCP`), the pure `DCC SEND` offer
  parser (`Grappa.IRC.DCC`, issue 2089 — wire shape only, no socket and
  no policy), and the mIRC formatting
  projection (`Grappa.IRC.MircFormat`, issue 1908 — the de-formatted view
  of a body, kept in lockstep with cic's `mircFormat.ts`).
  Phase 6's IRCv3 listener facade
  reuses the parser + message struct directly and reuses the AuthFSM
  SHAPE (pure FSM with `(state, [iodata])` step contract) for a peer
  server-side registration FSM. The module set is intentionally
  factored as a reusable library — see the `project_extract_irc_libs`
  memory for the eventual extraction plan.

  This module exists to host the `Boundary` annotation for the IRC
  namespace; it has no runtime API of its own.
  """

  use Boundary,
    top_level?: true,
    deps: [Grappa.OutboundV6Pool],
    exports: [
      AuthFSM,
      Client,
      CTCP,
      # issue 2089 — pure `DCC SEND` offer parsing; no socket, no policy.
      DCC,
      Identifier,
      Identity,
      JoinFailure,
      LineSplit,
      # #162 — nick!user@host glob masks for /ignore
      Mask,
      Message,
      MircFormat
    ]
end
