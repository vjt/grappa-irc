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

  # RFC 2812 §2.3.1 plus modern-IRC permissiveness on length: first
  # char letter or special; rest letter / digit / special; total ≤ 31.
  @nick_regex ~r/^[A-Za-z\[\]\\`_^{|}\-][\w\[\]\\`_^{|}\-]{0,30}$/

  # RFC 2812 §2.3.1: channels start with #, &, +, or ! and exclude
  # space, comma, BELL (0x07). At least one body char; length ≤ 50
  # including the prefix.
  @channel_regex ~r/^[#&+!][^\s,\x07]{1,49}$/

  # Grappa-internal: lowercase alphanum + dash + underscore, 1-32 chars.
  # Used as URL path segment, PubSub topic component, log key value.
  @network_id_regex ~r/^[a-z0-9_\-]{1,32}$/

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
  True iff the input is a valid Grappa network identifier (lowercase
  alphanumeric + dash + underscore, 1-32 chars). Tighter than IRC
  proper because it doubles as a URL path segment and PubSub topic
  component.
  """
  @spec valid_network_id?(term()) :: boolean()
  def valid_network_id?(s) when is_binary(s), do: Regex.match?(@network_id_regex, s)
  def valid_network_id?(_), do: false

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
    * The prefix-less marker `"*"`
    * `<bracketed>` meta-sender markers for non-IRC origins (REST etc.)
  """
  @spec valid_sender?(term()) :: boolean()
  def valid_sender?(s) when is_binary(s) do
    s == "*" or Regex.match?(@meta_sender_regex, s) or valid_nick?(s) or valid_host?(s)
  end

  def valid_sender?(_), do: false
end
