defmodule Grappa.PresenceFilter.Resolver do
  @moduledoc """
  The I/O half of the presence decision: fetch the two inputs
  `Grappa.PresenceFilter.hidden?/2` needs — the server-owned tri-state pref
  (#449) and the LIVE member count — and apply the rule.

  ## Why this is a module and not three private helpers

  #458 introduced the resolution as private helpers inside
  `GrappaWeb.MessagesController`, where the only consumer was the history
  fetch. #505 gives it three more consumers on two different sides of the
  app — the `join_reply` seed, the per-message `window_counts` push
  (`Grappa.WindowCounts.Pusher`, NOT a web module), and the `/me` cold-load
  — and the issue's own instruction is to reuse the resolver rather than
  fork the precedence rule. Four copies of "read the pref, maybe count the
  members, apply the rule" is exactly how a tri-state quietly becomes four
  slightly different tri-states.

  ## Why its OWN top-level boundary

  It cannot live anywhere that already has these deps:

    * `Grappa.WindowCounts` is the natural-looking home, but `Grappa.Session`
      deps `Grappa.WindowCounts` — so `WindowCounts → Session` would close a
      Boundary cycle.
    * `Grappa.PresenceFilter` is deliberately dep-free ("owns only the
      threshold + precedence rule"). Giving the pure rule module a Repo and
      a GenServer call would make it untestable as a rule.
    * `GrappaWeb` has the deps, but it is the web boundary and `Pusher` —
      which needs this — cannot depend on it.

  So it sits in its own `top_level?: true` boundary ABOVE its callers. Same
  inversion, for the same reason, as `Grappa.WindowCounts.Pusher`.

  ## One rule, two shapes

  `hidden?/4` answers for ONE window; `hidden_channels/3` answers for the
  whole subject at once (the `/me` cold-load, which must stay at a constant
  number of queries — #396). Both bottom out in the SAME
  `PresenceFilter.hidden?/2` call, so the tri-state precedence and the size
  threshold are evaluated in exactly one place:

    * an explicit `"hide"` / `"show"` pin wins, count irrelevant;
    * unset follows the live member count against the threshold;
    * unset with an unknowable count (no live session, or the channel has
      not yet observed its NAMES burst) SHOWS — decision D of #458, never
      hide history on a guess.

  ## The pin key is not folded on read

  A pin is stored under the composite `ChannelKey`
  (`"<slug> <folded channel>"`), built and parsed by
  `Grappa.IRC.Identifier.channel_key/2` + `decode_channel_key/1` — the
  cross-stack SSOT shared with cic's `channelKey` and, since #1038, with the
  per-conversation mute. That builder folds the channel being LOOKED UP so
  any casing resolves to the same pin. The stored key itself is taken
  verbatim in the bulk path.
  That is deliberate: re-folding stored keys there would make the bulk path
  honour a legacy raw-cased pin that `hidden?/4` misses, and one rule with
  two behaviours is the thing this module exists to prevent.
  """

  use Boundary,
    top_level?: true,
    deps: [
      Grappa.IRC,
      Grappa.PresenceFilter,
      Grappa.Session,
      Grappa.Subject,
      Grappa.UserSettings
    ]

  alias Grappa.IRC.Identifier
  alias Grappa.{PresenceFilter, Session, Subject, UserSettings}

  @doc """
  Whether the history reads + unread seed should HIDE presence rows for one
  `(subject, network, channel)` window.

  `Session.list_members/3` is called ONLY when the pref is unset — an
  explicit pin needs no count, so the common case skips the GenServer
  round-trip entirely.
  """
  @spec hidden?(Subject.t(), String.t(), integer(), String.t()) :: boolean()
  def hidden?(subject, network_slug, network_id, channel)
      when is_binary(network_slug) and is_integer(network_id) and is_binary(channel) do
    pins = UserSettings.get_display_prefs(subject).presence_filter
    pref = Map.get(pins, Identifier.channel_key(network_slug, channel))

    PresenceFilter.hidden?(pref, member_count_for_unset(pref, subject, network_id, channel))
  end

  @doc """
  The hiding channels for the WHOLE subject, as
  `%{network_slug => MapSet.of(channel)}` — the shape
  `Grappa.ReadCursor.bulk_unread_split/3` excludes on.

  Keyed by slug, not network id, because the pin itself is
  (`"<slug> <channel>"`). That matters for a network whose session is not
  live: it is absent from `own_nicks` (which comes from
  `Grappa.Push.BadgeCount.live_nick_windows/1`), so an id-keyed set could
  not carry its pins — and a pref outlives the session that motivated it.

  A slug with no hiding channel is absent from the result rather than
  mapping to an empty set.

  ## `windows` — why the window universe is a parameter

  `windows` is the caller's `%{slug => %{channel => _}}` envelope (`/me`
  passes its cursor envelope verbatim; only the KEYS are read). It is not a
  convenience: without it the answer to "does this network still have an
  UNSET channel?" is undecidable here, because the pins alone cannot bound
  the set of channels that EXIST. With it, two things follow:

    * the member-count call is SKIPPED for a network whose every window
      carries an explicit pin — the count is then irrelevant to every
      decision, so asking for it is pure waste;
    * the resulting MapSets contain only real windows, so the `IN` list
      pushed into the bulk statement is bounded by the subject's window
      count instead of by everything the session happens to be joined to.

  Channels outside `windows` are correctly ignored: `bulk_unread_split/3`
  is driven `FROM read_cursors`, so a channel with no cursor contributes no
  row to filter.

  ## This re-adds a per-network GenServer call at cold-load — deliberately

  #498 removed the per-network `GenServer.call` from the `/me` path by
  moving the own-nick lookup onto a cheap `Registry` read, and explicitly
  REJECTED resolving through `Grappa.Session` at count time for that reason
  (DESIGN_NOTES 2026-07-28, option (c)). The size default cannot follow the
  nick onto the Registry: a member count changes on every JOIN/PART, so
  mirroring it into the registry value means maintaining a parallel copy
  that drifts (CLAUDE.md design discipline, rule 1) — worse than the call
  it saves. #505 therefore puts ONE call per live network back, and only
  when that network has at least one unset window.

  The bound is per NETWORK per cold-load — not per window, not periodic —
  so the #396 property that actually matters (a CONSTANT number of DB
  queries regardless of window count) is untouched. Recorded in
  DESIGN_NOTES 2026-08-05.
  """
  @spec hidden_channels(
          Subject.t(),
          %{String.t() => {integer(), String.t()}},
          %{String.t() => map()}
        ) :: %{String.t() => MapSet.t(String.t())}
  def hidden_channels(subject, own_nicks, windows)
      when is_map(own_nicks) and is_map(windows) do
    pins = parse_pins(UserSettings.get_display_prefs(subject).presence_filter)

    Enum.reduce(windows, %{}, fn {slug, slug_windows}, acc ->
      slug_pins = Map.get(pins, slug, %{})
      channels = Map.keys(slug_windows)
      slug_counts = counts_for_unset(subject, own_nicks, slug, channels, slug_pins)

      hiding =
        Enum.filter(channels, fn channel ->
          PresenceFilter.hidden?(Map.get(slug_pins, channel), Map.get(slug_counts, channel))
        end)

      case hiding do
        [] -> acc
        hiding -> Map.put(acc, slug, MapSet.new(hiding))
      end
    end)
  end

  # ---------------------------------------------------------------------------
  # Private
  # ---------------------------------------------------------------------------

  # An explicit pin makes the count irrelevant — skip the GenServer call.
  @spec member_count_for_unset(String.t() | nil, Subject.t(), integer(), String.t()) ::
          non_neg_integer() | nil
  defp member_count_for_unset(nil, subject, network_id, channel) do
    case Session.list_members(subject, network_id, channel) do
      {:ok, members} when is_list(members) -> length(members)
      # :uninitialized (NAMES not yet seeded) or :no_session — the count is
      # unknowable, and `PresenceFilter.hidden?/2` reads nil as SHOW.
      _ -> nil
    end
  end

  defp member_count_for_unset(_, _, _, _), do: nil

  # `%{"<slug> <channel>" => pref}` → `%{slug => %{channel => pref}}`, via the
  # ChannelKey decoder paired with the builder `hidden?/4` writes with. A key
  # without a separator is not a ChannelKey and is dropped rather than guessed
  # at — the posture #1038 reused for a bare (pre-network) mute key.
  @spec parse_pins(%{String.t() => String.t()}) :: %{String.t() => %{String.t() => String.t()}}
  defp parse_pins(presence_filter) do
    Enum.reduce(presence_filter, %{}, fn {key, pref}, acc ->
      case Identifier.decode_channel_key(key) do
        {:ok, {slug, channel}} ->
          Map.update(acc, slug, %{channel => pref}, &Map.put(&1, channel, pref))

        :error ->
          acc
      end
    end)
  end

  # `%{channel => count}` for ONE network's windows — or `%{}` without
  # asking, whenever the count cannot change any decision. Both skips are
  # exact, not heuristic:
  #
  #   * every window of this slug carries an explicit pin, so
  #     `PresenceFilter.hidden?/2` short-circuits on the pin for every one
  #     of them and the count is dead weight;
  #   * the network has no live session, so it is absent from `own_nicks`
  #     and there is nothing to ask.
  #
  # An empty result lands the unset channels on decision D (SHOW) — the
  # same answer `hidden?/4` gives for `{:error, :no_session}`. Never hide
  # history on a guess.
  @spec counts_for_unset(
          Subject.t(),
          %{String.t() => {integer(), String.t()}},
          String.t(),
          [String.t()],
          %{String.t() => String.t()}
        ) :: %{String.t() => non_neg_integer()}
  defp counts_for_unset(subject, own_nicks, slug, channels, slug_pins) do
    with true <- Enum.any?(channels, &(not Map.has_key?(slug_pins, &1))),
         {:ok, {network_id, _}} <- Map.fetch(own_nicks, slug),
         {:ok, counts} <- Session.list_member_counts(subject, network_id) do
      counts
    else
      _ -> %{}
    end
  end
end
