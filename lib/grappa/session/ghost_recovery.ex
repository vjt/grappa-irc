defmodule Grappa.Session.GhostRecovery do
  @moduledoc """
  Pure FSM: handles NICK 433 collision recovery on reconnect for
  visitors with a cached NickServ password.

  Mirrors `Grappa.IRC.AuthFSM` shape — pure step function returning
  `{:cont | :stop, state, [iodata]}`. Host (`Grappa.Session.Server`)
  wraps the FSM, owns I/O, applies an 8s timeout via
  `Process.send_after`.

  Flow:

  1. NICK 433 received → if cached pwd, append `_` to nick + send GHOST
     to original nick, transition to `:awaiting_ghost_notice`.
  2. NickServ NOTICE received → send WHOIS on original nick, transition
     to `:awaiting_whois`.
  3. WHOIS 401 (no such nick) for the queried nick → original is gone,
     so `/nick` back + IDENTIFY, transition to `:succeeded`.
  4. WHOIS 311 (still there) for the queried nick → bail, transition
     to `:failed`.
  5. `:timeout` in any non-terminal phase → `:failed`.

  No cached password OR `:failed` terminal = visitor stays on
  `<nick>_` (anon-shape until next session restart).

  Boundary: inherits the parent `Grappa.Session` boundary — same
  pattern as sibling submodules `Server`, `EventRouter`,
  `NSInterceptor`. No `use Boundary` here.
  """

  alias Grappa.IRC.Message

  defstruct phase: :idle, orig_nick: nil, try_nick: nil, password: nil

  @type phase ::
          :idle | :awaiting_ghost_notice | :awaiting_whois | :succeeded | :failed

  @type t :: %__MODULE__{
          phase: phase(),
          orig_nick: String.t() | nil,
          try_nick: String.t() | nil,
          password: String.t() | nil
        }

  @doc """
  Builds an initial FSM state pinned to a given original nick and an
  optional cached NickServ password.

  Anon visitors (no cached password) still get an FSM so a 433 collision
  still drives the underscore-append fallback. Without a password the
  GHOST verb can't be issued, so the FSM transitions straight to
  `:failed` after emitting the underscore NICK.
  """
  @spec init(String.t(), String.t() | nil) :: t()
  def init(orig_nick, password)
      when is_binary(orig_nick) and (is_binary(password) or is_nil(password)) do
    %__MODULE__{phase: :idle, orig_nick: orig_nick, password: password}
  end

  @doc """
  Drives one inbound `Grappa.IRC.Message` (or a `:timeout` tick from
  the host's 8s deadline) through the FSM. Returns `{:cont, state,
  [iodata]}` to continue or `{:stop, state, [iodata]}` to terminate, in
  both cases flushing the optional outbound wire frames the host should
  push through `Grappa.IRC.Client.send_line/2`.

  Inputs that don't match the current phase's expected transitions are
  no-ops (`{:cont, state, []}`). That includes terminal-phase
  passthrough, off-target WHOIS responses, NOTICE from non-NickServ
  sources, and any unrelated PRIVMSG / numeric / etc.
  """
  @spec step(t(), Message.t() | :timeout) ::
          {:cont, t(), [String.t()]} | {:stop, t(), [String.t()]}

  def step(
        %__MODULE__{phase: :idle, orig_nick: orig, password: pwd} = s,
        %Message{command: {:numeric, 433}}
      )
      when is_binary(pwd) do
    try_nick = orig <> "_"

    {:cont, %{s | phase: :awaiting_ghost_notice, try_nick: try_nick},
     ["NICK #{try_nick}\r\n", "PRIVMSG NickServ :GHOST #{orig} #{pwd}\r\n"]}
  end

  def step(
        %__MODULE__{phase: :idle, orig_nick: orig, password: nil} = s,
        %Message{command: {:numeric, 433}}
      ) do
    try_nick = orig <> "_"
    {:stop, %{s | phase: :failed, try_nick: try_nick}, ["NICK #{try_nick}\r\n"]}
  end

  def step(
        %__MODULE__{phase: :awaiting_ghost_notice, orig_nick: orig} = s,
        %Message{command: :notice, prefix: prefix}
      ) do
    if nickserv?(prefix) do
      {:cont, %{s | phase: :awaiting_whois}, ["WHOIS #{orig}\r\n"]}
    else
      {:cont, s, []}
    end
  end

  def step(
        %__MODULE__{phase: :awaiting_whois, orig_nick: orig, password: pwd} = s,
        %Message{command: {:numeric, 401}, params: [_, queried | _]}
      )
      when queried == orig do
    {:stop, %{s | phase: :succeeded}, ["NICK #{orig}\r\n", "PRIVMSG NickServ :IDENTIFY #{pwd}\r\n"]}
  end

  def step(
        %__MODULE__{phase: :awaiting_whois, orig_nick: orig} = s,
        %Message{command: {:numeric, 311}, params: [_, queried | _]}
      )
      when queried == orig do
    {:stop, %{s | phase: :failed}, []}
  end

  def step(%__MODULE__{phase: phase} = s, :timeout)
      when phase in [:idle, :awaiting_ghost_notice, :awaiting_whois] do
    {:stop, %{s | phase: :failed}, []}
  end

  def step(state, _), do: {:cont, state, []}

  defp nickserv?({:nick, nick, _, _}), do: String.downcase(nick) == "nickserv"
  defp nickserv?(_), do: false
end
