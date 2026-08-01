defmodule Grappa.SessionStateHelpers do
  @moduledoc """
  Test-only accessor layer over a `Grappa.Session.Server` process's
  internal state map.

  ## Why this exists (#414, per 2026-07-20 architecture review A3)

  `server_test.exs` reached into the GenServer's raw state struct at ~100
  call sites via `:sys.get_state(pid).some_key`. That pinned the *shape*
  of `Session.Server`'s 70-key state map: every field rename or
  field-bundling refactor (exactly the extractions #414 sequences) broke
  dozens of tests that were not testing behaviour — the CP-era
  `WindowState` bundling of 4 fields → 1 struct already paid that tax.

  Routing every reach-in through here makes a state-shape change a
  **one-file test fix**: only the accessors below know *where* a value
  lives. They return the value at the key **verbatim** — this is an
  accessor layer, NOT an assertion layer. The caller keeps its own
  `assert` / `match?` / indexing on the returned value, so no assertion
  is weakened or re-shaped; only the path to the value is centralized.

  `:sys.get_state/1` is legitimate for genuinely internal invariants — it
  is not banned. But it belongs in `fetch/1` here, the single sanctioned
  call site. Direction of travel (review A3): new session tests assert via
  wire output / PubSub, and any that must inspect state route through
  these helpers — `event_router_test.exs` already proves 4,400 lines of
  session-adjacent tests with **zero** `:sys.get_state`.

  ## Snapshot semantics

  `fetch/1` takes ONE snapshot; the accessors read from that snapshot.
  This preserves the pre-#414 contract exactly — a test that read several
  keys did so from a single point-in-time `:sys.get_state`, and still
  does. (Per-accessor re-fetching would turn one snapshot into N, a
  behaviour change however small — deliberately avoided.)

  ## Usage

      alias Grappa.SessionStateHelpers

      state = SessionStateHelpers.fetch(pid)
      assert WindowState.state_of(SessionStateHelpers.window_state(state), "#chan") == :joined
      assert match?({"s3cret", _}, SessionStateHelpers.pending_auth(state))

  Treat the snapshot returned by `fetch/1` as opaque: pass it to the
  accessors, never index it directly — that would re-introduce the very
  coupling this module removes.
  """

  use Boundary, top_level?: true, deps: []

  @typedoc """
  An opaque snapshot of a `Grappa.Session.Server` process state, as
  returned by `fetch/1`. Callers pass it to the accessors below; its
  internal shape is owned by `Grappa.Session.Server` and MUST NOT be
  inspected directly by tests.
  """
  @type snapshot :: map()

  @doc "The single sanctioned `:sys.get_state/1` — snapshots `pid`'s state."
  @spec fetch(pid()) :: snapshot()
  def fetch(pid) when is_pid(pid), do: :sys.get_state(pid)

  # --- window / channel projection ---------------------------------------

  @doc "Per-channel window-state bundle (`Grappa.Session.WindowState`)."
  @spec window_state(snapshot()) :: term()
  def window_state(state), do: state.window_state

  @doc "Per-channel mode table."
  @spec channel_modes(snapshot()) :: term()
  def channel_modes(state), do: state.channel_modes

  @doc "Per-channel topic table."
  @spec topics(snapshot()) :: term()
  def topics(state), do: state.topics

  @doc "Per-channel members map."
  @spec members(snapshot()) :: term()
  def members(state), do: state.members

  @doc "In-flight JOINs awaiting upstream confirmation / failure numeric."
  @spec in_flight_joins(snapshot()) :: term()
  def in_flight_joins(state), do: state.in_flight_joins

  @doc "Channels we sent a ChanServ INVITE for after an autojoin failure."
  @spec awaiting_invite(snapshot()) :: term()
  def awaiting_invite(state), do: state.awaiting_invite

  # --- auth / registration -----------------------------------------------

  @doc "In-flight SASL/NickServ auth correlation, or `nil`."
  @spec pending_auth(snapshot()) :: term()
  def pending_auth(state), do: state.pending_auth

  @doc "Timer ref guarding `pending_auth`, or `nil`."
  @spec pending_auth_timer(snapshot()) :: term()
  def pending_auth_timer(state), do: state.pending_auth_timer

  @doc "Captured registration secret awaiting the `+r` commit, or `nil`."
  @spec pending_registration_secret(snapshot()) :: term()
  def pending_registration_secret(state), do: state.pending_registration_secret

  @doc "One-shot `:nickserv_identify` upstream secret carried to 001, or `nil`."
  @spec pending_password(snapshot()) :: term()
  def pending_password(state), do: state.pending_password

  # --- identity / connection ---------------------------------------------

  @doc "Current session nick."
  @spec nick(snapshot()) :: term()
  def nick(state), do: state.nick

  @doc "Network id."
  @spec network_id(snapshot()) :: term()
  def network_id(state), do: state.network_id

  @doc "The linked `Grappa.IRC.Client` pid, or `nil` before connect."
  @spec client(snapshot()) :: term()
  def client(state), do: state.client

  @doc "The canonicalised autojoin channel list."
  @spec autojoin(snapshot()) :: term()
  def autojoin(state), do: state.autojoin

  # --- pending accumulators ----------------------------------------------

  @doc "Per-target WHOIS accumulator."
  @spec whois_pending(snapshot()) :: term()
  def whois_pending(state), do: state.whois_pending

  # --- ghost recovery ----------------------------------------------------

  @doc "Ghost-recovery driver state (`Grappa.Session.GhostRecovery`), or `nil`."
  @spec ghost_recovery(snapshot()) :: term()
  def ghost_recovery(state), do: state.ghost_recovery

  @doc "Ghost-recovery timer ref, or `nil`."
  @spec ghost_timer(snapshot()) :: term()
  def ghost_timer(state), do: state.ghost_timer

  # --- recover identity (#581/#623) --------------------------------------

  @doc "Recover-identity driver state (`Grappa.Session.RecoverIdentity`), or `nil`."
  @spec recover_identity(snapshot()) :: term()
  def recover_identity(state), do: state.recover_identity

  # --- away --------------------------------------------------------------

  @doc "Away state machine value (`Grappa.Session.AwayState`)."
  @spec away_state(snapshot()) :: term()
  def away_state(state), do: state.away_state

  @doc "Auto-away debounce timer ref, or `nil`."
  @spec auto_away_timer(snapshot()) :: term()
  def auto_away_timer(state), do: state.auto_away_timer
end
