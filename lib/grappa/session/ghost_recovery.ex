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

  `:failed` terminal = the visitor stays on `<nick>_` (anon-shape until
  the next session restart).

  A cached password is a PRECONDITION, not a branch: the sole production
  entry point is `Session.Server`'s `:nickserv_identify` 433 arm, guarded
  `when is_binary(pwd)` on the one-shot `state.pending_password`. A 433
  without one is the bounded `Grappa.IRC.AuthFSM` nick ladder's job (#676)
  — this FSM is never armed for it.

  Boundary: inherits the parent `Grappa.Session` boundary — same
  pattern as sibling submodules `Server`, `EventRouter`,
  `NSInterceptor`. No `use Boundary` here.
  """

  alias Grappa.IRC.{Identifier, Message}

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
  Builds an initial FSM state pinned to a given original nick and the
  cached NickServ password the GHOST verb will be issued under.

  The password is REQUIRED. A no-password variant used to exist and was
  reachable only from this module's own test file — the underscore
  fallback for a passwordless 433 belongs to `Grappa.IRC.AuthFSM`'s
  bounded ladder (#676), which is exactly why that ladder skips
  `:nickserv_identify`: a ladder NICK there would race the GHOST
  sequence off its own nick.
  """
  @spec init(String.t(), String.t()) :: t()
  def init(orig_nick, password) when is_binary(orig_nick) and is_binary(password) do
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
        %__MODULE__{phase: :awaiting_ghost_notice, orig_nick: orig} = s,
        %Message{command: :notice, prefix: prefix}
      ) do
    if nickserv?(prefix) do
      {:cont, %{s | phase: :awaiting_whois}, ["WHOIS #{orig}\r\n"]}
    else
      {:cont, s, []}
    end
  end

  # S2 (#364) — the 401/311 echo (`params[1]`) comes from the ghost holder's
  # server-side user record and can differ in case (or bracket-fold) from the
  # configured `orig_nick`. Fold BOTH sides via `Identifier.canonical_nick/1`
  # (GH #121, mirror of `EventRouter.nick_eq?/2`) — a bare `==` guard missed a
  # `kazam`-for-`Kazam` echo, stranding the FSM on the no-op catch-all until
  # the 8s `:ghost_timeout` forced `:failed`. A non-matching queried nick
  # (a stray WHOIS reply for another target) falls through to `{:cont, s, []}`,
  # preserving the "ignore unrelated" behaviour the guards used to give.
  def step(
        %__MODULE__{phase: :awaiting_whois, orig_nick: orig, password: pwd} = s,
        %Message{command: {:numeric, 401}, params: [_, queried | _]}
      ) do
    if nick_match?(queried, orig) do
      {:stop, %{s | phase: :succeeded}, ["NICK #{orig}\r\n", "PRIVMSG NickServ :IDENTIFY #{pwd}\r\n"]}
    else
      {:cont, s, []}
    end
  end

  def step(
        %__MODULE__{phase: :awaiting_whois, orig_nick: orig} = s,
        %Message{command: {:numeric, 311}, params: [_, queried | _]}
      ) do
    if nick_match?(queried, orig) do
      {:stop, %{s | phase: :failed}, []}
    else
      {:cont, s, []}
    end
  end

  def step(%__MODULE__{phase: phase} = s, :timeout)
      when phase in [:idle, :awaiting_ghost_notice, :awaiting_whois] do
    {:stop, %{s | phase: :failed}, []}
  end

  def step(state, _), do: {:cont, state, []}

  defp nickserv?({:nick, nick, _, _}), do: Identifier.canonical_target(nick) == "nickserv"
  defp nickserv?(_), do: false

  # ASCII-folded nick equality (#121/#525) — mirror of EventRouter.nick_eq?/2.
  @spec nick_match?(String.t(), String.t()) :: boolean()
  defp nick_match?(a, b), do: Identifier.canonical_target(a) == Identifier.canonical_target(b)
end
