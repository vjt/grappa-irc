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
  preflight delegates to `Grappa.Deploy.Preflight.classify/5` (REV-C,
  closes review C4) which:

    1. reads this module's `all/0` to enumerate the tracked module
       set — single-sourced, no string parsing of this file's
       attribute blocks;
    2. translates each module to its source-file path
       (`Grappa.Foo.Bar` → `lib/grappa/foo/bar.ex`);
    3. for each touched long-lived file, extracts the `@type t :: %{...}`,
       `defstruct ...`, and `init/1` `{:ok, %{...}}` map-literal state
       blocks at both revs via `Code.string_to_quoted/1` (Elixir's
       tokenizer is the authority on syntax — no regex);
    4. classifies COLD if the normalized block strings differ.

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

  Modules that hold ETS only (state := `%{}` empty) may still be
  listed — `Grappa.Session.Backoff` and `Grappa.Admission.NetworkCircuit`
  are. Their `init/1` returns a stable `{:ok, %{}}`, so the state-shape
  check extracts an empty map that never differs across revs → they are
  a permanent no-op today, harmless, and the entry future-proofs the day
  one gains non-ETS state (the check would then catch the field-add).
  A pure-ETS module that is *not* listed is equally fine — its
  hot-reload surface is the function bodies, which `Phoenix.CodeReloader`
  handles natively. Listing is a judgement call, not a contradiction.

  ## Adding a new module

  When introducing a new long-lived `GenServer`:

    1. Add the module atom to `@modules` here.
    2. If it has a `defstruct`, `Grappa.Deploy.Preflight` extracts
       its shape via the Elixir tokenizer — covers field-additions,
       removals, and rearrangements.
    3. Same for `@type t :: %{...}` bare-map shapes and an `init/1`
       that returns a bare `{:ok, %{...}}` map literal. (A `defstruct`
       is preferred — it gives Dialyzer something to check too.)

  ## Invariants

    - List entries are atoms (Elixir module names), not strings.
    - List order is intentional: roughly supervision-tree order
      (Backoff/WSPresence/NetworkCircuit boot before Session.Server,
      Reaper boots last). Don't sort alphabetically.
  """

  use Boundary, top_level?: true, deps: [], exports: []

  # Long-lived GenServer modules — supervised, stateful. Consumed by
  # `Grappa.Deploy.Preflight.long_lived_module_files/0` to populate the
  # deploy-preflight state-shape check set. Coupling is via the Elixir
  # reference `LongLivedModules.all/0`; no string parsing of this file
  # (pre-REV-C the bash preflight regex-parsed the @modules block and
  # would silently false-COLD when typespec union lines matched the
  # shape — review C4 / CP28 incident class).
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
