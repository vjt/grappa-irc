defmodule Grappa.WindowCounts.PushSource do
  @moduledoc """
  Dependency-inversion seam for the per-message `window_counts` push
  (#267), mirroring `Grappa.Push.BadgeSource` (door #1).

  ## Why a behaviour + config injection

  `Grappa.Session.Server`'s `apply_effects/2` `:persist` arm wants to
  push the fresh `WindowCounts.snapshot/6` for a `(subject, network,
  channel)` window right after a row lands, so a connected cic renders
  the new count without deriving it. But the snapshot needs the read
  cursor (`Grappa.ReadCursor`), which deps `Networks`, which deps
  `Session` — a static `Session → ReadCursor` edge would close the
  cycle `Session → ReadCursor → Networks → Session`.

  This behaviour is the inversion: `Grappa.WindowCounts` owns the seam,
  the implementation (`Grappa.WindowCounts.Pusher`, which DOES dep
  ReadCursor) is read from application config ONCE at boot (`boot/0`),
  stashed in `:persistent_term`, and resolved lock-free via `impl/0` (the
  config value is a module atom read from env, never a literal in the
  caller), so Session carries no static edge onto the implementation. The
  `nil` fallthrough (key never populated — `:persistent_term` survives hot
  code reloads, so this only surfaces for a brand-new seam hot-loaded before
  a cold restart runs `boot/0`) is a no-op: the push is a live-render
  optimization, and
  the next `join_reply` / `/me` / `read_cursor_set` re-seeds the absolute
  snapshot regardless.

  ## Boot-time injection (#364 J/cross-module-S2)

  Resolution moved off a per-call `Application.get_env/2` read (banned at
  runtime by CLAUDE.md) onto the `:persistent_term` boot boundary that
  `Grappa.Admission.Config` already uses: `Grappa.Application.start/2`
  calls `boot/0` once before the supervision tree. Tests substitute via
  `put_test_impl/1`, not `Application.put_env`.
  """

  alias Grappa.Subject

  @typedoc """
  Everything `Grappa.WindowCounts.Pusher` needs, assembled by the
  Session.Server persist arm from `state` + the persisted row so the
  impl never reaches back into the GenServer state shape. `own_nick` may
  be `nil` before registration assigns the negotiated nick.
  """
  @type ctx :: %{
          subject: Subject.t(),
          network_id: integer(),
          network_slug: String.t(),
          subject_label: String.t(),
          channel: String.t(),
          own_nick: String.t() | nil
        }

  @doc """
  Pushes the `window_counts` snapshot for the window described by `ctx`.
  Fire-and-forget — the implementation gates on live WS presence and
  does its DB work off the caller's hot path.
  """
  @callback push(ctx()) :: :ok

  @key {__MODULE__, :impl}

  @doc """
  Reads `config :grappa, :window_counts_push_source` once and stashes it in
  `:persistent_term` for lock-free runtime reads. Called from
  `Grappa.Application.start/2` (the CLAUDE.md-designated boot-time
  boundary; mirrors `Grappa.Admission.Config.boot/0`).
  """
  @spec boot() :: :ok
  def boot do
    :persistent_term.put(@key, Application.get_env(:grappa, :window_counts_push_source))
    :ok
  end

  @doc """
  Resolves the configured implementation from `:persistent_term`
  (populated by `boot/0`), or `nil` when the key is absent (hot-deploy
  window — see moduledoc). `get/2` (default `nil`) instead of `get/1` so
  the window degrades to a no-op instead of raising.
  """
  @spec impl() :: module() | nil
  def impl, do: :persistent_term.get(@key, nil)

  @doc """
  Resolves the implementation and pushes in one call — the shape the
  Session.Server persist arm uses. No-op when no implementation is
  configured.
  """
  @spec push(ctx()) :: :ok
  def push(ctx) when is_map(ctx) do
    case impl() do
      nil -> :ok
      mod -> mod.push(ctx)
    end
  end

  if Mix.env() == :test do
    @doc false
    @spec put_test_impl(module() | nil) :: :ok
    def put_test_impl(impl), do: :persistent_term.put(@key, impl)
  end
end
