defmodule Grappa.HttpHosts do
  @moduledoc """
  The deployment's own HTTP hostname aliases — the set of hostnames
  nginx serves this ONE grappa instance under (#324).

  ## Why this exists

  A deployment can answer on several hostname aliases that all
  reverse-proxy to the SAME bouncer + upload store (e.g.
  `irc.sindro.me` AND `irc.sniffo.org`). An upload link minted under
  one alias (`📸 https://irc.sniffo.org/uploads/<slug>`) may be viewed
  in cic loaded from another (`https://irc.sindro.me`). cic's media-
  link classifier (`cicchetto/src/lib/mediaLink.ts`) must recognise
  BOTH as same-deployment so the in-app media viewer opens instead of
  the plain anchor (which navigates the iOS standalone PWA in place).

  The alias set is SERVER-PROVIDED, single source of truth: cic never
  bakes a host list. It rides the deployment-global server-settings
  wire payload (`Grappa.ServerSettings.public_view/0` →
  `Grappa.ServerSettings.Wire`), NOT a per-network ISUPPORT token — a
  hostname alias is an HTTP/deployment property, not a per-(subject,
  network) IRC property.

  ## Source of truth — derived, not a second list

  The set is DERIVED at boot from the SAME env inputs that already
  build the Endpoint's `check_origin` gate — `PHX_HOST` +
  `EXTRA_CHECK_ORIGINS` (see `config/runtime.exs`). Adding a vhost is
  one `EXTRA_CHECK_ORIGINS` edit; no cic redeploy, no hand-maintained
  duplicate. This is NOT `Grappa.Vhosts` (#228) — that is per-network
  IRC source-bind (outbound IP), a different axis entirely.

  ## Boot-time read → `:persistent_term`

  Per CLAUDE.md "`Application.{put,get}_env`: boot-time only, runtime
  banned", `config/runtime.exs` sets `:http_host_aliases` and
  `Grappa.Application.start/2` reads it once and calls `boot/1` here,
  stashing into `:persistent_term`. Runtime readers (the
  `ServerSettings.public_view/0` assembler) call `aliases/0` — a
  lock-free `:persistent_term` read. Mirrors `Grappa.Uploads.boot/1` +
  `Grappa.Push.boot/0`.
  """

  use Boundary, top_level?: true, deps: []

  @aliases_key {__MODULE__, :aliases}

  @doc """
  Stash the deployment's HTTP host aliases into `:persistent_term`.
  Called once from `Grappa.Application.start/2` with the boot-derived
  list (`Application.get_env(:grappa, :http_host_aliases, [])`).
  """
  @spec boot([String.t()]) :: :ok
  def boot(aliases) when is_list(aliases) do
    :persistent_term.put(@aliases_key, aliases)
    :ok
  end

  @doc """
  The deployment's HTTP host aliases (bare, lowercased hostnames).
  Empty list before `boot/1` runs (dev without `PHX_HOST`, or a test
  that hasn't stashed a set) — cic then admits only its own page
  origin, the pre-#324 behaviour.
  """
  @spec aliases() :: [String.t()]
  def aliases, do: :persistent_term.get(@aliases_key, [])
end
