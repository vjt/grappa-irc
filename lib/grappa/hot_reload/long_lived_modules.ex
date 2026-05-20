defmodule Grappa.HotReload.LongLivedModules do
  @moduledoc """
  Single source of truth for the set of modules whose state shape is
  load-bearing across `Phoenix.CodeReloader` hot-reload cycles.

  ## Why this exists

  `Phoenix.CodeReloader` (CP23 `cluster/code-reload`) swaps `lib/*.ex`
  beams in the live BEAM without restarting. For *most* modules that's
  safe: a function-body change is picked up on the next call. For
  long-lived `GenServer` processes whose state shape changes between
  the running version and the new beam, the next callback
  pattern-matches the new shape against the old in-memory state —
  **silent crash, deferred to the next message** that exposes the
  mismatch (could be hours later).

  `scripts/deploy.sh` runs a git-diff preflight before every deploy
  to refuse hot-deploy when this class of change is detected. The
  preflight greps:

    1. `defstruct` line touched in any of these modules
    2. `@type t :: %{...}` shape changed (for modules that hold
       state as a bare map rather than a struct)
    3. `init/1` literal map keys added/removed (also for bare-map
       modules)

  CLAUDE.md "Hot vs cold deploy" cites this module by name as the
  authoritative enumeration so the script and the docs cannot drift.

  ## What goes here

  A module belongs in `@modules` if:

    - it is a `GenServer` (or other long-lived process) supervised
      by the top-level application supervisor with `restart: :permanent`
      or `:transient`, AND
    - it carries non-trivial state that is fed by callbacks (not
      just an empty map placeholder for processes that store
      everything in ETS).

  Helper modules whose `defstruct` is a *field* of a long-lived
  module's state (e.g. `Grappa.Session.AwayState` is a field of
  `Grappa.Session.Server`'s state) belong in `@state_helpers` —
  they are not directly supervised but their shape is part of the
  parent's hot-reload surface.

  Modules that hold ETS only (state := `%{}` empty) intentionally
  fall outside the list: their hot-reload surface is the function
  bodies, not the GenServer state, and `Phoenix.CodeReloader`
  handles function bodies natively.

  ## Adding a new module

  When introducing a new long-lived `GenServer`:

    1. Add the module atom to `@modules` here.
    2. If it has a `defstruct`, the existing `defstruct`-line grep
       in `scripts/deploy.sh` catches its shape changes.
    3. If it stores state as a bare map, ALSO add a `@type t :: %{
       ...}` declaration so the type-shape grep catches it. (Adding
       a `defstruct` is preferred — it gives Dialyzer something to
       check too.)

  ## Invariants

    - List entries are atoms (Elixir module names), not strings.
    - List order is intentional: roughly supervision-tree order
      (Backoff/WSPresence/NetworkCircuit boot before Session.Server,
      Reaper boots last). Don't sort alphabetically.
  """

  use Boundary, top_level?: true, deps: [], exports: []

  # Long-lived GenServer modules — supervised, stateful.
  #
  # ⚠️  This list is parsed by `scripts/deploy.sh` via a stable
  # `grep` pattern. KEEP one module per line, fully-qualified, no
  # trailing comments on the same line. The script's regex is:
  #
  #     ^\s+Grappa\.[A-Za-z_.0-9]+,?$
  #
  # Anything that breaks that shape will silently drop modules from
  # the preflight check.
  @modules [
    Grappa.Session.Backoff,
    Grappa.WSPresence,
    Grappa.Admission.NetworkCircuit,
    Grappa.AdminEvents,
    Grappa.Session.Server,
    Grappa.IRC.Client,
    Grappa.IRC.AuthFSM,
    Grappa.Visitors.Reaper,
    Grappa.Uploads.Reaper
  ]

  # Helper struct modules whose defstruct is a *field* of one of the
  # `@modules` above. A `defstruct` change here is just as
  # hot-reload-unsafe as a change to the parent's own defstruct.
  #
  # Same parsing-shape rules as `@modules` above.
  @state_helpers [
    Grappa.Session.AwayState,
    Grappa.Session.GhostRecovery,
    Grappa.Session.WindowState
  ]

  @typedoc """
  One of the long-lived `GenServer` modules tracked for hot-reload safety.
  Keep this union in sync with `@modules` — Dialyzer enforces equality via
  `:underspecs` (a divergence shows up as `contract_supertype`).
  """
  @type long_lived ::
          Grappa.Session.Backoff
          | Grappa.WSPresence
          | Grappa.Admission.NetworkCircuit
          | Grappa.AdminEvents
          | Grappa.Session.Server
          | Grappa.IRC.Client
          | Grappa.IRC.AuthFSM
          | Grappa.Visitors.Reaper
          | Grappa.Uploads.Reaper

  @typedoc """
  One of the helper struct modules whose `defstruct` is a field of a
  `long_lived` module. Keep in sync with `@state_helpers`.
  """
  @type state_helper ::
          Grappa.Session.AwayState
          | Grappa.Session.GhostRecovery
          | Grappa.Session.WindowState

  @doc """
  Returns the list of long-lived `GenServer` modules whose state
  shape changes require a cold deploy.
  """
  @spec modules() :: nonempty_list(long_lived())
  def modules, do: @modules

  @doc """
  Returns the list of helper struct modules whose `defstruct` is a
  field of one of the `modules/0` entries.
  """
  @spec state_helpers() :: nonempty_list(state_helper())
  def state_helpers, do: @state_helpers

  @doc """
  Returns every module whose hot-reload safety we track — the union
  of `modules/0` and `state_helpers/0`.
  """
  @spec all() :: nonempty_list(long_lived() | state_helper())
  def all, do: @modules ++ @state_helpers
end
