defmodule Grappa.Push.BadgeSource do
  @moduledoc """
  Dependency-inversion seam for the PWA badge count on the push-dispatch
  path (door #1, 2026-06-21).

  ## Why a behaviour + config injection

  `Grappa.Push.Triggers.evaluate_and_dispatch/2` (deep in the
  `Session → Push` message hot path) wants to stamp the current badge
  count onto the outgoing push payload so the service worker can call
  `setAppBadge` while the app is closed. The count lives in
  `Grappa.Push.BadgeCount`, which sits in a layer ABOVE Push (it deps
  `Networks` / `ReadCursor` / `Visitors`, all of which transitively reach
  `Session`, which deps `Push`). A static `Push → BadgeCount` reference
  would close the cycle `Push → BadgeCount → Networks → Session → Push`.

  This behaviour is the inversion: Push defines + owns the seam, the
  implementation is read from application config ONCE at boot (`boot/0`),
  stashed in `:persistent_term`, and resolved lock-free at runtime via
  `impl/0` (the config value is a module atom read from env, never a
  literal in Push source), so Push carries no static edge onto the
  implementation. Doors #2/#3 (web layer) call `BadgeCount.count/1`
  directly and never touch this seam.

  ## Boot-time injection (#364 J/cross-module-S2)

  Resolution moved off a per-call `Application.get_env/2` read (banned at
  runtime by CLAUDE.md) onto the `:persistent_term` boot boundary that
  `Grappa.Admission.Config` / `Grappa.Uploads` / `Grappa.HttpHosts`
  already use: `Grappa.Application.start/2` calls `boot/0` once before the
  supervision tree. Tests substitute via `put_test_impl/1`, not
  `Application.put_env`.
  """

  alias Grappa.Subject

  @doc """
  Returns the notify-worthy unread count for `subject`, in `0..99`. The
  badge the service worker stamps on the home-screen icon.
  """
  @callback count(Subject.t()) :: non_neg_integer()

  @key {__MODULE__, :impl}

  @doc """
  Reads `config :grappa, :badge_source` once and stashes it in
  `:persistent_term` for lock-free runtime reads. Called from
  `Grappa.Application.start/2` (the CLAUDE.md-designated boot-time
  boundary; mirrors `Grappa.Admission.Config.boot/0`).
  """
  @spec boot() :: :ok
  def boot do
    :persistent_term.put(@key, Application.get_env(:grappa, :badge_source))
    :ok
  end

  @doc """
  Resolves the `Grappa.Push.BadgeSource` implementation from
  `:persistent_term` (populated by `boot/0`), or `nil` when the key was
  never populated. `:persistent_term` survives hot code reloads, so a
  running node keeps the value it booted with; `nil` only surfaces for a
  brand-new seam whose `boot/0` is hot-loaded BEFORE any cold restart has
  run it. `get/2` (default `nil`) instead of `get/1` so that window
  degrades gracefully (see `count/1`) instead of crashing the push hot
  path.
  """
  @spec impl() :: module() | nil
  def impl, do: :persistent_term.get(@key, nil)

  @doc """
  Resolves the implementation and counts in one call — the shape door #1
  uses. Returns the count, or `nil` when no implementation is configured
  (the hot-deploy window described in `impl/0`). Door #1 OMITS the badge
  field on `nil` rather than crashing the fire-and-forget push `Task`
  (which would drop the notification entirely) or stamping a wrong `0`
  (which would CLEAR the operator's icon badge). Badges resume the moment
  the config is live. Doors #2/#3 call `Grappa.Push.BadgeCount` directly
  and never hit this path.
  """
  @spec count(Subject.t()) :: non_neg_integer() | nil
  def count({_, _} = subject) do
    case impl() do
      nil -> nil
      mod -> mod.count(subject)
    end
  end

  if Mix.env() == :test do
    @doc false
    @spec put_test_impl(module() | nil) :: :ok
    def put_test_impl(impl), do: :persistent_term.put(@key, impl)
  end
end
