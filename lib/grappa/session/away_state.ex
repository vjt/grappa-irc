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

  # The auto-away reason string is fixed and documented. Changing it
  # would invalidate any client-side text matching; treat it as a
  # protocol constant. Pre-extraction this lived as
  # `@auto_away_reason` on Session.Server; it moves here because
  # `set_auto_away/1` is now the single injection site.
  @auto_away_reason "auto-away (web client disconnected)"

  @doc """
  Returns the fixed auto-away reason string. Exposed as a function
  so call sites (`Session.Server` for the upstream `AWAY :<reason>`
  emit, tests for assertions) reference one source of truth.
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
  Transitions to `:away_auto`, recording the fixed
  `auto_away_reason/0` constant and stamping `started_at` to now.
  Called by `Session.Server.set_auto_away_internal/1` after the
  30s WS-disconnect debounce fires.

  No precedence guard here — the Server's `handle_call({:set_auto_away}, _)`
  + `handle_info(:auto_away_debounce_fire, _)` arms guard against
  the `:away_explicit` precedence case. If you reach this function
  the caller has already decided auto is appropriate.
  """
  @spec set_auto_away(t()) :: t()
  def set_auto_away(%__MODULE__{} = as) do
    %{as | state: :away_auto, started_at: DateTime.utc_now(), reason: @auto_away_reason}
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
