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
  implementation is resolved at RUNTIME from application config (default
  wired in `config/config.exs`, never as a module literal in Push
  source), so Push carries no static edge onto the implementation.
  Doors #2/#3 (web layer) call `BadgeCount.count/1` directly and never
  touch this seam.

  Tests that want to decouple from the DB can override
  `config :grappa, :badge_source, SomeStub` (the stub implements
  `count/1`).
  """

  alias Grappa.Subject

  @doc """
  Returns the notify-worthy unread count for `subject`, in `0..99`. The
  badge the service worker stamps on the home-screen icon.
  """
  @callback count(Subject.t()) :: non_neg_integer()

  @doc """
  Resolves the configured `Grappa.Push.BadgeSource` implementation, or
  `nil` when the key is absent. Wired in `config/config.exs` — present
  under every normal boot (and in tests). `nil` is the transient
  HOT-DEPLOY window: a hot module reload swaps the new `Triggers` /
  `BadgeCount` code into the live node but does NOT re-run `config.exs`,
  so the freshly-added `:badge_source` key isn't in the running node's
  application env until the next cold restart (or an rpc `put_env`).
  `get_env` (default `nil`) instead of `fetch_env!` so that window
  degrades gracefully (see `count/1`) instead of crashing the push hot
  path.
  """
  @spec impl() :: module() | nil
  def impl, do: Application.get_env(:grappa, :badge_source)

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
end
