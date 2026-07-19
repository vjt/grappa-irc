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
  ReadCursor) is resolved at RUNTIME from application config (wired in
  `config/config.exs`, never a module literal in the caller), so Session
  carries no static edge onto the implementation. The `nil` fallthrough
  (absent config — the transient HOT-DEPLOY window before `config.exs`
  re-runs) is a no-op: the push is a live-render optimization, and the
  next `join_reply` / `/me` / `read_cursor_set` re-seeds the absolute
  snapshot regardless.

  Tests override `config :grappa, :window_counts_push_source, SomeStub`.
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

  @doc """
  Resolves the configured implementation, or `nil` when the key is absent
  (hot-deploy window — see moduledoc).
  """
  @spec impl() :: module() | nil
  def impl, do: Application.get_env(:grappa, :window_counts_push_source)

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
end
