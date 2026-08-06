defmodule Grappa.PresenceFilter do
  @moduledoc """
  The server-side decision "should the scrollback fetch HIDE presence rows
  (join/part/quit/nick_change) for this channel?" — the twin of cic's
  `resolvePresenceVisible` (`cicchetto/src/lib/presenceFilter.ts`), INVERTED:
  cic asks "is presence VISIBLE?" at render time; the server asks "should the
  REST fetch OMIT presence?" at query time (#458).

  ## Why a server twin at all

  The per-channel show/hide preference has been server-owned since #449
  (`Grappa.UserSettings` display prefs, cross-device convergence). #458 makes
  the server *act* on it so `limit` counts VISIBLE rows — one page-up is one
  screenful instead of a page that renders empty on a busy channel. cic keeps
  its render-layer filter for the LIVE WS tail (presence events stay
  load-bearing there — members store, windowState, #372 re-key, own-JOIN
  auto-focus); the server filters only the HISTORY read paths. The two paths
  answer different questions, so the rule is expressed once per language —
  like `canonical_nick`/`nickEquals`. Keep them in lockstep:
  `@large_channel_threshold` MUST equal cic's `LARGE_CHANNEL_THRESHOLD`.

  ## The tri-state (must not flatten to a boolean — #449/#458 paletto)

  The stored pref is `"show" | "hide" | unset` (unset = channel key absent
  from the map). An explicit choice WINS; unset follows the LIVE member count
  against the size threshold. The server evaluates this itself from its own
  members snapshot (`Grappa.Session.list_members/3`) — it never receives a
  pre-flattened boolean from the client, so every device converges on the same
  server-owned decision.

  ## The suppressed KIND set lives in the schema, not here

  Unlike cic's `presenceFilter.ts` (which co-locates the kind set with the
  rule), the server keeps ALL kind sets in the kinds SSOT
  (`Grappa.Scrollback.Message.suppressed_presence_kinds/0`, alongside
  `content_kinds/0` / `notify_kinds/0`). This module owns only the threshold +
  precedence rule; the query-side exclusion reads the kind list from `Message`.
  """

  use Boundary, top_level?: true, deps: [], exports: []

  # MUST equal cic's `LARGE_CHANNEL_THRESHOLD` (presenceFilter.ts): 200+ member
  # channels drown in join/part/quit, so an unset channel that has grown this
  # large hides presence by the size default. Raised from 50 to 200 in #915 —
  # a 50-member channel does not drown, and auto-denoising it hid traffic the
  # operator wanted. Nothing FAILS if this drifts from cic's constant: the
  # server would omit presence from the REST history page while cic renders it
  # on the live tail, for every channel sized between the two values.
  @large_channel_threshold 200

  @doc """
  The member-count cutoff for the unset size default. Exposed so callers and
  tests reference the constant instead of hard-coding its value (which would
  drift from cic's `LARGE_CHANNEL_THRESHOLD` silently).
  """
  # Constant accessor — Dialyzer narrows the success typing to the literal,
  # so the honest `pos_integer()` spec reads as a supertype. Keep the general
  # spec (the value is a tunable, not a contract on it) and silence the noise.
  @dialyzer {:nowarn_function, large_channel_threshold: 0}
  @spec large_channel_threshold() :: pos_integer()
  def large_channel_threshold, do: @large_channel_threshold

  @doc """
  Whether the fetch should HIDE presence rows for a channel, given its stored
  tri-state pref and live member count.

    * `"hide"` → `true`  (explicit override wins, count irrelevant)
    * `"show"` → `false` (explicit override wins, count irrelevant)
    * unset (`nil`) → `member_count >= large_channel_threshold/0` (size default)
    * unset with an unavailable count (`nil`) → `false`

  The last clause is decision D (#458): with no live session the member count
  is unknowable, so an unset channel defaults to SHOW — never hide history on a
  guess. Inverse of cic's `resolvePresenceVisible/2`.
  """
  # The pref is a string closed set ("show"/"hide"/absent) that Elixir typespecs
  # cannot express as literals — `String.t()` is the tightest spec, so Dialyzer
  # sees it as a supertype of the pattern-matched success typing. Same idiom as
  # `UserSettings.default_display_prefs/0`; the closed set is enforced by the
  # clauses + `get_display_prefs/1` dropping non-show/hide values.
  @dialyzer {:nowarn_function, hidden?: 2}
  @spec hidden?(String.t() | nil, non_neg_integer() | nil) :: boolean()
  def hidden?("hide", _), do: true
  def hidden?("show", _), do: false

  def hidden?(nil, member_count) when is_integer(member_count),
    do: member_count >= @large_channel_threshold

  def hidden?(nil, nil), do: false
end
