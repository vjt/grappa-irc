defmodule GrappaWeb.MessagesJSON do
  @moduledoc """
  Phoenix view layer for `Grappa.Scrollback.Message` rows.

  Thin web-layer adapter: `index/1` and `show/1` follow Phoenix's
  render-function naming convention and delegate to
  `Grappa.Scrollback.Wire.to_json/1` — the single source of truth for
  the public JSON wire shape.

  Per CLAUDE.md "no leaky abstractions: each context owns its
  domain. Return domain types" — wire shape is a domain concern (the
  same shape ships over REST, PubSub broadcasts, Phoenix Channel
  pushes, and the eventual Phase 6 IRCv3 `CHATHISTORY` listener
  facade). It lives in `Grappa.Scrollback.Wire`, not here.
  """

  alias Grappa.Scrollback.{Message, Wire}

  @typedoc "`GET …/messages/count` without `?cap=`: the threshold count AND its display split (#2037)."
  @type split_count_response :: %{
          count: non_neg_integer(),
          messages: non_neg_integer(),
          events: non_neg_integer()
        }

  @typedoc "`GET …/messages/count?cap=N`: the threshold count alone (issue 2282) — see `count/1`."
  @type capped_count_response :: %{count: non_neg_integer()}

  # Named arms, not an inline object union: the committed `wireTypes.ts` has
  # zero `} | {` unions, and `A | B` of aliases is a shape the generator
  # already emits (the sibling note in `GrappaWeb.AuthJSON`).
  @type count_response :: split_count_response() | capped_count_response()

  @doc "Renders the `:index` action — a flat JSON array of message maps."
  @spec index(%{messages: [Message.t()]}) :: [Wire.t()]
  def index(%{messages: messages}), do: Enum.map(messages, &Wire.to_json/1)

  @doc """
  Renders the `:show` action — a single serialized message map.

  Takes the network slug explicitly (#1657b). `:show` renders a row that
  was JUST persisted, and the persist boundary no longer preloads
  `:network` — so this is `to_json/2`, while `index/1` above stays on
  `to_json/1` because its rows come out of a query that preloaded.
  """
  @spec show(%{message: Message.t(), network_slug: String.t()}) :: Wire.t()
  def show(%{message: message, network_slug: slug}), do: Wire.to_json(message, slug)

  @doc """
  Renders the `:count` action (#693) — the uncapped row count after an
  anchor. An object rather than a bare integer so the shape stays
  additive: a future sibling figure (say, a tail id) is a new key, not a
  breaking change of the response type. #2037 is that future arriving.

  ## Three numbers, because the route answers TWO questions (#2037)

  `count` is the THRESHOLD's feed and is unchanged from #693: raw rows a
  `?after=` page would return, own-authored included. cic's
  `isFarBehind(gap)` asks "is contiguous paging achievable", which is a
  question about rows on the wire, and the #2037 ruling puts it out of
  scope explicitly.

  `messages` + `events` are the DISPLAY split — the same
  `@content_kinds`-vs-rest partition `ReadCursor.bulk_unread_split/3`
  seeds the sidebar pills with. The far-behind bar renders `messages`,
  so the bar and the bold pill are the same quantity rather than two
  opinions about one.

  All three come from ONE `resolve_hide_presence/3` in the caller, so
  the split can never be resolved on a different presence posture than
  the count — which is precisely the divergence #2037 measured between
  the two `PresenceFilter.Resolver` doors.

  ## ONE number, when the caller asked only the threshold (issue 2282)

  `split: nil` is the `?cap=` mode and renders `{"count": N}` alone. The
  missing keys are not an omission to paper over with zeros: zero is a
  perfectly good answer to "how many messages" and the caller would have no
  way to tell it from "not asked". A `cap` caller holds its own cap, so
  `count == cap` is all it needs to read "at least cap".

  The two shapes are separate CLAUSES rather than one clause with a
  conditional merge, so a `split` that is neither a `count_split()` nor
  `nil` is a FunctionClauseError here instead of a body missing keys the
  client requires.
  """
  @spec count(%{count: non_neg_integer(), split: Grappa.Scrollback.count_split() | nil}) ::
          count_response()
  def count(%{count: n, split: %{messages: messages, events: events}}),
    do: %{count: n, messages: messages, events: events}

  def count(%{count: n, split: nil}), do: %{count: n}
end
