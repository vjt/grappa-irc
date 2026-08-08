defmodule Grappa.IRC.Identifier do
  @moduledoc """
  Validators for IRC and Grappa-internal identifiers, applied at the
  producing boundary (Config network builder for operator config,
  `Grappa.Scrollback.Message` changeset for persistence).

  Architecture review findings A9 + A10: identifiers were unvalidated
  `String.t()` everywhere — a TOML typo with whitespace, or a malformed
  channel name from upstream, would silently round-trip through the
  system, corrupt PubSub topic routing (network_id with `/` in it
  splits the topic), or pollute web-client output via the wire shape.

  Regex-based validation here is intentionally tight; identifier
  syntax is well-defined by RFC 2812 (nick, channel) and DNS (host).
  Internal identifiers (network_id) are constrained to the safest
  subset (lowercase alphanumeric + dash + underscore) so they can be
  used in URLs, log lines, and PubSub topics without escaping.

  `valid_*?/1` predicates accept any term and return `false` for
  non-binaries — convenient at the changeset boundary where the input
  may be `nil` or another type.

  ## Two SSOTs live here, and the second is easy to miss

  This module owns the identifier FOLD (`canonical_target/1` and its
  network-aware `/2`) — that much is in the name. Since #1038 it ALSO owns
  the composite `(network, channel)` KEY: `channel_key/2` and its paired
  `decode_channel_key/1`. The two belong together because the composite is
  *defined* as `"<slug> <folded target>"` — it is the fold plus a separator,
  and splitting them across modules is how a third builder gets written by
  someone who reasonably concludes "Identifier is the folding module".

  The composite is a CROSS-STACK contract with cic's `channelKey(slug, name)`
  (`cicchetto/src/lib/channelKey.ts`), byte-pinned in `IdentifierTest`. Two
  server consumers key on it today — the presence-filter pins
  (`Grappa.PresenceFilter.Resolver`, which delegates here) and the
  per-conversation mute (`Grappa.UserSettings` + `Grappa.Push.Triggers`,
  #1038). A third one MUST call `channel_key/2`, never re-interpolate the
  shape.
  """

  @typedoc """
  How an upstream ircd folds identifiers (nicks AND channels), from the
  005 `CASEMAPPING=` token (#537). The Identifier module OWNS this type
  because it owns the fold semantics; `Grappa.Session.ISupport` parses
  the 005 token INTO it and re-exports it for its own `t()`.

    * `:ascii` — fold `A-Z` only (bahamut/Azzurra); also the absent /
      unrecognised default.
    * `:rfc1459` — additionally fold the national quartet `[ ] \\ ~` →
      `{ } | ^` (solanum/Libera).
    * `:rfc1459_strict` — the bracket trio `[ ] \\`, NOT `~`.

  `normalize_casemapping/2` maps the rfc1459 national chars onto their
  folded representative once at the ingress door, so every KEY path
  downstream can assume plain ASCII and route through `canonical_target/1`.
  """
  @type casemapping :: :ascii | :rfc1459 | :rfc1459_strict

  # RFC 2812 §2.3.1 — `nickname = ( letter / special ) *8( letter /
  # digit / special / "-" )`. Dash is tail-only; first char is
  # letter-or-special. Total length ≤ 30 (IRCd-modern cap; RFC's 9 is
  # widely violated). Pre-fix the leading-`-` in the first-char class
  # let `mix grappa.bind_network --nick -foo` clear both Credential
  # validate and Identifier validate, only to land `:nick_rejected`
  # (432 ERR_ERRONEUSNICKNAME) at the upstream and restart-loop the
  # supervised Session.
  @nick_regex ~r/^[A-Za-z\[\]\\`_^{|}][\w\[\]\\`_^{|}\-]{0,29}$/

  # The nick length cap `@nick_regex` enforces (letter/special + up to 29
  # more = 30 total). Exposed via `truncate_nick/1` so seed paths can coerce
  # an over-long-but-charset-valid candidate — e.g. a 1..64-char account
  # `User.name`, whose charset is a strict subset of the nick charset, so
  # only its length can exceed the cap — into a VALID nick instead of
  # dead-ending on validation (#481 fresh-user self-serve accretion). MUST
  # stay equal to the `{0,29}` bound above.
  @max_nick_length 30

  # RFC 2812 §2.3.1: channels start with #, &, +, or ! and exclude
  # space, comma, BELL (0x07). At least one body char; length ≤ 50
  # including the prefix.
  @channel_regex ~r/^[#&+!][^\s,\x07]{1,49}$/

  # GH #152 — the IRC `ident` (the `user` slot of `nick!user@host`, sent
  # in the USER command's first param). Free-form, non-unique — validated
  # for SHAPE only: RFC-2812 `user`-charset subset (letters, digits, `.`,
  # `_`, `-`), 1..10 chars. Cap 10 is the common ircd `USERLEN` (vjt
  # ruling B). Excludes `@` (would split `user@host`), whitespace (would
  # split the USER wire token), and a leading `~` — see
  # `sanitize_ident/1` for the tilde anti-spoof rationale. The regex is
  # deliberately NARROWER than `@nick_regex` (no bracket chars): ident is
  # the identd username, not a nick. Anchored with `\A...\z` (NOT
  # `^...$`): in PCRE `$` matches before a trailing `\n`, so `^...$` would
  # ACCEPT `grp\n` and let a newline-terminated ident reach the USER wire
  # line (CRLF injection). `\z` matches only the true end of string.
  @ident_regex ~r/\A[A-Za-z0-9._-]{1,10}\z/

  # Grappa-internal: lowercase alphanum + dash + underscore, 1-32 chars.
  # Used as URL path segment, PubSub topic component, log key value.
  # The cap is 32 (not 64 like the legacy `Network` schema's
  # `validate_length`) — A18 unified the rule here.
  @network_slug_regex ~r/^[a-z0-9_\-]{1,32}$/

  # Host: non-empty, no whitespace, no control chars. DNS-level rules
  # checked at connect time — this rejects only obviously-malformed
  # input. Accepts hostnames, IPv4 literals, and `[ipv6]` literals.
  @host_regex ~r/^[^\s\x00-\x1f\x7f]+$/

  # Meta-sender marker for non-IRC-originated rows (e.g. REST POSTs by
  # the local operator before auth lands). Bracketed token: `<local>`,
  # `<system>`, etc.
  @meta_sender_regex ~r/^<[^>\s]+>$/

  # UX-4 bucket G: closed allowlist of well-known IRC services nicks.
  # Pre-bucket-G the source-of-truth was split — `Grappa.Session.Server`
  # carried this list (for outbound PRIVMSG no-persist routing) and
  # `Grappa.Session.EventRouter` carried a `~r/Serv$/i` regex (for
  # inbound NOTICE $server routing). The regex was tighter than the
  # allowlist for outbound (regression: bucket H/S4 lifecycle proved
  # `Conserv` / `Dataserv` / `Reserv` are real ops nicks that MUST NOT
  # be misclassified as services). Bucket G unifies on the allowlist so
  # every door uses the same predicate.
  # #371: seenserv / statserv / debugserv are Azzurra (bahamut)
  # pseudo-services. Absent from the allowlist their inbound NOTICEs
  # fell through `route_non_channel_notice_non_chanserv/2`'s `valid_nick?`
  # arm and opened a stray per-nick query window instead of landing on
  # the synthetic `$server` channel. Added in lockstep with the cic-side
  # twin in `cicchetto/src/lib/servicesSender.ts`.
  @services ~w(nickserv chanserv memoserv operserv botserv hostserv helpserv rootserv seenserv statserv debugserv)

  @doc "True iff the input is a syntactically valid IRC nickname."
  @spec valid_nick?(term()) :: boolean()
  def valid_nick?(s) when is_binary(s), do: Regex.match?(@nick_regex, s)
  def valid_nick?(_), do: false

  @doc """
  Clamp `nick` to the IRCd nick length cap (`#{@max_nick_length}` chars).

  A LENGTH clamp, not a sanitiser — charset is NOT coerced. The caller must
  pass a candidate whose only possible nick-invalidity is length (e.g. a
  `User.name`, a strict subset of the nick charset). An already-short input
  passes through unchanged; a charset-invalid input stays invalid.

  > #### Never use in a match/compare path {: .warning}
  >
  > This is ADDITIVE and ORTHOGONAL to the identity fold (`canonical_target/1`
  > / `nick_fold/1` / `nick_fold_sql/1`) — it does NOT touch identity. It is
  > a one-way, lossy SEED helper for producing a *presentable* nick from a
  > longer string. It MUST NEVER be wired into a nick lookup, equality,
  > cache key, or any fold/MATCH site: two distinct identities can truncate
  > to the same prefix, so using it to COMPARE would collapse them (the
  > inverse of the #121/#364 fork the fold prevents). The codebase is the
  > instruction set — this paragraph is the paletto that stops a future
  > session from cabling a length-clamp into an identity path.
  """
  @spec truncate_nick(String.t()) :: String.t()
  def truncate_nick(nick) when is_binary(nick), do: String.slice(nick, 0, @max_nick_length)

  @doc """
  The nick length ceiling this module enforces (`#{@max_nick_length}`).

  Exposed for #676's 433 collision-fallback ladder, which needs an explicit
  cap argument for `collision_fallback/3`: the upstream `NICKLEN` is NOT
  knowable at 433 time (005 RPL_ISUPPORT only arrives after 001), so the
  caller passes this ceiling until an ircd truncation proves a smaller one.
  """
  # The spec is the LITERAL, not `pos_integer()`: Dialyzer's success typing
  # for a constant getter is the constant, and a supertype spec is a
  # `contract_supertype` error under this project's settings. Change the
  # constant and this spec fails loudly — as does `max_nick_length/0`'s
  # test, which pins it against what `valid_nick?/1` actually accepts.
  @spec max_nick_length() :: 30
  def max_nick_length, do: @max_nick_length

  @doc """
  Builds a collision-fallback nick: `base` with `suffix` appended, clamped
  to `cap` by trimming the BASE.

  The suffix is load-bearing, so it is the part that always survives. An
  ircd silently truncates an over-long NICK to its `NICKLEN`; a builder
  that let the clamp eat the suffix would hand back the exact nick the
  server just rejected, and #676's retry ladder would spin to exhaustion
  against a collision it can never escape.

  `cap` must leave room for at least one base character — callers derive
  it from `max_nick_length/0` or from an observed truncation, both of
  which are far above any suffix we generate.
  """
  @spec collision_fallback(String.t(), String.t(), pos_integer()) :: String.t()
  def collision_fallback(base, suffix, cap)
      when is_binary(base) and is_binary(suffix) and is_integer(cap) and
             cap > byte_size(suffix) do
    String.slice(base, 0, cap - String.length(suffix)) <> suffix
  end

  # Nick-tail charset for `random_nick_suffix/0`: lowercase alphanumerics
  # only. A strict subset of `@nick_regex`'s tail class, so appending one
  # to a valid base always yields a valid nick — and it dodges the
  # national/bracket chars whose case-folding is CASEMAPPING-dependent
  # (#537), keeping a generated nick identical under every fold table.
  @nick_suffix_alphabet ~c"abcdefghijklmnopqrstuvwxyz0123456789"
  @nick_suffix_length 3

  @doc """
  A random #{@nick_suffix_length}-char nick suffix for #676's collision
  ladder (36³ = 46 656 draws).

  Random, not another underscore: vjt's ruling is that once `<nick>_` is
  ALSO taken, stacking underscores walks straight into the next occupied
  slot on a busy network, while a random tail almost certainly does not.

  The lone impure function in this module — it draws from `:rand`.
  Callers that need determinism (the FSM `step/2` path) take the suffix as
  DATA rather than calling this per step.
  """
  @spec random_nick_suffix() :: String.t()
  def random_nick_suffix do
    for _ <- 1..@nick_suffix_length, into: "", do: <<Enum.random(@nick_suffix_alphabet)>>
  end

  @doc "True iff the input is a syntactically valid IRC channel name."
  @spec valid_channel?(term()) :: boolean()
  def valid_channel?(s) when is_binary(s), do: Regex.match?(@channel_regex, s)
  def valid_channel?(_), do: false

  @doc """
  Strips a SINGLE leading `~` from a user-supplied IRC ident (GH #152).

  ## Why strip the tilde (the anti-spoof guard)

  grappa runs no identd. An IRC server that cannot verify a client's
  ident via the identd protocol tilde-prefixes it (`~foo`) to mark it
  **unverified**. If we let a user set their ident to `~verified`, the
  upstream would present `nick!~verified@host` — visually
  indistinguishable from an identd-*checked* `verified` on a network
  that DOES run identd. Stripping a user-supplied leading tilde is the
  whole anti-spoof guard (vjt ruling B): the client cannot masquerade
  as identd-verified.

  Strips only ONE tilde so `~~evil` sanitizes to `~evil`, which then
  fails `valid_ident?/1` — stripping all leading tildes would silently
  accept the spoof attempt as `evil`. Sanitize, don't reject the whole
  input: a bare `~foo` is a legitimate "I typed the tilde out of habit"
  and becomes `foo`.

  Non-binary input passes through unchanged (mirrors `canonical_target/1`
  — the changeset boundary may see `nil`).
  """
  @spec sanitize_ident(term()) :: term()
  def sanitize_ident("~" <> rest), do: rest
  def sanitize_ident(other), do: other

  @doc """
  True iff the input is a syntactically valid IRC ident (GH #152) — the
  `user` slot of `nick!user@host`. Shape only: RFC-2812 `user`-charset
  subset (`A-Za-z0-9._-`), 1..10 chars, no leading `~` (must be
  sanitized off via `sanitize_ident/1` at the producing boundary, NOT
  accepted here), no `@`, no whitespace.

  ident is a free-form, NON-unique attribute (GH #152 design note) —
  this is a shape validator, never a uniqueness key. Sibling to
  `valid_nick?/1` / `valid_channel?/1`; the single source of truth for
  the ident shape, applied at both changeset boundaries (Credential +
  Visitor).
  """
  @spec valid_ident?(term()) :: boolean()
  def valid_ident?(s) when is_binary(s), do: Regex.match?(@ident_regex, s)
  def valid_ident?(_), do: false

  @doc """
  Returns the canonical ASCII-folded form of any Grappa identifier KEY — a
  channel, a DM-peer nick, or the `$server` pseudo-channel — the single
  source of truth for case-insensitive identifier matching across the
  server (GH #121 nicks + #364 channels, narrowed to ASCII by #525,
  unified into ONE fold by #537).

  ## One byte-level ASCII fold for every shape

  Azzurra runs **bahamut**, which advertises `CASEMAPPING=ascii` in 005 AND
  implements plain ASCII folding in the ircd (`src/match.c` `tolowertab[]`
  maps `A-Z` → `a-z` and leaves `[ \\ ] ^ ~` untouched). It applies that
  SAME fold to channels and nicks, so grappa does too: `fold_ascii/1` folds
  `A-Z` only. A channel sigil (`# & ! +`) sits outside `A-Z` and passes
  through, so folding the whole string equals `sigil <> fold(body)`; a nick
  or `$server` folds identically. `#chan[1]` vs `#chan{1}` and `foo[1]` vs
  `foo{1}` stay DISTINCT (only `A-Z` folds — the #525 posture, reversing the
  #364 rfc1459 over-fold / "ghost in the nicklist").

  This REPLACES the former sigil-gated `canonical_channel/1` (which left a
  nick verbatim) and `canonical_nick/1` (#537): every identifier KEY folds
  the SAME way now, so the write key and the case-insensitive read key
  derive from one fold. Display forms (`dm_with`, sender badge) stay RAW —
  only KEYS fold; call this at every identifier KEY boundary, never on a
  display value.

  ## ASCII-only, by design

  Byte-level ASCII (`A-Z` only), NOT Unicode `String.downcase/1`: bahamut
  compares byte-wise, and the migration backfill folds in pure SQL via
  `lower()` (ASCII-only), so an Elixir Unicode downcase would diverge from
  the stored folded column for any non-ASCII identifier. UTF-8 multibyte
  (≥ `0x80`) passes through untouched (`#CAFÉ` and `#café` stay DISTINCT).
  Non-binary input passes through unchanged (the folded-column changeset
  boundary may see `nil`).

  Network-aware ingress (rfc1459 national chars) is `canonical_target/2`,
  which normalises via `normalize_casemapping/2` THEN folds here. Its
  query-side twin for SQL is `nick_fold/1` / `nick_fold_sql/1` (plain
  `lower()`, byte-pinned to the migration indexes).
  """
  @spec canonical_target(term()) :: term()
  def canonical_target(name) when is_binary(name), do: fold_ascii(name)

  def canonical_target(other), do: other

  @doc """
  The composite `(network, channel)` KEY — `"<slug> <folded target>"`.

  The server side of cic's `channelKey(slug, name)`
  (`cicchetto/src/lib/channelKey.ts`), and the SINGLE place that shape is
  built. `target` is folded through `canonical_target/1` so any casing
  resolves to one key; a nick folds identically to a channel (a sigil sits
  outside `A-Z`), which is why the same function serves a DM peer.

  The SLUG is interpolated VERBATIM — cic folds only `name`, so folding the
  slug here would build a different string for any slug carrying an
  uppercase byte and the two stacks would key one conversation apart.

  The separator is a space, which neither a slug nor an IRC channel name may
  contain (RFC 2812 excludes 0x20 from chanstring), so `decode_channel_key/1`
  can split on the first one unambiguously.
  """
  @spec channel_key(String.t(), String.t()) :: String.t()
  def channel_key(network_slug, target)
      when is_binary(network_slug) and is_binary(target),
      do: "#{network_slug} #{canonical_target(target)}"

  @doc """
  Splits a composite key back into `{slug, target}`, or `:error`.

  Paired with `channel_key/2` so the shape has one encoder and one decoder:
  a second hand-rolled `String.split(key, " ")` is how the two drift the day
  the separator changes.

  `:error` covers everything that is not a well-formed ChannelKey —
  no separator, an empty half, a non-binary. A key with no separator is the
  BARE shape (a pre-#1038 stored mute, or a mute written by a cic bundle
  older than #1038): it is not a ChannelKey, and every caller drops it
  rather than guessing which network it meant. That posture predates #1038 —
  `Grappa.PresenceFilter.Resolver` has read pins this way since they shipped.
  """
  @spec decode_channel_key(term()) :: {:ok, {String.t(), String.t()}} | :error
  def decode_channel_key(key) when is_binary(key) do
    case String.split(key, " ", parts: 2) do
      [slug, target] when slug != "" and target != "" -> {:ok, {slug, target}}
      _ -> :error
    end
  end

  def decode_channel_key(_), do: :error

  @doc """
  Maps the rfc1459 "national" characters onto their folded representative
  for a given network `casemapping` — the per-network INGRESS normaliser
  that precedes the ASCII fold (#537, axis 2).

  ## The two-step fold

  bahamut/Azzurra is `CASEMAPPING=ascii`: it folds ONLY `A-Z`, so the four
  national chars `[ ] \\ ~` are ordinary distinct bytes (`#foo[1]` and
  `#foo{1}` are TWO channels — the #525 posture). solanum/Libera advertise
  `CASEMAPPING=rfc1459`: RFC 2812 §2.2 makes `{ } | ^` the *lowercase
  equivalents* of `[ ] \\ ~`, so those two spellings are ONE channel.

  Rather than teach `canonical_target/1` (and its byte-pinned SQL twin
  `nick_fold_sql/1`, which MUST stay plain `lower()`) three different fold
  tables, the fold is split in two: this function maps the national chars
  ONCE at the ingress door where the network's casemapping is known (only
  the Server sees the 005), and every downstream KEY path then folds `A-Z`
  via `canonical_target/1`. The composition
  `normalize_casemapping(x, cm) |> canonical_target()` is the full
  network-aware casefold; on `:ascii` the first step is a no-op and the
  behaviour is byte-for-byte the pre-#537 ASCII fold.

    * `:ascii` — identity (national chars are meaningful, distinct bytes).
    * `:rfc1459` — `[`→`{`, `]`→`}`, `\\`→`|`, `~`→`^`.
    * `:rfc1459_strict` — the bracket trio only; `~` stays `~` (RFC 1459
      predates the tilde rule RFC 2812 added).

  Byte-level, so UTF-8 multibyte (≥ `0x80`) passes untouched — the four
  national chars are all `< 0x80` and never appear as continuation bytes,
  mirroring `fold_ascii/1`. Non-binary input passes through unchanged
  (mirrors `canonical_target/1`). Idempotent under `:rfc1459`/`_strict`:
  the fold targets `{ } | ^` are not in any source set.
  """
  @spec normalize_casemapping(term(), casemapping()) :: term()
  def normalize_casemapping(s, :ascii), do: s

  def normalize_casemapping(s, :rfc1459) when is_binary(s), do: national_fold(s, true)

  def normalize_casemapping(s, :rfc1459_strict) when is_binary(s), do: national_fold(s, false)

  def normalize_casemapping(other, cm) when cm in [:rfc1459, :rfc1459_strict], do: other

  @doc """
  The full network-aware identifier KEY fold (#537, axis 2) — the SINGLE
  primitive every INGRESS routes a user-typed or upstream target through:
  `normalize_casemapping/2` for the network's `casemapping`, then the
  plain-ASCII `canonical_target/1`.

  Wire/display forms stay RAW; only KEYS fold. The three ingress classes
  each supply the casemapping from where they can reach it — the
  `Session.Server` + `EventRouter` from `state.isupport` (005-derived),
  the web edge (controllers, `GrappaChannel` topic join) from
  `Grappa.Session.casemapping/2`.

  On `:ascii` (bahamut/Azzurra, pre-005, hot-reload-absent isupport) the
  normalize step is a no-op, so this is byte-for-byte the arity-1 ASCII
  fold on every ASCII network (all of production). Non-binary passes
  through (mirrors both delegates).
  """
  @spec canonical_target(term(), casemapping()) :: term()
  def canonical_target(target, casemapping),
    do: target |> normalize_casemapping(casemapping) |> canonical_target()

  # The rfc1459 national-char fold. `fold_tilde?` distinguishes `:rfc1459`
  # (folds `~`→`^`, RFC 2812) from `:rfc1459_strict` (bracket trio only,
  # RFC 1459). Byte-level for the same UTF-8-safety reason as `fold_ascii/1`.
  @spec national_fold(binary(), boolean()) :: binary()
  defp national_fold(s, fold_tilde?),
    do: for(<<c <- s>>, into: "", do: <<national_byte(c, fold_tilde?)>>)

  defp national_byte(?[, _), do: ?{
  defp national_byte(?], _), do: ?}
  defp national_byte(?\\, _), do: ?|
  defp national_byte(?~, true), do: ?^
  defp national_byte(c, _), do: c

  # The shared ASCII byte fold — the SINGLE in-memory casemapping for
  # both nicks (#121) and channels (#364), corrected to plain ASCII in
  # #525. Azzurra (bahamut) advertises `CASEMAPPING=ascii` in 005 AND
  # implements plain ASCII folding in the ircd (`tolowertab[]` leaves
  # `[ \\ ] ^ ~` untouched), NOT the rfc1459 the stack originally assumed.
  # So this folds ONLY `A-Z` → lower; the four "national" chars
  # `[ ] \\ ~` pass through UNCHANGED — the ircd keeps `foo[1]`/`foo{1}`
  # and `#chan[1]`/`#chan{1}` distinct, so the bouncer must too or it
  # merges two identities the network keeps apart (the #525 over-fold).
  # Byte-level so UTF-8 multibyte (≥ 0x80) passes untouched, matching the
  # ASCII-only SQLite `lower()` the fold migrations embed.
  # `canonical_target/1` folds the whole identifier (channel or nick);
  # sigils sit outside `A-Z`, so they pass straight through and the body
  # folds identically for both shapes.
  @spec fold_ascii(binary()) :: binary()
  defp fold_ascii(s), do: for(<<c <- s>>, into: "", do: <<fold_ascii_byte(c)>>)

  defp fold_ascii_byte(c) when c in ?A..?Z, do: c + 32
  defp fold_ascii_byte(c), do: c

  @doc """
  Ecto query fragment applying the ASCII nick fold to a column
  expression — the **query-side twin** of `canonical_target/1`, for
  matching a column against a folded unique index (GH #121, #525).

  Derives the folded key in SQL so no denormalised column is stored
  (mirrors how `query_windows` indexes `lower(target_nick)`). Plain
  ASCII `lower()` (#525 dropped the four rfc1459 bracket `replace()`s);
  the SQL text MUST stay character-identical to the folded-index
  expression in the `network_credentials` / `query_windows` /
  `notify_entries` migrations, or SQLite won't recognise the query as
  index-eligible.

  The caller must `require Grappa.IRC.Identifier` (macro) and have
  `Ecto.Query` imported (the expanded `fragment/2` resolves in the
  caller's context). #211 phase 7 — the folded-nick index lives on
  `network_credentials` now (the `visitors` scalar + its index were
  dropped), so the query targets a credential:

      from c in Credential,
        where:
          Identifier.nick_fold(c.nick) == ^Identifier.canonical_target(input) and
            c.network_id == ^network_id
  """
  defmacro nick_fold(column) do
    quote do
      fragment("lower(?)", unquote(column))
    end
  end

  @doc """
  The ASCII fold as a raw SQL expression over a literal column name —
  the SINGLE SOURCE for callers that must embed the fold outside Ecto's
  fragment path (`:unsafe_fragment` conflict targets, index-expression
  audits). Byte-identical to `nick_fold/1`'s fragment and to the live
  folded-index migrations; the pin test in `IdentifierTest` fails if
  either ever drifts (SQLite drops an expression index the moment the
  query-side string differs by one byte). #525 narrowed this from the
  rfc1459 four-`replace()` form to plain `lower()`.
  """
  @spec nick_fold_sql(String.t()) :: String.t()
  def nick_fold_sql(column) when is_binary(column) do
    "lower(#{column})"
  end

  @doc """
  True iff the input is a valid Grappa network slug (lowercase
  alphanumeric + dash + underscore, 1-32 chars). Tighter than IRC
  proper because it doubles as a URL path segment and PubSub topic
  component.

  This is the single source of truth — `Grappa.Networks.Network`'s
  changeset delegates here (A18). Renaming this function or the
  underlying regex requires updating both that callsite and the
  Identifier test.
  """
  @spec valid_network_slug?(term()) :: boolean()
  def valid_network_slug?(s) when is_binary(s), do: Regex.match?(@network_slug_regex, s)
  def valid_network_slug?(_), do: false

  @doc """
  True iff the input is exactly one IRC mode letter — a single ASCII
  letter, either case.

  The mode LETTER SET is per-ircd (bahamut's `+iwxs`, solanum's
  `+DQZagiow`, extension-registered letters) and grappa deliberately
  stays agnostic to it — but the mode letter CLASS is closed by the
  RFC-2812 §3.1.5/§3.2.3 grammar: a mode block is a run of signs and
  ALPHA, nothing else. That class is the boundary contract for every
  upstream-supplied mode token (#279), and it is the widest rule that
  still rejects the fuzzed `221 RPL_UMODEIS` param (spaces, punctuation,
  control bytes) which used to fold into the per-session umode set
  verbatim.

  Digits and the signs themselves are NOT mode letters: `+`/`-` are the
  sign alphabet the walkers consume separately, and no ircd registers a
  numeric mode char.
  """
  @spec valid_mode_letter?(term()) :: boolean()
  def valid_mode_letter?(<<c>>) when c in ?a..?z or c in ?A..?Z, do: true
  def valid_mode_letter?(_), do: false

  @doc """
  True iff the input is a non-empty hostname-or-IP-shaped string. DNS
  validity is not checked — the connect attempt is the canonical
  authority.
  """
  @spec valid_host?(term()) :: boolean()
  def valid_host?(s) when is_binary(s) and s != "", do: Regex.match?(@host_regex, s)
  def valid_host?(_), do: false

  @doc """
  True iff the input is a valid sender label. Accepts:

    * IRC nicks (`vjt`)
    * Server names (host shape)
    * The prefix-less anonymous-sender sentinel
      (`Grappa.IRC.Message.anonymous_sender/0`, currently `"*"`)
    * `<bracketed>` meta-sender markers for non-IRC origins (REST etc.)

  L-irc-1: the `"*"` sentinel is owned by `Grappa.IRC.Message`; the
  comparison routes through `Message.anonymous_sender/0` so both
  modules share a single source of truth instead of mirrored magic
  strings.
  """
  @spec valid_sender?(term()) :: boolean()
  def valid_sender?(s) when is_binary(s) do
    s == Grappa.IRC.Message.anonymous_sender() or
      Regex.match?(@meta_sender_regex, s) or
      valid_nick?(s) or valid_host?(s)
  end

  def valid_sender?(_), do: false

  @doc """
  True iff the input is safe to place on an IRC line — no embedded CR
  (`\\r`), LF (`\\n`), or NUL (`\\x00`). RFC 2812 §2.3 forbids all
  three; an attacker that smuggles any of them into a target or body
  field would terminate the current line and append an arbitrary
  follow-up command (CRLF injection).

  Used by `Grappa.IRC.Client.send_*` and the `Grappa.Session` facade
  to gate every public outbound helper. The raw `Client.send_line/2`
  escape hatch is intentionally NOT guarded — it is the SASL chain's
  bytes-in/bytes-out contract.
  """
  @spec safe_line_token?(term()) :: boolean()
  def safe_line_token?(s) when is_binary(s),
    do: not String.contains?(s, ["\r", "\n", "\x00"])

  def safe_line_token?(_), do: false

  @doc """
  True iff `s` is a non-empty single-token field safe to ship as one
  whitespace-delimited slot of an IRC command (e.g. `OPER <name>
  <password>`). Rejects empty string, any ASCII whitespace, and
  CR/LF/NUL (the safe_line_token? superset).

  Stricter than `safe_line_token?/1`: an OPER `name` containing a
  space would split into multiple wire-tokens and the bouncer would
  emit `OPER first second <password>\\r\\n` — the IRC server would
  parse name=first, password=second, with the real password leaking
  into a positional slot. Same for `password`: IRC OPER takes a
  single-token password — a multi-word value is silently truncated to
  the first token by the server, leaving the operator with an
  inexplicable 464 ERR_PASSWDMISMATCH.

  Used by `Grappa.IRC.Client.send_oper/3` and the
  `Grappa.Session.send_oper/4` facade to gate both fields. Stricter
  rule lives here so future verbs that need single-token semantics
  (e.g. SASL plain) share one predicate instead of re-implementing it.
  """
  @spec safe_oper_token?(term()) :: boolean()
  def safe_oper_token?(s) when is_binary(s) and s != "" do
    not String.contains?(s, ["\r", "\n", "\x00", " ", "\t"])
  end

  def safe_oper_token?(_), do: false

  @doc """
  True iff `s` is the nick of a well-known IRC services entity (NickServ,
  ChanServ, MemoServ, OperServ, BotServ, HostServ, HelpServ, RootServ,
  SeenServ, StatServ, DebugServ). Case-insensitive. Channel-sigil targets (`#`, `&`, `+`, `!`) are by
  definition NOT services (PRIVMSG to a channel goes to the room, not a
  service bot) and return `false` without further inspection.

  UX-4 bucket G: single source of truth shared by
  `Grappa.Session.Server` (outbound PRIVMSG-to-*serv: wire-only, no
  scrollback row so credential bodies don't leak — W12), `Grappa.Session.EventRouter`
  (inbound PRIVMSG/NOTICE from *serv: persist on the synthetic
  `"$server"` channel so the messages land in the server-messages
  window instead of auto-opening a query window), and
  `GrappaWeb.MessagesController` (REST POST classification, indirectly
  via Session.send_privmsg). The closed allowlist intentionally rejects
  candidates like `Conserv` / `Dataserv` / `Reserv` (real ops nicks on
  some networks) — bucket H lifecycle/S4 burned us on a broader
  `String.ends_with?("serv")` substring match that silently dropped
  legitimate user traffic.
  """
  @spec services_sender?(term()) :: boolean()
  def services_sender?("#" <> _), do: false
  def services_sender?("&" <> _), do: false
  def services_sender?("+" <> _), do: false
  def services_sender?("!" <> _), do: false

  def services_sender?(s) when is_binary(s), do: String.downcase(s) in @services

  def services_sender?(_), do: false

  # Channel-membership sigil precedence: op > halfop > voice. Mirrors
  # cic's `memberSigil` (@ > % > +) so server snapshot and client render
  # agree on which glyph a multi-moded member shows.
  @member_prefix_precedence ["@", "%", "+"]

  @doc """
  The highest-precedence membership sigil (`@`/`%`/`+`) in a member's
  mode-sigil list, or `nil` for a plain member / empty list / non-list.

  `state.members[channel][nick]` stores sigils (`["@"]`, `["@", "+"]`,
  `[]`); this reduces them to the single glyph cic shows. Used at
  scrollback-persist time to SNAPSHOT a content row's sender grade into
  `meta.sender_prefix`, so a later MODE change can't retroactively
  re-prefix historical lines (#25).
  """
  @spec member_prefix(term()) :: String.t() | nil
  def member_prefix(sigils) when is_list(sigils) do
    Enum.find(@member_prefix_precedence, &(&1 in sigils))
  end

  def member_prefix(_), do: nil
end
