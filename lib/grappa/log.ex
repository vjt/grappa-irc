defmodule Grappa.Log do
  @moduledoc """
  Canonical Logger metadata schema for Grappa.

  Phase 1 emits text-formatted logs with structured-KV metadata
  (`user=vjt network=azzurra command=privmsg ...`). Phase 5 hardening
  swaps to a JSON formatter alongside PromEx; the metadata keys do not
  change.

  ## Session context

  Every log line emitted from inside a `Grappa.Session.Server` (and its
  linked `Grappa.IRC.Client`) carries the per-session pair:

      user=<user_name> network=<network_id>

  Set once at session init via `set_session_context/2`; thereafter all
  Logger calls in that process inherit it via `Logger.metadata/0`.

  ## Per-log metadata

  Additional keys may appear on individual `Logger.info/2` etc. calls
  (e.g. `command:`, `channel:`, `sender:`, `target:`, `error:`,
  `reason:`). The full allowlist lives in `config/config.exs` —
  metadata keys NOT in that list are silently dropped by the logger
  formatter. Adding a new metadata key requires extending the
  allowlist; the architecture review's A18 follow-up tracks automating
  this.

  ## Why a helper

  Three modules (`Grappa.Session.Server`, `Grappa.IRC.Client`,
  `Grappa.Bootstrap`) used to build the same `[user: ..., network: ...]`
  keyword list inline. Centralising in one helper makes the schema
  greppable, and is the place to extend if Phase 5 adds e.g. a
  `:request_id` correlation field.
  """

  require Logger

  @type session_metadata :: [user: String.t(), network: String.t()]

  @doc """
  Returns the canonical session-context keyword list — `[user: u,
  network: n]`. Use this whenever you need to pass the context as data
  (e.g. as a `start_link` opt to a child process that will install it
  via `set_session_context/2`).
  """
  @spec session_context(String.t(), String.t()) :: session_metadata()
  def session_context(user, network) when is_binary(user) and is_binary(network) do
    [user: user, network: network]
  end

  @doc """
  Installs the session context as the calling process's Logger
  metadata. Subsequent `Logger.info/2` etc. calls in this process
  carry `user=...` and `network=...` automatically.
  """
  @spec set_session_context(String.t(), String.t()) :: :ok
  def set_session_context(user, network) do
    Logger.metadata(session_context(user, network))
  end
end
