defmodule Grappa.Session.WindowState do
  @moduledoc """
  Per-channel window state tracking for `Grappa.Session.Server`.

  ## What this is

  Bundle of the four sibling maps that previously lived as separate
  fields on `Session.Server`'s state struct (`window_states`,
  `window_failure_reasons`, `window_failure_numerics`,
  `window_kicked_meta`). Cluster #6 god-module decomposition (Theme 3
  / resp-A1 / ext-A9) collapsed them into one struct so the surrounding
  state struct shrinks from 4 fields → 1 field, mutator arms become
  one-line `Map.update!/3` calls, and the snapshot projection
  (`to_wire/3`) becomes a single dispatch instead of an inline `case`.

  ## CLAUDE.md invariant: window state lives on the server

  > Window state model lives on the server. `Grappa.Session.Server`
  > owns `window_states %{channel => :pending | :joined | :failed |
  > :kicked | :parked}` + sibling `window_failure_{reasons,numerics}`
  > + `window_kicked_meta` maps. Transitions emit typed events on the
  > per-channel topic; cic's `lib/windowState.ts` mirrors via
  > `lib/subscribe.ts` dispatch. cic NEVER originates state.

  This module is the storage for that invariant. Every state
  transition emitted by `Session.Server.apply_effects/2`
  (`:joined`, `:join_failed`, `:kicked`, `:parted`) AND the
  `record_in_flight_join/2` `:pending` write goes through one of
  the 5 mutators here.

  ## Pure data, no process

  This is NOT a GenServer / Agent / Registry. It's an in-memory
  struct that lives inside `Session.Server`'s state. The session
  GenServer is the synchronization primitive (mailbox-serialized);
  bundling the maps doesn't change concurrency semantics. A session
  crash drops the struct on the floor — derived from autojoin's
  natural transition flow on respawn (per CP15 Q5 — no persistence,
  the IRC handshake re-establishes the live channels).

  ## Snapshot/event byte-identicality (CP15 B7)

  `to_wire/3` is the single-source-of-truth projection for the
  cold-WS-subscribe snapshot push. It dispatches into
  `Grappa.Session.Wire` verbs — the SAME verbs the apply_effects
  arms call at event-time. Snapshot + event-time payloads are
  therefore LITERALLY the same expression for a given window state.
  Adding a field to a Wire verb propagates to both paths
  automatically; no separate mirror to maintain.

  `:pending` returns `{:error, :not_tracked}` because cic only
  subscribes to the per-channel topic AFTER seeing `:pending` on the
  user-level topic — the per-channel snapshot path therefore has no
  work to do for a pending window. `:parked` (T32 placeholder) returns
  the same until the disconnect verbs land.
  """

  alias Grappa.Session.Wire, as: SessionWire

  @typedoc """
  Closed set of per-channel window states. Mirrors
  `Session.Server.window_state/0` (the original typedef the server
  used pre-extraction). Atoms are the on-process representation;
  the on-wire string projection is owned by `Session.Wire`.
  """
  @type window_state :: :pending | :joined | :failed | :kicked | :parked

  @typedoc """
  The bundled window-state struct. Replaces the 4 sibling fields
  on `Session.Server.state/0`. Field-shape mirrors the previous
  storage exactly so existing inline-mutation behaviors map 1:1
  onto the mutators below.
  """
  @type t :: %__MODULE__{
          states: %{String.t() => window_state()},
          failure_reasons: %{String.t() => String.t()},
          failure_numerics: %{String.t() => pos_integer()},
          kicked_meta: %{String.t() => %{by: String.t(), reason: String.t() | nil}}
        }

  defstruct states: %{},
            failure_reasons: %{},
            failure_numerics: %{},
            kicked_meta: %{}

  @doc """
  Returns an empty `WindowState`. Used by `Session.Server.init/1`.
  """
  @spec new() :: t()
  def new, do: %__MODULE__{}

  @doc """
  Marks `channel` as `:pending`. Called by
  `Session.Server.record_in_flight_join/2` (CP17) when an outbound
  JOIN is recorded as in-flight — both the `{:send_join, _}` cast
  path and the 001 RPL_WELCOME autojoin loop converge here.

  Does NOT touch `failure_reasons` / `failure_numerics` /
  `kicked_meta`. A retry after a previous `:failed` deliberately
  leaves the failure metadata in place — the next terminal
  transition (`set_joined/2` clears, `set_failed/4` overwrites,
  `set_kicked/4` clears the failure path implicitly because failures
  and kicks are mutually exclusive in a single window-state cycle)
  resolves it.
  """
  @spec set_pending(t(), String.t()) :: t()
  def set_pending(%__MODULE__{} = ws, channel) when is_binary(channel) do
    %{ws | states: Map.put(ws.states, channel, :pending)}
  end

  @doc """
  Marks `channel` as `:joined` AND clears every sibling map entry
  for that channel. Called by `apply_effects([{:joined, _} | _], _)`
  on own-nick JOIN echo.

  The clear is essential: a successful re-join after a prior
  `:failed` (operator was banned, ban got lifted, /join again) MUST
  NOT leak the old reason / numeric into the next snapshot push —
  cic would render a stale "you can't join because…" banner on a
  channel you DID join. Same for kicked metadata: re-joining after
  a kick clears the kick banner.
  """
  @spec set_joined(t(), String.t()) :: t()
  def set_joined(%__MODULE__{} = ws, channel) when is_binary(channel) do
    %__MODULE__{
      states: Map.put(ws.states, channel, :joined),
      failure_reasons: Map.delete(ws.failure_reasons, channel),
      failure_numerics: Map.delete(ws.failure_numerics, channel),
      kicked_meta: Map.delete(ws.kicked_meta, channel)
    }
  end

  @doc """
  Marks `channel` as `:failed` and records the human-readable
  `reason` + numeric code (471/473/474/475/403/405). Called by
  `apply_effects([{:join_failed, _, _, _} | _], _)` on a JOIN
  failure numeric correlated against an in-flight JOIN.

  Numerics are stable cross-language identifiers — keeping them
  alongside the upstream-language reason makes a future client-side
  i18n layer (numeric → localized template) trivial without a
  schema migration. Both fields land in the snapshot push so
  deploy-reconnects render the failure banner exactly once.
  """
  @spec set_failed(t(), String.t(), String.t(), pos_integer()) :: t()
  def set_failed(%__MODULE__{} = ws, channel, reason, numeric)
      when is_binary(channel) and is_binary(reason) and is_integer(numeric) and numeric > 0 do
    %{
      ws
      | states: Map.put(ws.states, channel, :failed),
        failure_reasons: Map.put(ws.failure_reasons, channel, reason),
        failure_numerics: Map.put(ws.failure_numerics, channel, numeric)
    }
  end

  @doc """
  Marks `channel` as `:kicked` and records the kicker (`by`) +
  optional `reason` (KICK without trailing comment carries `nil`).
  Called by `apply_effects([{:kicked, _, _, _} | _], _)` on an
  own-target KICK.

  The window stays in the active sidebar (greyed) so the operator
  can /join to retry; archiving on KICK would punish the victim.
  Snapshot push (`to_wire/3` `:kicked` arm) carries the same
  `by + reason` the event-time broadcast carries — single source.
  """
  @spec set_kicked(t(), String.t(), String.t(), String.t() | nil) :: t()
  def set_kicked(%__MODULE__{} = ws, channel, by, reason)
      when is_binary(channel) and is_binary(by) and (is_binary(reason) or is_nil(reason)) do
    %{
      ws
      | states: Map.put(ws.states, channel, :kicked),
        kicked_meta: Map.put(ws.kicked_meta, channel, %{by: by, reason: reason})
    }
  end

  @doc """
  Drops `channel` from EVERY sibling map. Called by
  `apply_effects([{:parted, _} | _], _)` on own-PART acked by
  upstream — the window archives.

  Cic projects "no key in `windowStateByChannel` + scrollback rows
  exist" as `:archived`. There is intentionally NO `kind: "parted"`
  broadcast on the per-channel topic; absence of state IS the
  signal. The alongside `:persist :part` row carries the audit feed
  line.

  No-op for unknown channels — `Map.delete/2` returns the map
  unchanged when the key is absent, so all four maps stay equal-by-
  identity.
  """
  @spec set_parted(t(), String.t()) :: t()
  def set_parted(%__MODULE__{} = ws, channel) when is_binary(channel) do
    %__MODULE__{
      states: Map.delete(ws.states, channel),
      failure_reasons: Map.delete(ws.failure_reasons, channel),
      failure_numerics: Map.delete(ws.failure_numerics, channel),
      kicked_meta: Map.delete(ws.kicked_meta, channel)
    }
  end

  @doc """
  Returns the recorded state atom for `channel`, or `nil` if the
  channel has never been tracked or has been parted.

  Callers MUST treat `nil` as "untracked" — this matches the
  pre-extraction `Map.get(state.window_states, channel)` semantics
  (the call sites that pattern-matched on `nil` for "not tracked"
  continue to work unchanged after migration).
  """
  @spec state_of(t(), String.t()) :: window_state() | nil
  def state_of(%__MODULE__{} = ws, channel) when is_binary(channel) do
    Map.get(ws.states, channel)
  end

  @doc """
  Returns the recorded failure metadata (`%{reason, numeric}`) for
  `channel`, or `nil` if the channel is not in `:failed` state.

  The `nil` fallback is structural: failure metadata is only present
  when `state_of/2` returns `:failed`. A channel in `:joined` /
  `:kicked` / `:pending` / `:parked` has no failure entry, and an
  unknown channel has no entry either.
  """
  @spec failure_meta(t(), String.t()) ::
          %{reason: String.t(), numeric: pos_integer()} | nil
  def failure_meta(%__MODULE__{} = ws, channel) when is_binary(channel) do
    case Map.get(ws.failure_reasons, channel) do
      nil ->
        nil

      reason ->
        %{reason: reason, numeric: Map.get(ws.failure_numerics, channel)}
    end
  end

  @doc """
  Returns the recorded kick metadata (`%{by, reason}`) for `channel`,
  or `nil` if the channel is not in `:kicked` state.

  The `nil` fallback is structural — same reasoning as
  `failure_meta/2`. `reason` inside the returned map is itself
  nullable (KICK without trailing comment).
  """
  @spec kicked_meta(t(), String.t()) ::
          %{by: String.t(), reason: String.t() | nil} | nil
  def kicked_meta(%__MODULE__{} = ws, channel) when is_binary(channel) do
    Map.get(ws.kicked_meta, channel)
  end

  @doc """
  Snapshot projection — single source of truth for the
  cold-WS-subscribe snapshot push.

  Dispatches into `Grappa.Session.Wire` verbs so the snapshot
  payload is LITERALLY the same expression as the event-time
  broadcast for the same state. CP15 B7 invariant: snapshot +
  event-time MUST be byte-identical, and now they're function-
  identical too.

  Returns `{:ok, payload}` for terminal states (`:joined` /
  `:failed` / `:kicked`) and `{:error, :not_tracked}` for
  unknown channels, `:pending` (broadcast on user-topic, not
  per-channel — snapshot path has nothing to do), and `:parked`
  (T32 placeholder; cic doesn't yet render this state).
  """
  @spec to_wire(t(), String.t(), String.t()) ::
          {:ok, Grappa.Session.window_state_snapshot()} | {:error, :not_tracked}
  def to_wire(%__MODULE__{} = ws, network_slug, channel)
      when is_binary(network_slug) and is_binary(channel) do
    case state_of(ws, channel) do
      :joined ->
        {:ok, SessionWire.joined(network_slug, channel)}

      :failed ->
        {:ok,
         SessionWire.join_failed(
           network_slug,
           channel,
           Map.get(ws.failure_reasons, channel),
           Map.get(ws.failure_numerics, channel)
         )}

      :kicked ->
        meta = Map.get(ws.kicked_meta, channel, %{by: nil, reason: nil})
        {:ok, SessionWire.kicked(network_slug, channel, meta.by, meta.reason)}

      _ ->
        {:error, :not_tracked}
    end
  end
end
