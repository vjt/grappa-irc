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
end
