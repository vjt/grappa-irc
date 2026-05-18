defmodule Grappa.Session.PartCleanup do
  @moduledoc """
  Self-PART local state cleanup — single source for the eager-PART path.

  Used by `Grappa.Session.Server.handle_cast({:send_part, _}, _)`
  (UX-4 bucket H: PART-fail still closes window). The eviction list
  matches — but does NOT share code with — the inline mutation in
  `Grappa.Session.EventRouter`'s `do_route(:part, _)` self-PART arm
  (which runs when upstream PART echo arrives). Keeping the two arms
  separate is intentional: EventRouter's arm produces a `:persist :part`
  audit row + a `:parted` effect consumed by Server's `apply_effects/2`,
  both of which depend on the upstream message having actually arrived.
  This helper is the audit-row-less cousin for the eager intent path.

  Per-channel local-state evicted on every call:

    * `state.members[channel]`
    * `state.topics[canonical(channel)]`
    * `state.channel_modes[canonical(channel)]`
    * `state.channels_created[canonical(channel)]`
    * `state.userhost_cache` — nicks that shared ONLY the parted channel
    * `state.window_state` (via `WindowState.set_parted/2`)
    * `state.seeded_channels` — the MapSet entry (optional field)

  Idempotent on already-absent channels — `Map.delete/2`,
  `MapSet.delete/2`, and `WindowState.set_parted/2` are all no-ops when
  the key/channel is missing. This matters for the two scenarios the
  bucket H fix needs:

    * Eager wipe of a channel we never joined (cast handler fires;
      upstream rejects with 442 ERR_NOTONCHANNEL): every map already
      lacks the key — the helper is a no-op except for the
      `channels_changed` broadcast the caller fires afterwards.
    * Eager wipe of a channel we joined (cast handler fires; upstream
      eventually echoes PART): the eager call drops everything; the
      later EventRouter PART-echo runs its own inline cleanup on
      already-empty state — no double drop, no crash.

  ## Case-canonicalisation contract

  `cleanup_local/2` canonicalises `channel` ONCE at the top via
  `Identifier.canonical_channel/1` and uses the canonical key for EVERY
  map and MapSet delete — `members`, `topics`, `channel_modes`,
  `channels_created`, `seeded_channels`, and the `WindowState`
  projection alike. Callers MAY pass mixed-case (`"#Italia"`) and the
  helper will wipe whether the underlying state was keyed at canonical
  (`"#italia"`) or original casing.

  Per CLAUDE.md "implement once, reuse everywhere" — the bucket-H cast
  handler used to inline the same five-map mutation. This module
  extracts the shape so a future per-channel cache extension (e.g.
  ISUPPORT PREFIX overrides) lands here once.
  """

  alias Grappa.IRC.Identifier
  alias Grappa.Session.WindowState

  @typedoc """
  Minimal local-state shape `cleanup_local/2` consumes + returns.
  Matches the slice of `Grappa.Session.Server.state/0` that mutates on
  self-PART; the actual Server state struct has many more fields that
  `cleanup_local/2` leaves untouched via the `_ => _` open-map rest.

  `:seeded_channels` is optional — EventRouter's PART self-arm passes a
  state map without it (pre-PartCleanup-extraction shape); Session.Server
  always carries it. The cleanup_local body tolerates both via the
  `Map.get(state, :seeded_channels)` guard.
  """
  @type state_slice :: %{
          required(:members) => %{String.t() => map()},
          required(:topics) => map(),
          required(:channel_modes) => map(),
          required(:channels_created) => map(),
          required(:userhost_cache) => map(),
          required(:window_state) => WindowState.t(),
          optional(:seeded_channels) => MapSet.t(String.t()),
          optional(any()) => any()
        }

  @doc """
  Returns `state` with all per-channel local-state caches evicted for
  `channel`. See moduledoc for the full eviction list + idempotency
  guarantees.
  """
  @spec cleanup_local(state_slice(), String.t()) :: state_slice()
  def cleanup_local(state, channel) when is_binary(channel) do
    # Canonicalise ONCE — every map / MapSet / WindowState delete below
    # uses the canonical key so callers passing mixed-case ("#Italia")
    # wipe state regardless of whether the underlying caches were keyed
    # at canonical ("#italia") or original casing.
    canonical = Identifier.canonical_channel(channel)
    parted_members = Map.keys(Map.get(state.members, canonical, %{}))
    new_members = Map.delete(state.members, canonical)

    new_cache =
      evict_orphan_userhosts(
        parted_members,
        new_members,
        Map.get(state, :userhost_cache, %{})
      )

    seeded =
      case Map.get(state, :seeded_channels) do
        nil -> nil
        %MapSet{} = set -> MapSet.delete(set, canonical)
      end

    base = %{
      state
      | members: new_members,
        topics: Map.delete(Map.get(state, :topics, %{}), canonical),
        channel_modes: Map.delete(Map.get(state, :channel_modes, %{}), canonical),
        channels_created: Map.delete(Map.get(state, :channels_created, %{}), canonical),
        userhost_cache: new_cache,
        window_state: WindowState.set_parted(state.window_state, canonical)
    }

    if seeded == nil, do: base, else: %{base | seeded_channels: seeded}
  end

  # For each nick that was in the parted channel, drop it from the
  # userhost cache iff it no longer shares any channel with us.
  defp evict_orphan_userhosts(nicks, new_members, cache) do
    Enum.reduce(nicks, cache, fn nick, acc ->
      if shares_channel?(new_members, nick),
        do: acc,
        else: Map.delete(acc, String.downcase(nick))
    end)
  end

  defp shares_channel?(members, nick) do
    Enum.any?(members, fn {_, ch_members} -> Map.has_key?(ch_members, nick) end)
  end
end
