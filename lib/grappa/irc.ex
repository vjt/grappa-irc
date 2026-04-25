defmodule Grappa.IRC do
  @moduledoc """
  IRC protocol layer.

  Owns the line parser (`Grappa.IRC.Parser`), the parsed message struct
  (`Grappa.IRC.Message`), the GenServer-owned upstream client
  (`Grappa.IRC.Client`), and identifier validators
  (`Grappa.IRC.Identifier`). Phase 6's IRCv3 listener facade reuses the
  same parser + message struct for downstream PWA-client reads, so the
  module set is intentionally factored as a reusable library — see the
  `project_extract_irc_libs` memory for the eventual extraction plan.

  This module exists to host the `Boundary` annotation for the IRC
  namespace; it has no runtime API of its own.
  """

  use Boundary, top_level?: true, deps: [], exports: [Client, Identifier, Message]
end
