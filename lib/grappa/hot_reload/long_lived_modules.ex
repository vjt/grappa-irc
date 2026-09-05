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

  A module belongs in `@modules` if it is a `GenServer` and
  `Grappa.Deploy.Preflight.extract_state_block/1` finds a state block in
  its source — a `defstruct`, an `@type t :: %{...}`, or an `init/1`
  returning a `{:ok, %{...}}` literal.

  **That is a mechanical test, not a judgement call**, and
  `Grappa.HotReload.LongLivedModulesMembershipTest` runs it over every
  `GenServer` the `:grappa` application ships (GH #1343 / D-S1). It used
  to be a judgement call — "a pure-ETS module may be listed or not" — and
  the drift that licensed was measured: nine `GenServer`s carrying
  exactly the shapes the extractor reads were absent, four of them
  reapers and telemetry sinks whose listed siblings differ in nothing.
  An empty `{:ok, %{}}` earns an entry for the same reason it always
  did — the day it gains its first field, the field-add IS the
  hot-unsafe change, and only a listed module gets checked.

  The gate is one-directional by design: it can prove that a stateful
  `GenServer` is tracked, never that a tracked module is supervised.
  `Grappa.IRC.Client` and `Grappa.IRC.AuthFSM` live under a session, not
  under the application supervisor, and belong here all the same.

  Helper modules whose `defstruct` is a *field* of a long-lived
  module's state (e.g. `Grappa.Session.AwayState` is a field of
  `Grappa.Session.Server`'s state) belong in `@state_helpers` —
  they are not directly supervised but their shape is part of the
  parent's hot-reload surface.

  **That half is derived and gated too, since GH #1473.** The
  membership test walks the `t` typespec of every `@modules` entry to
  a fixpoint, keeps the reachable `:grappa` modules that define a
  struct, and requires each one's SOURCE FILE to be in the checked
  set. It was hand-maintained and nothing held it: three structs
  carrying live `Session.Server` / `IRC.Client` state were absent
  (`Deps` and `DirectoryIngest` from the #1390 decomposition, plus
  `IRC.FakeLag`), and a `defstruct` field-add to any of them
  classified HOT — measured through `Preflight.classify/5`, with
  `WindowState` as the listed control returning COLD.

  **The unit of coverage is the FILE, not the module**, because
  `Preflight.extract_state_block/1` reads a source file rather than a
  module. A struct nested inside another module's file
  (`LinksAccum.Entry`, `ListModeAccum.Entry`, `WhowasAccum.Entry`,
  `DirectoryIngest.Run`) is therefore covered by listing its PARENT —
  measured: a field-add to the nested `Run` moves
  `directory_ingest.ex`'s extracted block. Such a module must NOT get
  its own entry: `Grappa.Session.DirectoryIngest.Run` implies
  `lib/grappa/session/directory_ingest/run.ex`, which does not exist,
  and an absent file reads equal at both revs — the silent HOT.

  A `GenServer` the extractor sees NOTHING in is out of scope, and the
  membership test also refuses a listing it cannot see a shape for — an
  entry that buys no check reads as coverage while providing none. When
  the shape is real but invisible, make it visible rather than listing
  around it: `Grappa.Net.PtrCache` held a six-field map bound to a
  variable before returning it, so listing it would have been inert
  until its `init/1` returned the literal.

  ## Adding a new module

  When introducing a new long-lived `GenServer` (the membership test
  fails until step 1 is done, so this is a checklist, not a courtesy):

    1. Add the module atom to `@modules` here — and to the `long_lived`
       union below, which Dialyzer holds to the same set.
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
    # #1420 — first, because it is the one child that boots BEFORE Repo
    # (it owns the ETS table the BEGIN IMMEDIATE seam writes to).
    Grappa.Repo.LockWatch,
    Grappa.Session.Backoff,
    Grappa.WSPresence,
    Grappa.Admission.NetworkCircuit,
    Grappa.AdminEvents,
    Grappa.SessionLog,
    Grappa.DbLatency,
    Grappa.ShareTokens,
    Grappa.RateLimit.DailyQuota,
    Grappa.RateLimit.FailureWindow,
    Grappa.RateLimit.TokenBucket,
    Grappa.Net.PtrCache,
    # #1768 — its `init/1` returns the bare `{:ok, %{}}` literal, which is
    # exactly the empty-map case this list takes on purpose: the day the
    # pending map gains a field beside the ctx, THAT field-add is the
    # hot-unsafe change, and only a listed module is checked for it.
    Grappa.WindowCounts.Pusher.Coalescer,
    Grappa.Session.Server,
    Grappa.IRC.Client,
    Grappa.IRC.AuthFSM,
    Grappa.Net.SourceAliasManager,
    Grappa.Visitors.Reaper,
    Grappa.Uploads.Reaper,
    Grappa.Avatars.Reaper,
    Grappa.Accounts.Reaper
  ]

  # Helper struct modules whose defstruct is a *field* of one of the
  # `@modules` above. A `defstruct` change here is just as
  # hot-reload-unsafe as a change to the parent's own defstruct.
  #
  # Order mirrors `@modules`: the `Session.Server` helpers (alphabetical),
  # then `IRC.Client`'s, because that is the order their parents appear in.
  #
  # #1473 added the last three. List only a module whose CONVENTIONAL PATH
  # is the file carrying the struct — a struct nested inside another
  # module's file is covered by listing its parent and must NOT get its own
  # entry. See the "What goes here" note above.
  @state_helpers [
    # #1901 — a field of `Grappa.DbLatency`'s per-family accumulators. Its
    # `defstruct` gaining a field is exactly as hot-unsafe as the parent's,
    # and the #1473 membership test walks the parent's `t` typespec to find
    # it, so this entry is derived rather than a judgement call.
    Grappa.DbLatency.Distribution,
    Grappa.Session.AwayState,
    Grappa.Session.Deps,
    Grappa.Session.DirectoryIngest,
    Grappa.Session.GhostRecovery,
    Grappa.Session.LinksAccum,
    Grappa.Session.ListModeAccum,
    Grappa.Session.LusersAccum,
    Grappa.Session.RecoverIdentity,
    Grappa.Session.WhoisAccum,
    Grappa.Session.WhowasAccum,
    Grappa.Session.WindowState,
    Grappa.IRC.FakeLag
  ]

  @typedoc """
  One of the long-lived `GenServer` modules tracked for hot-reload safety.
  Keep this union in sync with `@modules` — Dialyzer enforces equality via
  `:underspecs` (a divergence shows up as `contract_supertype`).
  """
  @type long_lived ::
          Grappa.Repo.LockWatch
          | Grappa.Session.Backoff
          | Grappa.WSPresence
          | Grappa.Admission.NetworkCircuit
          | Grappa.AdminEvents
          | Grappa.SessionLog
          | Grappa.DbLatency
          | Grappa.ShareTokens
          | Grappa.RateLimit.DailyQuota
          | Grappa.RateLimit.FailureWindow
          | Grappa.RateLimit.TokenBucket
          | Grappa.Net.PtrCache
          | Grappa.WindowCounts.Pusher.Coalescer
          | Grappa.Session.Server
          | Grappa.IRC.Client
          | Grappa.IRC.AuthFSM
          | Grappa.Net.SourceAliasManager
          | Grappa.Visitors.Reaper
          | Grappa.Uploads.Reaper
          | Grappa.Avatars.Reaper
          | Grappa.Accounts.Reaper

  @typedoc """
  One of the helper struct modules whose `defstruct` is a field of a
  `long_lived` module. Keep in sync with `@state_helpers`.
  """
  @type state_helper ::
          Grappa.DbLatency.Distribution
          | Grappa.Session.AwayState
          | Grappa.Session.Deps
          | Grappa.Session.DirectoryIngest
          | Grappa.Session.GhostRecovery
          | Grappa.Session.LinksAccum
          | Grappa.Session.ListModeAccum
          | Grappa.Session.LusersAccum
          | Grappa.Session.RecoverIdentity
          | Grappa.Session.WhoisAccum
          | Grappa.Session.WhowasAccum
          | Grappa.Session.WindowState
          | Grappa.IRC.FakeLag

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
