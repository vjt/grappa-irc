defmodule Grappa.Session.ISupport do
  @moduledoc """
  Per-network capability table, parsed from the upstream's 005
  RPL_ISUPPORT tokens: `CHANMODES=`, `PREFIX=`, `STATUSMSG=`,
  `CASEMAPPING=`, `MONITOR=`/`WATCH=`, since #1255 `CHANTYPES=`,
  `MAXLIST=`, `NICKLEN=`, `CHANNELLEN=` and `TOPICLEN=`, and — since
  #1390 — `MODES=` and `LINELEN=`, the last two that `Session.Server`
  still scanned for itself under a merge rule of their own.

  ## Why this exists

  Two facts about a channel mode letter are network-specific and MUST come
  from the server, not a hardcoded guess:

    1. **Does it consume an argument?** `+k secret` and `+l 42` carry a
       param; `+n`/`+t`/`+s` do not. Getting this wrong misaligns the
       argument list for every mode after it in a multi-mode line.
    2. **Is it a membership (per-user) mode?** `+o alice` / `+v bob`
       decorate a *member* (→ `@`/`+` sigils), while `+b mask` /
       `+k key` decorate the *channel*. The set of membership modes and
       their rendered sigils comes from `PREFIX=`.

  Before #216 both facts were hardcoded compile-time constants in
  `Grappa.Session.EventRouter` (`@user_mode_prefixes`,
  `@channel_modes_with_param`), flagged "deferred to Phase 5". This module
  is that Phase-5 lift: the server parses CHANMODES + PREFIX at 005 and
  every consumer — the member-map walker, the channel_modes-cache walker,
  and the cic `/mode` modal (via a broadcast) — reads ONE capability
  table. `default/0` carries the exact values the old constants held, so a
  session that never sees a 005 (or a server that omits the tokens)
  behaves identically to before.

  ## CHANMODES classes (RFC 2811 §4.3, ISUPPORT `CHANMODES=A,B,C,D`)

    * **Type A** (list modes: `b`,`e`,`I`) — always take a param (add
      AND remove).
    * **Type B** (always-param: `k`) — take a param on both `+` and `-`.
    * **Type C** (set-only-param: `l`) — take a param on `+`, none on `-`.
    * **Type D** (flag modes: `n`,`t`,`m`,`s`,`i`,`p`,…) — never take a
      param.

  Membership modes (from `PREFIX`) are handled separately: they always
  consume a param (the target nick) regardless of sign, and are excluded
  from the CHANMODES classes.

  This is a stateless module — no GenServer, no Repo, no PubSub. The lone
  side effect is a diagnostic `Logger.warning` when a 005 advertises a
  `CASEMAPPING=` value we do not model (#537); parsing itself is pure.
  `Grappa.Session.Server` holds one `t()` per session on its state and
  threads it into `EventRouter` at route time.
  """

  alias Grappa.IRC.Identifier

  require Logger

  @type chanmodes :: %{
          a: [String.t()],
          b: [String.t()],
          c: [String.t()],
          d: [String.t()]
        }

  @type prefix :: %{String.t() => String.t()}

  @typedoc """
  Advertised limit of a presence-watch mechanism (#247). `:unlimited`
  when the token carries no parseable numeric value (`MONITOR`,
  `MONITOR=`, `WATCH=abc`) — the mechanism is armed, just without a
  known cap.
  """
  @type presence_limit :: pos_integer() | :unlimited

  @typedoc """
  What 005 can ADVERTISE for `/notify` (#247): IRCv3 `MONITOR`
  (solanum/Libera, OFTC), legacy `WATCH` (bahamut/Azzurra), or `:none`.
  MONITOR wins when both are advertised.

  `:ison` is deliberately absent — no ircd advertises ISON, because RFC
  1459/2812 makes it mandatory, so it can never be the answer to "what did
  005 say?". (This typedoc previously said ISON polling was out of scope and
  that a `:none` network "simply gets no live presence"; #1946 made that
  false.)
  """
  @type advertised_mechanism ::
          {:monitor, presence_limit()} | {:watch, presence_limit()} | :none

  @typedoc """
  What a SESSION can resolve to — the advertised set plus `:ison`, which is
  reached only through the 421 fallback chain (#1946). Two types rather than
  one because they answer different questions, and collapsing them would let
  `presence_mechanism/1` claim a return value it can never produce.
  """
  @type presence_mechanism :: advertised_mechanism() | :ison

  @typedoc """
  How the upstream ircd folds identifiers (nicks AND channels), from the
  005 `CASEMAPPING=` token (#537). Re-exported from
  `Grappa.IRC.Identifier`, which OWNS the fold semantics — this module
  only PARSES the 005 token into the type (`parse_casemapping/1`) and
  carries it on `t()`. See `Grappa.IRC.Identifier.normalize_casemapping/2`
  for the per-network ingress fold that maps the rfc1459 national chars
  onto their folded representative so every KEY path downstream can assume
  plain ASCII.
  """
  @type casemapping :: Identifier.casemapping()

  @typedoc """
  Advertised entry cap per type-A (list) mode letter, from `MAXLIST=`
  (#1255). `MAXLIST=beI:100` and `MAXLIST=b:100,e:100,I:100` both fold to
  the same map — the shared-budget spelling is expanded per letter, since
  no consumer can act on "these three share 100" that could not act on
  "each is capped at 100". Empty means the network advertised no cap.
  """
  @type maxlist :: %{String.t() => pos_integer()}

  @typedoc """
  Every token the upstream advertised, verbatim (#1255): `"NETWORK" =>
  "Azzurra"`, and `true` for a valueless flag like `SAFELIST`. The typed
  fields above stay the contract for everything in-tree — they carry
  parsing, validation and defaults — while this is the archive the Phase 6
  IRCv3 listener facade translates from when it has to EMIT a 005
  downstream. One 005, two readers, no second parse.

  Two boundaries, both load-bearing:

    * It NEVER goes on the cic wire. Design principle #1 is "no IRC
      parsing in the web client"; a bag of verbatim tokens shipped to
      cicchetto is IRC protocol re-entering through the window. The client
      gets the TYPED widening instead.
    * The facade must TRANSLATE, not passthrough. `NETWORK`, `MODES`,
      `TARGMAX` and `LINELEN` describe the upstream ircd and the upstream
      path; a downstream client is talking to grappa, whose framing budget
      (#246/#1108), chunking and target limits are its own. This map is
      the INPUT to that translation, never its output.
  """
  @type raw :: %{String.t() => String.t() | true}

  @type t :: %{
          chanmodes: chanmodes(),
          prefix: prefix(),
          prefix_order: [String.t()],
          statusmsg: [String.t()],
          monitor: presence_limit() | nil,
          watch: presence_limit() | nil,
          casemapping: casemapping(),
          chantypes: [String.t()],
          maxlist: maxlist(),
          nicklen: pos_integer() | nil,
          channellen: pos_integer() | nil,
          topiclen: pos_integer() | nil,
          modes: pos_integer(),
          linelen: pos_integer(),
          raw: raw()
        }

  # Pre-005 seed = the exact values the old EventRouter constants held.
  #
  # PREFIX=(ohv)@%+  — bahamut/Azzurra membership modes (o→@ op, h→%
  # halfop, v→+ voice). Matches the former @user_mode_prefixes.
  #
  # CHANMODES: the former @channel_modes_with_param MapSet was
  # `["b","e","I","k","l"]` — b/e/I list modes (type A), k always-param
  # (type B), l set-only-param (type C). Type D (flag modes) was the
  # implicit "everything else". We seed the four classes explicitly with
  # the common bahamut flag modes so `default/0` classifies a full mode
  # line correctly even before a 005 arrives.
  #
  # Classes are plain lists (not MapSets): they hold <20 single-char
  # letters, `mode in class` is trivially cheap, the shape is directly
  # JSON-encodable for the wire (no MapSet→list projection), and it stays
  # dialyzer-transparent (MapSet is opaque — a composite type embedding it
  # trips `contract_with_opaque` on the literal `default/0` return).
  @default_prefix %{"o" => "@", "h" => "%", "v" => "+"}

  # #1302 — the SAME token's mode letters, in the order PREFIX advertised
  # them: highest rank first. `@default_prefix` is a map and a map has no
  # order, so rank is a second projection of one parse rather than a fact
  # anyone can recover from the table beside it.
  @default_prefix_order ["o", "h", "v"]
  @default_chanmodes %{
    a: ["b", "e", "I"],
    b: ["k"],
    c: ["l"],
    d: ["i", "m", "n", "p", "s", "t", "r", "R", "c", "C", "D", "d"]
  }

  # #218 — STATUSMSG advertises which membership PREFIX sigils may prefix a
  # message TARGET (`NOTICE @#chan` ops-only, `PRIVMSG +#chan` voice), so a
  # message can reach only members at-or-above a status level. bahamut/
  # Azzurra advertises `@+` (op + voice). Seeded so a session strips the
  # common cases before the first 005 arrives, mirroring how the prefix +
  # chanmodes seeds carry the pre-005 bahamut values.
  @default_statusmsg ["@", "+"]

  # #537 — pre-005 / absent-token default. bahamut/Azzurra advertises
  # `CASEMAPPING=ascii` and the whole stack was built for ASCII (#525);
  # a network that omits the token, or advertises one we don't model, is
  # treated as ASCII (too-lax beats merging identities the ircd keeps
  # apart).
  @default_casemapping :ascii

  # #1255 — CHANTYPES pre-005 seed: the RFC 2812 sigil class. This is the
  # literal the whole stack already open-codes — `Identifier`'s channel
  # regex server-side, and cic's compose / slashCommands / inviteLink /
  # ScrollbackPane copies — so a network that omits the token keeps
  # behaving exactly as it did before the token was parsed at all.
  @default_chantypes ["#", "&", "+", "!"]

  # #1255 — MAXLIST and the three length limits have NO honest pre-005
  # default, and that is deliberate. Nothing in the stack caps a list or
  # validates a length today, so seeding a number would start REJECTING
  # input the ircd accepts — the opposite of "a session that never sees a
  # 005 behaves identically to before". `%{}` / `nil` mean "unadvertised",
  # which every consumer must read as "do not enforce", the same posture
  # #1108 took for the frame budget.
  @default_maxlist %{}

  # #1390 — unlike the length limits above, these two seed a NUMBER rather
  # than "unadvertised". `ModeChunker` has to pick a chunk size and
  # `LineSplit` a frame budget on the very first outbound line, long before
  # any 005 arrives, so "do not enforce" is not a value either can be handed.
  # 3 is the IRCv3 / RFC 2812 §3.2.3 de-facto minimum every major ircd meets;
  # 512 is RFC 2812's line limit. Both were the `Session.Server` state
  # defaults this module took over.
  @default_modes 3
  @default_linelen 512

  @doc """
  The pre-005 default capability table (bahamut/Azzurra values). Used as
  the initial `Session.Server` state field and as the fallback whenever a
  session state lacks an `:isupport` key (pure EventRouter unit tests).
  """
  @spec default() :: t()
  def default do
    %{
      chanmodes: @default_chanmodes,
      prefix: @default_prefix,
      prefix_order: @default_prefix_order,
      statusmsg: @default_statusmsg,
      # #247 — no presence mechanism ADVERTISED pre-005. This table only
      # records what 005 said; the arm policy (advertised pick, else an
      # optimistic WATCH probe with a 421-driven MONITOR→:none fallback,
      # per review 2026-07-19) lives in Session.Server.arm_presence/1.
      monitor: nil,
      watch: nil,
      casemapping: @default_casemapping,
      chantypes: @default_chantypes,
      maxlist: @default_maxlist,
      nicklen: nil,
      channellen: nil,
      topiclen: nil,
      modes: @default_modes,
      linelen: @default_linelen,
      raw: %{}
    }
  end

  @doc """
  Folds the `CHANMODES=` and `PREFIX=` tokens out of a 005 RPL_ISUPPORT
  param list into `current`, returning the merged table. Tokens that are
  absent leave the corresponding part of `current` unchanged; malformed
  tokens (a CHANMODES without four comma-classes, an unbalanced PREFIX)
  are ignored so a misbehaving server can never corrupt param-arity
  classification.

  **The LAST advertisement of a token wins** — within one 005 line and
  across the several lines of a burst. Every clause writes
  unconditionally, which is what draft-brocklesby-irc-isupport-03 §2
  requires: "it is not required to negate a parameter in order to change
  its value, the server should merely re-advertise the parameter with the
  new value". There is deliberately no "already set" guard: honouring the
  first occurrence would make a legitimate mid-session change
  unrepresentable (#1255 — both this docstring and the `Session.Server`
  005 handler used to claim a first-wins anti-downgrade protection that
  no code ever implemented).
  """
  @spec merge_isupport([String.t()], t()) :: t()
  def merge_isupport(params, current) when is_list(params) do
    Enum.reduce(params, current, fn param, acc ->
      merge_token(param, archive_token(param, acc))
    end)
  end

  @doc """
  Whether channel mode `mode` consumes an argument when applied with
  `sign` (`:add` for `+`, `:remove` for `-`). Type A/B always; type C on
  `:add` only; type D never. Membership modes (in `PREFIX`) are NOT
  classified here — the walkers test `user_prefix/2` first and consume
  the nick param themselves.
  """
  @spec takes_param?(t(), String.t(), :add | :remove) :: boolean()
  def takes_param?(%{chanmodes: cm}, mode, sign) when is_binary(mode) do
    cond do
      mode in cm.a -> true
      mode in cm.b -> true
      mode in cm.c -> sign == :add
      true -> false
    end
  end

  @doc """
  Whether channel mode `mode` is CHANMODES **type A** — a per-channel LIST
  (bans, ban/invite exceptions, quiets) rather than a channel flag. Sign
  independent: a list letter is a list letter on `+` and on `-`.

  RFC 2811 §4.3 / the `CHANMODES=A,B,C,D` contract: a type-A letter
  addresses a list the ircd keeps beside the channel's mode state, is never
  part of that state, and never appears in 324 RPL_CHANNELMODEIS. It is the
  CLASS twin of `takes_param?/3` (which reads the same table for ARITY):
  the mode-set walkers need both — consume the argument, drop the letter
  (#1249).

  The letter set is per-network, never a constant: bahamut/Azzurra
  advertises `bz` (no `+e`/`+I`, plus a restrict list), solanum `eIbq`.
  """
  @spec list_mode?(t(), String.t()) :: boolean()
  def list_mode?(%{chanmodes: cm}, mode) when is_binary(mode), do: mode in cm.a

  @doc """
  Resolves a membership mode letter to its rendered sigil, or `:error`
  when `mode` is not a membership (per-user) mode for this network.
  Mirrors the old `Map.fetch(@user_mode_prefixes, mode)` call the walkers
  used, so the recursive parser needs no structural change beyond the
  table source.
  """
  @spec user_prefix(t(), String.t()) :: {:ok, String.t()} | :error
  def user_prefix(%{prefix: prefix}, mode) when is_binary(mode) do
    Map.fetch(prefix, mode)
  end

  @doc """
  Whether a MODE token says anything about the CHANNEL rather than about a
  member's status prefix — the write-time denoise classification (issue
  2176).

  A status-prefix change (`+o`, `-v`, `+h`, and whatever else THIS network
  put in `PREFIX=`) is the per-JOIN churn the denoise filter exists to fold.
  Everything else a MODE line can carry — `+b`, `+k`, `+l`, `+m`, `+i`,
  `+t`, `+n`, `+s`, a ban exception, a network's own vendor letter — changes
  the channel, and an operator who cannot see a ban being set is being
  denied operator-relevant signal.

  The split is derived from `PREFIX=` and nothing else, for the reason
  `user_prefix/2` exists at all: the membership letter set is per-network.
  A hardcoded `~w[o v h]` would miscategorise `+q`/`+a` on a network that
  advertises them as churn-bearing prefixes, and would miscategorise a
  vendor status mode as structural forever.

  **A mixed token is structural if ANY letter is** (`MODE #chan +ob nick
  mask`). Showing a mixed line is the safe failure: the alternative hides a
  ban because an op grade rode the same line.

  Signs are skipped, not classified. A letter this network never advertised
  as a prefix — including the bytes of a MALFORMED token, which
  `EventRouter` persists as a transcript row even while it withholds the
  derived state (#878) — falls on the structural side by the same
  safe-failure argument. A token with no letters at all (`""`, `"+"`)
  states nothing about the channel and so is NOT structural; it is also
  already a line whose derived state was refused.
  """
  @spec structural_mode_token?(t(), String.t()) :: boolean()
  def structural_mode_token?(isupport, token) when is_map(isupport) and is_binary(token) do
    token
    |> String.graphemes()
    |> Enum.any?(&structural_mode_letter?(isupport, &1))
  end

  @spec structural_mode_letter?(t(), String.t()) :: boolean()
  defp structural_mode_letter?(_, sign) when sign in ["+", "-"], do: false
  defp structural_mode_letter?(isupport, letter), do: user_prefix(isupport, letter) == :error

  @doc """
  The membership mode letters this network advertised, HIGHEST RANK FIRST —
  the order `PREFIX=(qaohv)~&@%+` states and `prefix` cannot hold.

  This is the only place rank may be read from. The sibling map is a lookup
  table in both directions and nothing more: it is built with `Map.new/1`
  and crosses the cic wire as a JSON object, whose key order is the
  runtime's (alphabetical by letter, for a small map) rather than the
  ircd's. Those two coincide on bahamut/Azzurra — `(ohv)` sorts to `h,o,v`,
  and the only pair that would differ is re-admitted by the halfop branch
  in cic's `editorSigils` — which is why reading rank out of the map
  survived undetected on the network grappa runs on, and mis-ranked
  founders everywhere else.

  Read via `Map.get` for the same hot-reload safety as `statusmsg/1`: a
  live `Session.Server` state seeded before this field existed and read
  after the module is reloaded degrades to the bahamut order instead of
  raising.
  """
  @spec prefix_order(t()) :: [String.t()]
  def prefix_order(isupport) when is_map(isupport),
    do: Map.get(isupport, :prefix_order, @default_prefix_order)

  @doc """
  The pre-005 default PREFIX rank order (bahamut/Azzurra `(ohv)`). Exposed
  so callers and tests reference the seed through production code rather
  than duplicating the literal.
  """
  @spec default_prefix_order() :: [String.t()]
  def default_prefix_order, do: @default_prefix_order

  @doc """
  The membership SIGILS this network advertised, HIGHEST RANK FIRST —
  `["~", "&", "@", "%", "+"]` on `PREFIX=(qaohv)~&@%+`, `["@", "%", "+"]`
  pre-005. The rank-ordered projection of the same token `prefix/1` holds
  as a lookup map and `prefix_order/1` as mode letters.

  This is the source every consumer that needs the SET or the PRECEDENCE
  of membership sigils must read (issue 1999). Three sites used to carry
  their own `@ % +` copy of it and each was wrong in its own way on a
  PREFIX-rich network: `EventRouter.split_mode_prefix/2` left a `~` glued
  to the nick it prefixed (so the members map keyed a nick that does not
  exist — the reported defect), `Identifier.member_prefix/2` snapshot no
  grade at all for a founder, and `Session.Server.member_sort_tier/2`
  sorted founder and admin into the PLAIN tier at the bottom of the pane.

  Composed from the two accessors rather than stored as a third field:
  a stored copy is a parallel structure needing housekeeping, and
  `prefix_order/1` already carries the only fact the map cannot
  (`Map.values/1` comes back alphabetical BY LETTER, which on `(qaohv)`
  puts `o` in the MIDDLE — the mis-rank #1302 fixed in cic's
  `editorSigils`). Both reads are `Map.get`-defaulted, so a live
  `Session.Server` state seeded before either field existed degrades to
  the bahamut run instead of raising — and, crucially, never to `[]`,
  which would disable sigil stripping altogether. A letter the map cannot
  resolve is SKIPPED rather than emitted as `nil`; the two projections
  come from one parse and cannot disagree today, but a total accessor
  does not depend on that.
  """
  @spec sigils(t()) :: [String.t()]
  def sigils(isupport) when is_map(isupport) do
    prefix = Map.get(isupport, :prefix, @default_prefix)

    isupport
    |> prefix_order()
    |> Enum.flat_map(fn letter ->
      case Map.fetch(prefix, letter) do
        {:ok, sigil} -> [sigil]
        :error -> []
      end
    end)
  end

  @doc """
  The advertised STATUSMSG membership sigils for this network — the set a
  message target may be prefixed with to reach only members at-or-above
  that status (`@#chan` ops, `+#chan` voice). Read via `Map.get` (not
  `map.statusmsg`) so a capability table that predates the `:statusmsg`
  field — a live `Session.Server` state seeded before #218 and read after
  a hot code-reload — defaults to the bahamut set instead of raising a
  KeyError. Mirrors `Session.Server`'s
  `Map.get(state, :isupport, ISupport.default())` hot-safety; a cold
  restart reseeds the full `default/0`.
  """
  @spec statusmsg(t()) :: [String.t()]
  def statusmsg(isupport) when is_map(isupport),
    do: Map.get(isupport, :statusmsg, @default_statusmsg)

  @doc """
  The pre-005 default STATUSMSG sigils (bahamut/Azzurra `@+`). Exposed so
  callers and tests reference the seed through production code rather than
  duplicating the literal.
  """
  @spec default_statusmsg() :: [String.t()]
  def default_statusmsg, do: @default_statusmsg

  @doc """
  The ADVERTISED presence-watch mechanism for `/notify` (#247), read
  from the captured `MONITOR=`/`WATCH=` tokens. MONITOR (the IRCv3
  push mechanism with typed numerics) wins over legacy WATCH when a
  network advertises both. `:none` means "005 advertised neither" —
  NOT "don't arm": per review 2026-07-19 the arm must work
  005-independently, so `Session.Server.arm_presence/1` treats `:none`
  as "probe WATCH optimistically" and downgrades via the 421 fallback
  chain (WATCH → MONITOR → `:ison`, #1946).

  `:ison` is NEVER returned from here — no ircd advertises ISON in 005,
  because RFC 1459/2812 makes it mandatory. It is reached only through
  that chain, and it is a FALLBACK rather than a probe rung for the same
  reason: there is nothing to discover.

  Reads via `Map.get` (not pattern match on the keys) for the same
  hot-reload safety as `statusmsg/1`: a live isupport table seeded
  before #247 has no `:monitor`/`:watch` keys and must not KeyError.
  """
  @spec presence_mechanism(t()) :: advertised_mechanism()
  def presence_mechanism(isupport) when is_map(isupport) do
    cond do
      limit = Map.get(isupport, :monitor) -> {:monitor, limit}
      limit = Map.get(isupport, :watch) -> {:watch, limit}
      true -> :none
    end
  end

  @doc """
  The upstream's identifier casemapping (#537), from the 005
  `CASEMAPPING=` token. `:ascii` when the network omitted the token, when
  the value was unrecognised, or — for hot-reload safety — when the live
  isupport table predates the `:casemapping` field (`Map.get`, not a
  key pattern-match, mirroring `statusmsg/1` + `presence_mechanism/1`).
  """
  @spec casemapping(t()) :: casemapping()
  def casemapping(isupport) when is_map(isupport),
    do: Map.get(isupport, :casemapping, @default_casemapping)

  @doc """
  The pre-005 default casemapping (`:ascii`). Exposed so callers/tests
  reference the seed through production code rather than the literal.
  """
  @spec default_casemapping() :: casemapping()
  def default_casemapping, do: @default_casemapping

  @doc """
  The sigils that open a CHANNEL name on this network (#1255), from
  `CHANTYPES=`. Defaults to the RFC 2812 class the rest of the stack
  open-codes.

  Every accessor below reads via `Map.get`, never a key pattern-match, for
  the same hot-reload reason as `statusmsg/1`: a live `Session.Server`
  state seeded before these fields existed holds a table without them, and
  a plain module reload does not rewrite process state.
  """
  @spec chantypes(t()) :: [String.t()]
  def chantypes(isupport) when is_map(isupport),
    do: Map.get(isupport, :chantypes, @default_chantypes)

  @doc """
  The pre-005 default channel sigils (RFC 2812 `#&+!`). Exposed so callers
  and tests reference the seed through production code, not the literal.
  """
  @spec default_chantypes() :: [String.t()]
  def default_chantypes, do: @default_chantypes

  @doc """
  Advertised entry caps per type-A list mode (#1255), from `MAXLIST=`.
  Empty when the network advertised none — read that as "no cap known",
  never as "cap of zero".
  """
  @spec maxlist(t()) :: maxlist()
  def maxlist(isupport) when is_map(isupport),
    do: Map.get(isupport, :maxlist, @default_maxlist)

  @doc """
  The advertised maximum nick length (#1255), or `nil` when the network
  did not say. `nil` means "do not validate" — the pre-005 behaviour.
  """
  @spec nicklen(t()) :: pos_integer() | nil
  def nicklen(isupport) when is_map(isupport), do: Map.get(isupport, :nicklen)

  @doc """
  The advertised maximum channel-name length (#1255), or `nil`. See
  `nicklen/1` for why absent is not a number.
  """
  @spec channellen(t()) :: pos_integer() | nil
  def channellen(isupport) when is_map(isupport), do: Map.get(isupport, :channellen)

  @doc """
  The advertised maximum topic length (#1255), or `nil`. See `nicklen/1`
  for why absent is not a number.
  """
  @spec topiclen(t()) :: pos_integer() | nil
  def topiclen(isupport) when is_map(isupport), do: Map.get(isupport, :topiclen)

  @doc """
  The advertised `MODES=` (#1390): how many mode changes one MODE line may
  carry, which is what `Grappa.Session.ModeChunker` chunks against. Always
  a number — see `@default_modes` for why this one cannot be `nil`.

  The `Map.get/3` default is the hot-reload contract: a live session's
  table predates this field, and a plain hot reload does not rewrite
  process state.
  """
  @spec modes(t()) :: pos_integer()
  def modes(isupport) when is_map(isupport), do: Map.get(isupport, :modes, @default_modes)

  @doc """
  The advertised `LINELEN=` (#1390), the upstream's max wire-frame size —
  the number `Grappa.IRC.LineSplit` subtracts the relayed source prefix
  from to get the body budget. Always a number; see `modes/1` for the
  hot-reload fallback.
  """
  @spec linelen(t()) :: pos_integer()
  def linelen(isupport) when is_map(isupport), do: Map.get(isupport, :linelen, @default_linelen)

  @doc """
  The network's own name, the advertised `NETWORK=` value verbatim and
  undecoded (issue 2430), or `nil` when the network did not name itself (no
  token, a valueless `NETWORK`, an empty value, or a `-NETWORK`). A bot's order challenge carries the name its own
  005 gave it, and a client answers only an exact match, so absent stays
  `nil` rather than a guess: a client with nothing to compare answers
  nothing. Read off the archive (`raw/1`), not a second parse.
  """
  @spec network(t()) :: String.t() | nil
  def network(isupport) when is_map(isupport) do
    case raw(isupport) do
      %{"NETWORK" => name} when is_binary(name) and name != "" -> name
      _ -> nil
    end
  end

  @doc """
  Every token the upstream advertised, verbatim — see `t:raw/0` for what
  this is for and the two boundaries it must respect. Empty before the
  first 005.
  """
  @spec raw(t()) :: raw()
  def raw(isupport) when is_map(isupport), do: Map.get(isupport, :raw, %{})

  # ---------------------------------------------------------------------------
  # Token parsing
  # ---------------------------------------------------------------------------

  # #1255 — token name → the `t()` key a `-TOKEN` negation restores from
  # `default/0`. One entry per typed field, so adding a parsed token
  # without making it revocable is a visible omission here rather than a
  # silent one at the catch-all.
  @negatable %{
    "CHANMODES" => :chanmodes,
    "PREFIX" => :prefix,
    "STATUSMSG" => :statusmsg,
    "MONITOR" => :monitor,
    "WATCH" => :watch,
    "CASEMAPPING" => :casemapping,
    "CHANTYPES" => :chantypes,
    "MAXLIST" => :maxlist,
    "NICKLEN" => :nicklen,
    "CHANNELLEN" => :channellen,
    "TOPICLEN" => :topiclen,
    "MODES" => :modes,
    "LINELEN" => :linelen
  }

  # #1255 — draft-brocklesby-irc-isupport-03 §2: a token advertised with a
  # leading `-` is "used to negate a previously specified parameter; that
  # is, revert to the behaviour that would occur if the parameter had not
  # been specified". The behaviour-if-unspecified is exactly `default/0`,
  # so a negation RESTORES the seed — never `nil`, which would be a third
  # state ("advertised as absent") that no accessor models and every
  # consumer would have to learn.
  #
  # This clause comes FIRST: `-WATCH` must not reach the positive clauses,
  # and before #1255 it fell through to the catch-all, so a capability the
  # ircd revoked mid-session (services restart, a listener mode change)
  # stayed in the table until the next reconnect — leaving `/notify`
  # arming a mechanism nobody honours, with no presence until reconnect.
  #
  # A negation is an ordinary write, so last-wins still governs:
  # `-NICKLEN NICKLEN=9` ends advertised, `NICKLEN=9 -NICKLEN` ends
  # reverted. Negating a token we do not model is a no-op on the typed
  # table (the archive still forgets it — see `archive_token/2`).
  @spec merge_token(String.t(), t()) :: t()
  defp merge_token("-" <> token, acc) do
    case Map.fetch(@negatable, token) do
      {:ok, key} -> Map.put(acc, key, Map.fetch!(default(), key))
      :error -> acc
    end
  end

  defp merge_token("CHANMODES=" <> rest, acc) do
    case parse_chanmodes(rest) do
      {:ok, chanmodes} -> %{acc | chanmodes: chanmodes}
      :error -> acc
    end
  end

  # #1302 — one parse writes BOTH projections. `Map.put` for the order (not
  # the update syntax used for the map) because `acc` may be a table that
  # predates the `:prefix_order` field during a hot-reload window, the same
  # reason `STATUSMSG=` below uses it.
  defp merge_token("PREFIX=" <> rest, acc) do
    case parse_prefix(rest) do
      {:ok, {prefix, order}} -> Map.put(%{acc | prefix: prefix}, :prefix_order, order)
      :error -> acc
    end
  end

  # #218 — STATUSMSG=@+ : a raw run of membership sigils that may prefix a
  # message target. `Map.put` (not `%{acc | statusmsg: ...}`) because `acc`
  # may be a table that predates the `:statusmsg` field during a hot-reload
  # window; the update-syntax would KeyError on the absent key. Mirrors
  # Session.Server's `Map.put(state, :isupport, ...)` write for the same
  # reason.
  defp merge_token("STATUSMSG=" <> rest, acc) do
    case parse_statusmsg(rest) do
      {:ok, sigils} -> Map.put(acc, :statusmsg, sigils)
      :error -> acc
    end
  end

  # #247 — MONITOR/WATCH presence-mechanism advertisements. Exact-token
  # or `=`-suffixed forms only (`WATCHFOO=1` is a different token).
  # `Map.put` (not update-syntax) for the same hot-reload-window reason
  # as STATUSMSG above.
  defp merge_token("MONITOR=" <> rest, acc), do: Map.put(acc, :monitor, parse_limit(rest))
  defp merge_token("MONITOR", acc), do: Map.put(acc, :monitor, :unlimited)
  defp merge_token("WATCH=" <> rest, acc), do: Map.put(acc, :watch, parse_limit(rest))
  defp merge_token("WATCH", acc), do: Map.put(acc, :watch, :unlimited)

  # #537 — CASEMAPPING=<token>. `Map.put` (not update-syntax) for the same
  # hot-reload-window safety as STATUSMSG/MONITOR above.
  defp merge_token("CASEMAPPING=" <> rest, acc), do: Map.put(acc, :casemapping, parse_casemapping(rest))

  # #1255 — CHANTYPES=<sigils>: a bare run of the sigils that open a
  # channel name. Empty is malformed (a network with no channel sigils
  # cannot be addressed at all): keep the prior set rather than making
  # every channel name unrecognisable. `Map.put` for hot-reload safety,
  # like every clause above.
  defp merge_token("CHANTYPES=" <> rest, acc) do
    case String.graphemes(rest) do
      [] -> acc
      sigils -> Map.put(acc, :chantypes, sigils)
    end
  end

  # #1255 — MAXLIST=beI:100 / MAXLIST=b:60,e:60,I:50.
  defp merge_token("MAXLIST=" <> rest, acc) do
    case parse_maxlist(rest) do
      {:ok, caps} -> Map.put(acc, :maxlist, caps)
      :error -> acc
    end
  end

  # #1255 — the advertised length limits. A non-numeric or non-positive
  # value keeps the prior limit: an unusable cap (`NICKLEN=0` rejects every
  # nick) is worse than no cap.
  defp merge_token("NICKLEN=" <> rest, acc), do: put_limit(acc, :nicklen, rest)
  defp merge_token("CHANNELLEN=" <> rest, acc), do: put_limit(acc, :channellen, rest)
  defp merge_token("TOPICLEN=" <> rest, acc), do: put_limit(acc, :topiclen, rest)

  # #1390 — the two tokens `Session.Server` used to scan for itself, on the
  # same `put_limit/3` as the limits above. That shared arm is the point of
  # the move: a malformed value keeps the prior one instead of substituting a
  # narrower default, and the write is unconditional, so a token repeated
  # within one line lands last-wins like every other token here.
  defp merge_token("MODES=" <> rest, acc), do: put_limit(acc, :modes, rest)
  defp merge_token("LINELEN=" <> rest, acc), do: put_limit(acc, :linelen, rest)

  defp merge_token(_, acc), do: acc

  # #1255 — the verbatim archive, written for EVERY advertised token
  # (including the typed ones and the ones the typed parser rejected as
  # malformed: this records what the upstream SAID, not what we could use).
  #
  # A 005 param list is `<client> <token>... :<human-readable text>`, and
  # only the middle is tokens, so the archive filters on the draft's
  # parameter-name grammar: uppercase letters and digits. The trailing
  # text carries spaces and lowercase, and so does a normal nick, so both
  # fall out. The residual: a client whose nick is all-caps alphanumeric
  # (`VJT`) is archived as a valueless flag. That is deliberate — the
  # alternative, dropping the list head positionally, would silently eat
  # the first token whenever a caller passes a bare token list, and a
  # stray key in an archive nobody passes through is cheaper than a
  # missing typed fact. The Phase 6 facade translates from this map
  # against what it knows how to emit; it does not re-advertise it.
  @spec archive_token(String.t(), t()) :: t()
  defp archive_token("-" <> name, acc) do
    # §2 negation reverts to "as if never specified", so the archive must
    # forget the key — otherwise the facade would re-advertise downstream a
    # capability the upstream just revoked.
    if token_name?(name), do: Map.put(acc, :raw, Map.delete(raw(acc), name)), else: acc
  end

  defp archive_token(param, acc) do
    case String.split(param, "=", parts: 2) do
      [name] -> put_raw(acc, name, true)
      [name, value] -> put_raw(acc, name, value)
    end
  end

  @spec put_raw(t(), String.t(), String.t() | true) :: t()
  defp put_raw(acc, name, value) do
    if token_name?(name), do: Map.put(acc, :raw, Map.put(raw(acc), name, value)), else: acc
  end

  @token_name ~r/^[A-Z0-9]+$/
  @spec token_name?(String.t()) :: boolean()
  defp token_name?(name), do: Regex.match?(@token_name, name)

  @spec put_limit(t(), :nicklen | :channellen | :topiclen | :modes | :linelen, String.t()) :: t()
  defp put_limit(acc, key, rest) do
    case Integer.parse(rest) do
      {n, ""} when n > 0 -> Map.put(acc, key, n)
      _ -> acc
    end
  end

  # MAXLIST=<modes>:<limit>[,<modes>:<limit>...] — each entry caps a RUN of
  # mode letters, so `beI:100` expands to one cap per letter. A malformed
  # entry is dropped on its own: rejecting the whole token would silently
  # uncap every list the network DID declare correctly. A token with
  # nothing parseable at all is :error, so the prior caps survive.
  @spec parse_maxlist(String.t()) :: {:ok, maxlist()} | :error
  defp parse_maxlist(rest) do
    caps =
      rest
      |> String.split(",")
      |> Enum.flat_map(&parse_maxlist_entry/1)
      |> Map.new()

    if caps == %{}, do: :error, else: {:ok, caps}
  end

  @spec parse_maxlist_entry(String.t()) :: [{String.t(), pos_integer()}]
  defp parse_maxlist_entry(entry) do
    with [modes, limit] <- String.split(entry, ":", parts: 2),
         [_ | _] = letters <- String.graphemes(modes),
         {n, ""} when n > 0 <- Integer.parse(limit) do
      Enum.map(letters, &{&1, n})
    else
      _ -> []
    end
  end

  # A presence-mechanism limit value. Non-numeric / empty / non-positive
  # values advertise the mechanism without a usable cap → :unlimited
  # (arm it, don't reject it).
  @spec parse_limit(String.t()) :: presence_limit()
  defp parse_limit(rest) do
    case Integer.parse(rest) do
      {n, ""} when n > 0 -> n
      _ -> :unlimited
    end
  end

  # #537 — CASEMAPPING value → the modelled atom. An unrecognised value is
  # NOT a fold table we can guess: degrade to :ascii (too-lax beats merging
  # distinct identities) and log so the operator sees the unsupported
  # network. bahamut advertises `ascii`; solanum/Libera `rfc1459`.
  @spec parse_casemapping(String.t()) :: casemapping()
  defp parse_casemapping("ascii"), do: :ascii
  defp parse_casemapping("rfc1459"), do: :rfc1459
  defp parse_casemapping("rfc1459-strict"), do: :rfc1459_strict

  defp parse_casemapping(other) do
    Logger.warning("unrecognised CASEMAPPING=#{inspect(other)} — treating as :ascii")
    :ascii
  end

  # CHANMODES=A,B,C,D — four comma-separated classes of mode letters.
  # Anything other than exactly four classes is malformed (some ircds
  # advertise a 5th vendor class; we clamp to the RFC-2811 four and
  # ignore extras rather than reject, but fewer than four is a hard
  # reject — we can't know which class the missing ones belong to).
  @spec parse_chanmodes(String.t()) :: {:ok, chanmodes()} | :error
  defp parse_chanmodes(rest) do
    case String.split(rest, ",") do
      [a, b, c, d | _] ->
        {:ok,
         %{
           a: String.graphemes(a),
           b: String.graphemes(b),
           c: String.graphemes(c),
           d: String.graphemes(d)
         }}

      _ ->
        :error
    end
  end

  # PREFIX=(modes)sigils — parenthesised mode letters paired positionally
  # with the sigils that follow. `(ohv)@%+` → %{"o"=>"@","h"=>"%","v"=>"+"}.
  # The two runs MUST be equal length or the token is malformed.
  # #1302 — returns the lookup MAP and the advertised ORDER of the same
  # letters. `Map.new/1` destroys that order and nothing downstream can
  # reconstruct it, so the zip is kept: two projections, one parse, no way
  # for them to disagree about which letters exist.
  @spec parse_prefix(String.t()) :: {:ok, {prefix(), [String.t()]}} | :error
  defp parse_prefix(rest) do
    with ["", tail] <- String.split(rest, "(", parts: 2),
         [modes, sigils] <- String.split(tail, ")", parts: 2),
         mode_list = String.graphemes(modes),
         sigil_list = String.graphemes(sigils),
         true <- mode_list != [] and length(mode_list) == length(sigil_list) do
      {:ok, {mode_list |> Enum.zip(sigil_list) |> Map.new(), mode_list}}
    else
      _ -> :error
    end
  end

  # STATUSMSG=<sigils> — a bare run of membership prefix chars (`@+`,
  # `@%+`). An empty value (`STATUSMSG=`) is malformed: keep the prior set
  # rather than blanking the strip capability.
  @spec parse_statusmsg(String.t()) :: {:ok, [String.t()]} | :error
  defp parse_statusmsg(rest) do
    case String.graphemes(rest) do
      [] -> :error
      sigils -> {:ok, sigils}
    end
  end
end
