defmodule Grappa.Session.AwayState do
  @moduledoc """
  Per-session away-state tracking for `Grappa.Session.Server`.

  ## What this is

  Bundle of the three sibling fields that previously lived on
  `Session.Server`'s state struct (`away_state`, `away_started_at`,
  `away_reason`). Cluster #7 god-module decomposition (Theme 3 /
  resp-A1 / ext-A9, 2/3) collapses them into one struct so the
  surrounding state struct shrinks from 4 fields → 1 field
  (the auto-away debounce timer reference stays on Server.ex —
  see "Why the timer ref is NOT in this struct" below).

  Mirrors the cluster #6 `Grappa.Session.WindowState` template:
  pure data, no process, mutators return new structs, readers
  expose the fields as a stable contract.

  ## CLAUDE.md invariant: state lives on the server

  > Window state model lives on the server. … cic NEVER originates
  > state — no optimistic STATE assumptions, no parallel client-side
  > state machine.

  Same principle applies to away state. Cic never originates away
  transitions; it observes `away_confirmed` events broadcast on the
  user-level PubSub topic. The data this module stores feeds those
  broadcasts. Adding a new away state (e.g. SASL-gated `:locked`)
  requires server changes; cic just mirrors.

  ## S3.2 precedence rules — enforced on Server, NOT here

  Per the spec:

    * `set_auto_away` is a no-op when already `:away_explicit`
      (explicit takes precedence).
    * `set_explicit_away` always wins, overwriting any prior
      `:away_auto`.
    * `unset_explicit_away` is a no-op unless currently `:away_explicit`.
    * `unset_auto_away` is a no-op unless currently `:away_auto`.

  All four guards live on `Session.Server`'s `handle_call/3` arms,
  NOT inside this data module. The mutators here are mechanical:
  whatever you set, sticks. This keeps the data module portable
  and unit-testable without re-encoding the IRC-side semantics.

  ## Pure data, no process

  This is NOT a GenServer / Agent / Registry. It's an in-memory
  struct that lives inside `Session.Server`'s state. The session
  GenServer is the synchronization primitive (mailbox-serialized);
  bundling the fields doesn't change concurrency semantics. A session
  crash drops the struct on the floor — derived from autojoin's
  natural transition flow on respawn (the IRC handshake re-establishes
  the live session, and the away state restarts at `:present` —
  matching pre-extraction Server behavior).

  ## Why the timer ref is NOT in this struct

  The auto-away debounce timer is a `Process.send_after/3` reference.
  Three reasons it stays on `Session.Server`:

    1. **Symmetry with cluster #6**: `in_flight_joins` (the TTL-swept
       JOIN tracker, also timer-driven) was kept on Session.Server
       outside `WindowState`. Same call: timer infrastructure is the
       Server's responsibility because the Server is what receives
       the `:auto_away_debounce_fire` info message.
    2. **Lifecycle alignment**: the timer is created and cancelled
       around `handle_info({:ws_*, _}, _)` arms — events that *only*
       Server.ex sees (it's the subscriber to `Topic.ws_presence/1`).
       Bundling the ref here would force a round-trip
       `state.away_state.debounce_timer` access for code that
       already has the Server state in hand.
    3. **Boundary clarity**: this module owns the away *data*. The
       timer is a *control* primitive for the Server's debounce
       loop — different concern, different module.

  ## Snapshot path

  Unlike `WindowState`, this module does NOT expose a `to_wire/N`
  projection. Away events are broadcast on the user-level topic via
  `Grappa.Session.Wire.away_confirmed/2` from Session.Server's
  set/unset internal helpers — the broadcast is the only consumer
  surface, and Server constructs the wire payload inline (it needs
  the network slug + nick + visitor flag context that lives on
  Server's state, not here).
  """

  @typedoc """
  Closed set of away states. Mirrors `Session.Server.away_state/0`
  (the original typedef the server used pre-extraction). `:present`
  is idle; `:away_explicit` is user-issued via `/away :reason`;
  `:away_auto` is debounce-driven from WS disconnect.
  """
  @type away_state :: :present | :away_explicit | :away_auto

  @typedoc """
  The bundled away-state struct. Replaces the 3 sibling fields
  on `Session.Server.state/0` (`away_state`, `away_started_at`,
  `away_reason`). Field-shape mirrors the previous storage exactly
  so existing inline-mutation behaviors map 1:1 onto the mutators
  below.

    * `state` — the closed-set atom.
    * `started_at` — the DateTime the away period began (nil when
      `:present`). Mentions aggregation (S3.5) reads this to fix
      the lower window boundary.
    * `reason` — the reason string broadcast upstream as `AWAY :<reason>`
      and surfaced to cic in the `away_confirmed` event payload
      (nil when `:present`).
  """
  @type t :: %__MODULE__{
          state: away_state(),
          started_at: DateTime.t() | nil,
          reason: String.t() | nil
        }

  defstruct state: :present, started_at: nil, reason: nil

  # The DEFAULT auto-away reason — what a subject who has never set one
  # of their own gets, byte for byte what every subject got before issue
  # 2150 made the string a value.
  #
  # The old comment here called it "fixed wire protocol" and warned that
  # changing it "would invalidate any client-side text matching". That was
  # measured on `origin/main` before this change and found false: the
  # literal appears exactly TWICE in the tree — this definition and one
  # test assertion — and ZERO times in `cicchetto/src`. Nothing matches on
  # it, so it was free to become a default rather than a constant.
  @auto_away_reason "auto-away (web client disconnected)"

  @doc """
  Returns the DEFAULT auto-away reason — the text used when the subject
  has stored none of their own (`Grappa.UserSettings.get_auto_away_reason/1`
  returning `nil`).

  Exposed as a function so the resolver
  (`Grappa.Session.Server.resolve_auto_away_reason/1`) and the tests
  reference one source of truth instead of restating the literal.
  """
  @spec auto_away_reason() :: String.t()
  def auto_away_reason, do: @auto_away_reason

  @doc """
  Returns an empty `AwayState`. Used by `Session.Server.init/1`.
  """
  @spec new() :: t()
  # Dialyzer flags the t() supertype here (success typing infers the
  # singleton `state: :present, started_at: nil, reason: nil`). Keep
  # the t() declaration — callers store the result in a Server state
  # field typed as t(), so narrowing the spec would propagate
  # narrower-than-useful types upstream.
  @dialyzer {:nowarn_function, new: 0}
  def new, do: %__MODULE__{}

  @doc """
  Transitions to `:away_explicit`, recording `reason` and stamping
  `started_at` to the current UTC. Called by
  `Session.Server.set_explicit_away_internal/3` for both the bare
  and label-prefixed AWAY-line variants — the upstream IRC line
  emit stays on the Server, only the data mutation lives here.

  No precedence guard inside the data module — the Server's
  `handle_call({:set_explicit_away, _}, _)` arm is unconditional
  (explicit always wins). Calling this on `:away_auto` overwrites
  cleanly; calling on `:present` records the new period; calling
  on `:away_explicit` updates the reason and resets `started_at`
  to now.
  """
  @spec set_explicit_away(t(), String.t()) :: t()
  def set_explicit_away(%__MODULE__{} = as, reason) when is_binary(reason) do
    %{as | state: :away_explicit, started_at: DateTime.utc_now(), reason: reason}
  end

  @doc """
  GH #417 — rebuilds an `:away_explicit` struct from a PERSISTED snapshot,
  stamping `started_at` to the ORIGINAL away-start `since` (NOT now, unlike
  `set_explicit_away/2`). Called by `Session.Server.do_init/1` when
  `SessionPlan.resolve/1` restored an away from the credential's
  `away_reason` / `away_since` columns, so a crash / `:transient` respawn /
  upstream reconnect resumes the exact window the user set — the
  mentions-bundle aggregation at `/back` then spans the honest period, not
  a reconnect-truncated one. Only explicit away is ever persisted, so this
  has no auto-away counterpart.
  """
  @spec restore_explicit(String.t(), DateTime.t()) :: t()
  def restore_explicit(reason, %DateTime{} = since) when is_binary(reason) do
    %__MODULE__{state: :away_explicit, started_at: since, reason: reason}
  end

  @doc """
  Transitions to `:away_auto`, recording `reason` and stamping
  `started_at` to now. Called by `Session.Server.set_auto_away_internal/1`
  after the WS-disconnect debounce fires.

  `reason` is RESOLVED BY THE CALLER (issue 2150) — the subject's stored
  auto-away reason, else `auto_away_reason/0`. There is deliberately no
  arity-1 clause defaulting to the constant: that would be a silent
  degradation path (CLAUDE.md), where the next call site added gets the
  default instead of the subject's choice and nothing says so. The
  session resolves once at spawn and carries the answer, so every caller
  already holds it.

  No precedence guard here — the Server's `handle_call({:set_auto_away}, _)`
  + `handle_info(:auto_away_debounce_fire, _)` arms guard against
  the `:away_explicit` precedence case. If you reach this function
  the caller has already decided auto is appropriate.
  """
  @spec set_auto_away(t(), String.t()) :: t()
  def set_auto_away(%__MODULE__{} = as, reason) when is_binary(reason) do
    %{as | state: :away_auto, started_at: DateTime.utc_now(), reason: reason}
  end

  @doc """
  Clears any active away state, returning to `:present` and resetting
  `started_at` + `reason` to nil. Called by
  `Session.Server.unset_away_internal/2` for both explicit-unset
  and auto-unset paths (both ultimately funnel through here so the
  Mentions bundle aggregation runs symmetrically).

  Idempotent on `:present` — calling clears already-nil fields,
  the result is the same struct semantically.
  """
  @spec unset_away(t()) :: t()
  def unset_away(%__MODULE__{} = as) do
    %{as | state: :present, started_at: nil, reason: nil}
  end

  @doc """
  Returns the current away-state atom (`:present`, `:away_explicit`,
  or `:away_auto`).
  """
  @spec state_of(t()) :: away_state()
  def state_of(%__MODULE__{state: state}), do: state

  @doc """
  Returns the DateTime the current away period began, or `nil` if
  `:present`. Mentions aggregation (S3.5,
  `Session.Server.maybe_broadcast_mentions_bundle/1`) reads this to
  fix the lower window boundary.
  """
  @spec started_at(t()) :: DateTime.t() | nil
  def started_at(%__MODULE__{started_at: ts}), do: ts

  @doc """
  Returns the recorded away reason string, or `nil` if `:present`.
  Used by the `away_confirmed` event payload + the `mentions_bundle`
  payload (so cic can surface "you were away because: lunch" when
  rendering the aggregation banner).
  """
  @spec reason(t()) :: String.t() | nil
  def reason(%__MODULE__{reason: reason}), do: reason
end
