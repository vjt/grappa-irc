defmodule Grappa.Session.RecoverIdentity do
  @moduledoc """
  Pure FSM: a visitor-triggered "recover my identity" sequence —
  re-take a registered nick after services parked the session on an
  unidentified (non-`+r`) nick. Split from #561 point 4 (GH #581).

  A **sibling** to `Grappa.Session.GhostRecovery`, not a generalisation
  of it (GH #581 architecture ruling A2). GhostRecovery is
  reconnect-triggered, underscore-first, and NickServ-**NOTICE**-driven;
  this FSM is user-triggered, targets the credential nick directly, and
  trusts the `+r` umode ONLY — it never parses a NickServ notice. Shared
  is the *shape* (pure `step/2` returning `{:cont | :stop, state,
  [iodata]}`, host owns I/O + timers), not the state machine.

  ## Ordering is SOURCE-VERIFIED, not assumed (GH #581, 2026-07-31)

  `+r` (`UMODE_r`) is a PER-NICK flag — "the nick you are wearing RIGHT
  NOW is your identified registered nick". bahamut CLEARS it on any
  genuine nick change (`bahamut/src/m_nick.c:594-602`:
  `if (mycmp(old, new)) sptr->umode &= ~UMODE_r;`; the ircd's own comment
  at `include/struct.h:226` says `+r` IS reset on `/nick`, unlike the
  session `FLAGS_REGISTERED`). Azzurra services `do_identify` emits the
  `+r` SVSMODE **only when `sameNick`** — identifying for a protected nick
  while force-renamed to `Guest…` fires a NOTICE but NO `+r`
  (`docs/DESIGN_NOTES.md` 2026-05-xx). `RECOVER`/`RELEASE` reclaim the nick
  (password-authenticated) but do NOT set `+r`; the follow-up `IDENTIFY`
  ON the reclaimed nick is what commits.

  So `+r` cannot arrive while on a Guest nick. You must be ON the
  credential nick AND `IDENTIFY` (sameNick) to get `+r`.

  ## The RECLAIM leg is SEQUENCED, not raced (GH #623, 2026-08-01)

  The reclaim leg (after a held-nick `RECOVER`/`RELEASE`) used to flush
  `NICK` + `IDENTIFY` together, then wait a fixed 800ms and re-flush both
  together. Against real, contended services that races two ways:

    * the `IDENTIFY` is evaluated by services BEFORE the `NICK` change has
      propagated → a foreign-nick (Guest) identify → NOTICE, **no `+r`**
      (the sameNick rule); and
    * the single fixed-800ms re-`NICK` can hit a `433` because `RECOVER`
      freed the hold asynchronously and the hold is not clear YET — a
      one-shot failure with no retry.

  #623 fixes both without inflating any timing constant:

  1. `:idle` → `NICK <cred_nick>` + `IDENTIFY <cred_nick> <secret>`,
     transition `:awaiting_r`. (The INITIAL leg keeps them together: a
     FREE nick lands with no hold to propagate, so the trailing IDENTIFY
     is sameNick.)
  2. `:r_observed` (the `+r` umode landed — fed by the host from
     `EventRouter`'s identity signal, NOT parsed here) → `:succeeded`.
  3. `{:nick_error, 433}` (nick in use) → `RECOVER`; `{:nick_error, 437}`
     (services hold) → `RELEASE`; transition `:awaiting_verb_settle`. (The
     `IDENTIFY` sent in step 1 was a foreign-nick identify — no `+r`, per
     the sameNick rule; it is harmless and re-sent below.)
  4. `:settle` (host's short post-verb settle tick) → `NICK <cred_nick>`
     **ALONE**, transition `:awaiting_nick`. The IDENTIFY is deliberately
     withheld until the nick change is OBSERVED.
  5. `:nick_observed` (the host saw `state.nick` become the credential
     nick) → `IDENTIFY <cred_nick> <secret>` (now provably sameNick),
     transition `:awaiting_final_r`.
  6. `{:nick_error, 433 | 437}` on the re-NICK (`:awaiting_nick`) → the
     hold has not cleared YET → a bounded **RETRY**: transition back to
     `:awaiting_verb_settle` (no line — the host re-arms the settle beat,
     which re-sends the `NICK`). `RECOVER` is NOT re-issued. The loop is
     bounded by the host's overall 15s deadline, NOT this FSM. This
     REVERSES the earlier F2 "one shot, terminal" rule: an empty retry
     never wins the nick, but a re-NICK as an async hold clears does.
  7. `:r_observed` → `:succeeded`.

  ### Terminal legs are DISTINCT + trace-diagnosable (GH #623 pt3)

  `:timeout` (host's overall deadline) in any non-terminal phase →
  `:failed`, phase-appropriate reason:

    * `:awaiting_r` → `:wrong_password` (a clean NICK with no `+r` — the
      IDENTIFY was rejected).
    * `:awaiting_verb_settle` → `:services_declined` (the verb went
      unanswered).
    * `:awaiting_nick` → `:nick_unavailable` (**leg a**: the re-NICK never
      landed — the hold never cleared / services kept renaming us).
    * `:awaiting_final_r` → `:identify_unconfirmed` (**leg b**: the nick
      WAS reclaimed and the sameNick IDENTIFY went out, but `+r` never
      confirmed). Distinct from `:wrong_password` — `RECOVER` already
      password-authenticated, so the password is proven correct.

  Wire lines carry the credential nick **RAW** — its case is
  presentation (the key/display/wire split, GH #121/#537). The FSM emits
  no broadcasts and arms no timers: the host (`Grappa.Session.Server`)
  owns I/O, the overall deadline, the settle tick, the `:nick_observed`
  feed, and the progress broadcasts.

  Boundary: inherits the parent `Grappa.Session` boundary — same pattern
  as sibling submodules `Server`, `EventRouter`, `GhostRecovery`. No `use
  Boundary` here.
  """

  defstruct phase: :idle, cred_nick: nil, secret: nil, verb: nil, reason: nil

  @type phase ::
          :idle
          | :awaiting_r
          | :awaiting_verb_settle
          | :awaiting_nick
          | :awaiting_final_r
          | :succeeded
          | :failed

  @type verb :: :recover | :release | nil

  @type reason ::
          :wrong_password
          | :nick_unavailable
          | :services_declined
          | :identify_unconfirmed
          | nil

  @type input ::
          :start
          | :r_observed
          | {:nick_error, 433 | 437}
          | :settle
          | :nick_observed
          | :timeout

  @type t :: %__MODULE__{
          phase: phase(),
          cred_nick: String.t() | nil,
          secret: String.t() | nil,
          verb: verb(),
          reason: reason()
        }

  @doc """
  Builds an initial FSM pinned to the credential nick to reclaim and the
  NickServ secret to identify with. Both are required — the host gates on
  a recoverable credential (a stored NickServ secret) BEFORE building the
  FSM (#561 pt3: never blind-`IDENTIFY` a nick with no credential).
  """
  @spec init(String.t(), String.t()) :: t()
  def init(cred_nick, secret) when is_binary(cred_nick) and is_binary(secret) do
    %__MODULE__{phase: :idle, cred_nick: cred_nick, secret: secret}
  end

  @doc """
  Drives one semantic input through the FSM. Returns `{:cont, state,
  [lines]}` to continue or `{:stop, state, [lines]}` at a terminal phase;
  `lines` are CRLF-framed IRC strings the host must push via
  `Grappa.IRC.Client.send_line/2` (through `Server.flush_lines/2`, so the
  outbound `IDENTIFY` still stages the `+r` rendezvous).

  Inputs that don't match the current phase's expected transition are
  no-ops (`{:cont, state, []}`), including terminal-phase passthrough.
  """
  @spec step(t(), input()) :: {:cont, t(), [String.t()]} | {:stop, t(), [String.t()]}

  def step(%__MODULE__{phase: :idle} = s, :start) do
    {:cont, %{s | phase: :awaiting_r}, take(s) ++ identify(s)}
  end

  def step(%__MODULE__{phase: :awaiting_r} = s, :r_observed) do
    {:stop, %{s | phase: :succeeded}, []}
  end

  def step(%__MODULE__{phase: :awaiting_r, cred_nick: nick, secret: secret} = s, {:nick_error, 433}) do
    {:cont, %{s | phase: :awaiting_verb_settle, verb: :recover}, ["PRIVMSG NickServ :RECOVER #{nick} #{secret}\r\n"]}
  end

  def step(%__MODULE__{phase: :awaiting_r, cred_nick: nick, secret: secret} = s, {:nick_error, 437}) do
    {:cont, %{s | phase: :awaiting_verb_settle, verb: :release}, ["PRIVMSG NickServ :RELEASE #{nick} #{secret}\r\n"]}
  end

  def step(%__MODULE__{phase: :awaiting_r} = s, :timeout) do
    # NICK succeeded (else we'd have seen 433/437) but `+r` never came →
    # the IDENTIFY was rejected → wrong password.
    {:stop, %{s | phase: :failed, reason: :wrong_password}, []}
  end

  # #623: the settle tick sends the re-NICK ALONE — the IDENTIFY waits for
  # `:nick_observed` so it can never land under the old (Guest) nick.
  def step(%__MODULE__{phase: :awaiting_verb_settle} = s, :settle) do
    {:cont, %{s | phase: :awaiting_nick}, take(s)}
  end

  def step(%__MODULE__{phase: :awaiting_verb_settle} = s, :timeout) do
    {:stop, %{s | phase: :failed, reason: :services_declined}, []}
  end

  # #623: the re-NICK landed AND was observed → we are provably on the
  # credential nick, so this IDENTIFY is sameNick and commits `+r`.
  def step(%__MODULE__{phase: :awaiting_nick} = s, :nick_observed) do
    {:cont, %{s | phase: :awaiting_final_r}, identify(s)}
  end

  # #623: a refused re-NICK means the hold has NOT cleared yet (RECOVER
  # freed it asynchronously). Bounded RETRY — go back to
  # `:awaiting_verb_settle` so the host re-arms the settle beat and
  # re-sends the NICK. No line here (RECOVER is NOT re-issued); the loop is
  # bounded by the host's 15s overall deadline. Reverses F2.
  def step(%__MODULE__{phase: :awaiting_nick} = s, {:nick_error, code}) when code in [433, 437] do
    {:cont, %{s | phase: :awaiting_verb_settle}, []}
  end

  def step(%__MODULE__{phase: :awaiting_nick} = s, :timeout) do
    # leg (a): the re-NICK never landed within the deadline.
    {:stop, %{s | phase: :failed, reason: :nick_unavailable}, []}
  end

  def step(%__MODULE__{phase: :awaiting_final_r} = s, :r_observed) do
    {:stop, %{s | phase: :succeeded}, []}
  end

  def step(%__MODULE__{phase: :awaiting_final_r} = s, :timeout) do
    # leg (b): the nick WAS reclaimed and the sameNick IDENTIFY went out,
    # but `+r` never confirmed. NOT `:wrong_password` — RECOVER already
    # proved the password correct.
    {:stop, %{s | phase: :failed, reason: :identify_unconfirmed}, []}
  end

  def step(state, _), do: {:cont, state, []}

  # NICK to the credential nick. RAW case (key/display/wire split).
  @spec take(t()) :: [String.t()]
  defp take(%__MODULE__{cred_nick: nick}), do: ["NICK #{nick}\r\n"]

  # IDENTIFY for the credential nick. RAW case. Only ever sameNick — the
  # initial leg (NICK just sent, free nick) or after `:nick_observed`.
  @spec identify(t()) :: [String.t()]
  defp identify(%__MODULE__{cred_nick: nick, secret: secret}),
    do: ["PRIVMSG NickServ :IDENTIFY #{nick} #{secret}\r\n"]
end
