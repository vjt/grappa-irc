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

  @doc "True iff the input is a syntactically valid IRC nickname."
  @spec valid_nick?(term()) :: boolean()
  def valid_nick?(s) when is_binary(s), do: Regex.match?(@nick_regex, s)
  def valid_nick?(_), do: false

  @doc "True iff the input is a syntactically valid IRC channel name."
  @spec valid_channel?(term()) :: boolean()
  def valid_channel?(s) when is_binary(s), do: Regex.match?(@channel_regex, s)
  def valid_channel?(_), do: false

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
end
