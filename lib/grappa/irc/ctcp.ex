defmodule Grappa.IRC.CTCP do
  @moduledoc """
  CTCP framing classification.

  CTCP messages ride inside a normal PRIVMSG body wrapped in `\\x01`
  delimiters: `\\x01<VERB> <args>\\x01`. The only verb that earns its own
  scrollback kind today is `ACTION` (what `/me` emits); every other verb
  (VERSION, PING, DCC, …) persists as a plain `:privmsg` until Phase 5+.

  This module is the single source of truth for "is this body a CTCP
  ACTION frame?". Both the inbound path (`Grappa.Session.EventRouter`,
  classifying a received PRIVMSG) and the outbound path
  (`Grappa.Session.Server`, classifying the operator's own self-echoed
  send) MUST agree — issue #14 was exactly the two paths drifting: the
  inbound classifier said `:action`, the outbound persist hardcoded
  `:privmsg`, so the operator's own `/me` rendered as raw `<nick> ACTION
  text` in cic. `Grappa.IRC.LineSplit` also calls this to decide whether
  to preserve the ACTION envelope across wire-frame fragments.

  Per CLAUDE.md "IRC is bytes" — the classifier matches on raw bytes
  (`\\x01` == `0x01`), never on a decoded string.
  """

  @doc """
  True iff `body` opens with the CTCP ACTION frame `\\x01ACTION ` (note
  the mandatory space separating the verb from its argument).

  Lenient on the closing `\\x01`: CTCP's trailing delimiter is optional
  and some clients omit it, so the classification keys only on the
  opening frame. `\\x01ACTION\\x01` (no space) is NOT an ACTION frame —
  it carries no argument and matches the stricter verb-only shape.
  """
  @spec action?(binary()) :: boolean()
  def action?(<<0x01, "ACTION ", _::binary>>), do: true
  def action?(_), do: false

  @doc """
  True iff `body` is CTCP-framed at all — it opens with `\x01`, whatever
  the verb.

  Where `action?/1` asks "is this the one verb that IS conversation",
  this asks the complement: "is this protocol rather than something
  somebody said". A CTCP reply (`\x01PING 1234\x01`, `\x01VERSION …\x01`)
  arrives as a NOTICE from a peer's nick and would otherwise be routed
  like any peer NOTICE. When that meant "persist under the peer and mint
  a query window", pinging somebody left a tab open with them holding a
  row of control characters. #546 removed the minting, but not the
  reason for this predicate: a peer the operator has a query OPEN with
  would still get the raw `\x01…\x01` filed into that conversation.

  Lenient on the closing `\x01` for the same reason `action?/1` is: the
  trailing delimiter is optional and clients omit it.
  """
  @spec framed?(binary()) :: boolean()
  def framed?(<<0x01, _::binary>>), do: true
  def framed?(_), do: false

  @doc """
  Classifies any CTCP frame into its `{verb, args}` (#591).

  A CTCP body is `\\x01<VERB>[ <args>]\\x01` (trailing `\\x01` optional, per
  the same leniency as `action?/1`). Returns `{verb, args}` — `args` is `""`
  when the verb carries none, and preserves interior spaces verbatim (the
  argument is an opaque echo, e.g. a PING token, never re-tokenized). Returns
  `:none` for a non-CTCP body, an empty body, a bare `\\x01`, or a frame whose
  opening delimiter is not immediately followed by a verb.

  This is the SINGLE CTCP verb parser shared by BOTH directions so they cannot
  drift (the #14 lesson): the inbound EventRouter NOTICE arm tags a peer's CTCP
  PING reply, and the outbound `Session.Server` self-echo persist tags the
  operator's own `/ctcp`/`/ping` — both into a typed `meta.ctcp` cic consumes
  WITHOUT ever touching `\\x01`. `ACTION` is classified here too, but callers
  keep routing it through its dedicated `:action` kind (`action?/1`); every
  OTHER verb rides `meta.ctcp`.
  """
  @spec verb_args(binary()) :: {String.t(), String.t()} | :none
  def verb_args(<<0x01, rest::binary>>) do
    case String.split(strip_trailing_delim(rest), " ", parts: 2) do
      [verb | _] when verb == "" -> :none
      [verb] -> {verb, ""}
      [verb, args] -> {verb, args}
    end
  end

  def verb_args(_), do: :none

  # Drops a single trailing `\x01` (CTCP's optional closing delimiter) so the
  # last argument doesn't carry the delimiter byte. Byte-level per "IRC is
  # bytes"; safe on an empty binary.
  @spec strip_trailing_delim(binary()) :: binary()
  defp strip_trailing_delim(""), do: ""

  defp strip_trailing_delim(bin) do
    last_at = byte_size(bin) - 1

    case binary_part(bin, last_at, 1) do
      <<0x01>> -> binary_part(bin, 0, last_at)
      _ -> bin
    end
  end
end
