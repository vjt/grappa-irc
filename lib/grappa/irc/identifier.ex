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
  """

  # RFC 2812 §2.3.1 — `nickname = ( letter / special ) *8( letter /
  # digit / special / "-" )`. Dash is tail-only; first char is
  # letter-or-special. Total length ≤ 30 (IRCd-modern cap; RFC's 9 is
  # widely violated). Pre-fix the leading-`-` in the first-char class
  # let `mix grappa.bind_network --nick -foo` clear both Credential
  # validate and Identifier validate, only to land `:nick_rejected`
  # (432 ERR_ERRONEUSNICKNAME) at the upstream and restart-loop the
  # supervised Session.
  @nick_regex ~r/^[A-Za-z\[\]\\`_^{|}][\w\[\]\\`_^{|}\-]{0,29}$/

  # RFC 2812 §2.3.1: channels start with #, &, +, or ! and exclude
  # space, comma, BELL (0x07). At least one body char; length ≤ 50
  # including the prefix.
  @channel_regex ~r/^[#&+!][^\s,\x07]{1,49}$/

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
  @services ~w(nickserv chanserv memoserv operserv botserv hostserv helpserv rootserv)

  @doc "True iff the input is a syntactically valid IRC nickname."
  @spec valid_nick?(term()) :: boolean()
  def valid_nick?(s) when is_binary(s), do: Regex.match?(@nick_regex, s)
  def valid_nick?(_), do: false

  @doc "True iff the input is a syntactically valid IRC channel name."
  @spec valid_channel?(term()) :: boolean()
  def valid_channel?(s) when is_binary(s), do: Regex.match?(@channel_regex, s)
  def valid_channel?(_), do: false

  @doc """
  Returns the canonical lowercase form of a channel name. Non-channel
  input (nicks, the synthetic `$server` pseudo-channel, anything not
  prefixed with a RFC-2812 sigil `#&+!`) is passed through verbatim —
  case is meaningful for nicks (CTCP visibility row's `dm_with`, sender
  badge display) and the `$server` marker is fixed-case by intent.

  UX-4 bucket A: IRC channel names are case-insensitive per RFC 2812
  §1.3; storing them case-sensitive caused `#Chan` and `#chan` to route
  to different windows, scrollback rows, read-cursors, and PubSub
  topics. Canonicalize at every channel-bearing boundary
  (`Grappa.Session` entry API, `Grappa.Session.EventRouter` channel
  param extraction, schema changesets defense-in-depth, PubSub
  topic builder, backfill migration) so the rest of the codebase
  observes a single key per channel regardless of upstream-or-input
  casing.

  The sigil-aware predicate is shared with `Grappa.Scrollback.target_kind/1`
  (M7 2026-05-08) — promoting this to the IRC identifier namespace so
  every channel-touching context can apply it without depending on
  Scrollback. Non-binary input returns unchanged.
  """
  @spec canonical_channel(term()) :: term()
  def canonical_channel(<<sigil::utf8, _::binary>> = name)
      when sigil in [?#, ?&, ?!, ?+],
      do: String.downcase(name)

  def canonical_channel(name), do: name

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
  ChanServ, MemoServ, OperServ, BotServ, HostServ, HelpServ).
  Case-insensitive. Channel-sigil targets (`#`, `&`, `+`, `!`) are by
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
