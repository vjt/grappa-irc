defmodule Grappa.IRC.LineSplit do
  @moduledoc """
  Splits a PRIVMSG body into wire-frame-fitting fragments.

  The IRC server's max line length (`LINELEN`, advertised via
  `005 RPL_ISUPPORT LINELEN=<N>` or RFC 2812's 512-byte default)
  bounds the WHOLE wire frame including the `PRIVMSG <target> :`
  prefix and trailing `\\r\\n`. This module computes the per-frame
  body budget, splits the body on grapheme boundaries (UTF-8
  safe), and returns one body per fragment. Caller wraps each in
  the envelope.

  ## Why the budget reserves the RELAYED source prefix (#246)

  A client's OWN outbound line omits the source prefix — grappa
  sends `PRIVMSG <target> :<body>\\r\\n`. But the server, when it
  fans that line out to the OTHER channel members, prepends the
  originator's identity:

      :nick!user@host PRIVMSG <target> :<body>\\r\\n

  That relayed line — not grappa's client-side line — is what the
  server holds against `LINELEN`. If the body budget reserves only
  the client-side `PRIVMSG <target> :\\r\\n` framing, a fragment can
  be ≤ `LINELEN` on grappa's wire yet exceed it once relayed → the
  server truncates the tail → the next fragment resumes past the
  cut → a SILENT byte hole of ~(source-prefix length) at every
  boundary. Invisible on grappa's own echo; only recipients see it.

  So the budget reserves the WORST-CASE source prefix, not the live
  one: `host`/cloak length can grow between messages (a rebind, an
  oper cloak, an IPv6 vs reverse-DNS host), so budgeting against the
  current prefix would under-reserve the moment it grows. The
  worst-case ceilings are grappa's own documented identity maxima
  plus the common ircd `HOSTLEN`:

    * nick  ≤ 30 — `Grappa.IRC.Identifier` `@nick_regex` ceiling
      (Azzurra/bahamut `NICKLEN=30`); grappa's own nick can never
      register longer.
    * ident ≤ 10 — `Grappa.IRC.Identifier` `@ident_regex` ceiling
      (common ircd `USERLEN`); the server's `~` no-identd prefix is
      counted within `USERLEN`, so 10 bounds the on-wire ident.
    * host  ≤ 63 — the `HOSTLEN` of the ircds grappa targets (bahamut
      on Azzurra, solanum on Libera). Covers hostnames, hex/vhost
      cloaks, and bracketed IPv6 literals (max `[` + 45 + `]` = 47).
      Not advertised in 005, so a fixed worst case is the posture.
      This is a DEPLOYED-ircd ceiling, NOT a universal one: a network
      with `HOSTLEN` > 63 (e.g. InspIRCd's default `maxhost=64`)
      under-reserves the prefix and RE-OPENS this exact silent
      truncation data loss (smaller — ~`HOSTLEN − 63` bytes per
      boundary). Over-reserve is safe, under-reserve is the bug: so
      `@max_host_bytes` MUST be raised before pointing grappa at any
      ircd with a larger `HOSTLEN`. RFC 2812 does not bound the host;
      the RFC/DNS ceiling would be 253, chosen against here only to
      avoid tripling fragmentation on the networks grappa runs on.

  Over-reserving costs a few extra fragments on long messages only
  (short messages stay on the `[body]` fast path); under-reserving
  loses data. For a silent-data-loss bug, worst-case is the only
  safe budget. See `relay_frame_overhead/1`.

  ## Why server-side

  Per CLAUDE.md "IRC is bytes; the web is UTF-8" + "one parser,
  on the server" — payload framing belongs to grappa, not cic.
  cic POSTs an arbitrary-length string; grappa fans out the
  fragments. Each fragment becomes its own scrollback row + its
  own upstream PRIVMSG, matching what every other IRC client
  renders + what the operator's own past view will reconstruct.

  ## CTCP awareness

  A body beginning with `\\x01ACTION ` is a CTCP ACTION (classified
  via the shared `Grappa.IRC.CTCP.action?/1`). Fragmenting NAIVELY
  would emit `\\x01ACTION text-chunk-1` (no trailing `\\x01`) and
  `text-chunk-2\\x01` (no leading envelope) — both garbage on the
  wire. This module preserves the envelope on every fragment so
  each one is a self-contained valid CTCP message (the optional
  trailing `\\x01` is stripped once and re-added per fragment).
  Budget accounts for the per-fragment overhead.

  Other CTCP verbs (`\\x01VERSION\\x01`, DCC, etc.) are single-
  line by convention; this module's CTCP detection only triggers
  for ACTION.
  """

  # Worst-case source prefix `:nick!user@host ` the RELAYING server
  # prepends before fanning our line out to other members (#246). See the
  # moduledoc for the per-field ceiling rationale. Sigils: `:` `!` `@` and
  # the trailing space = 4 fixed bytes.
  @max_nick_bytes 30
  @max_ident_bytes 10
  @max_host_bytes 63
  @source_prefix_reserve 1 + @max_nick_bytes + 1 + @max_ident_bytes + 1 + @max_host_bytes + 1

  @doc """
  Worst-case bytes the RELAYED wire frame adds around a fragment body for
  `target`: the source prefix the server prepends, plus the
  `PRIVMSG <target> :` command/target framing, plus the trailing `\\r\\n`.

  This is the amount `split_privmsg_body/3` subtracts from `linelen` to get
  the body budget, so a fragment sized to `linelen - relay_frame_overhead(target)`
  is guaranteed to fit `linelen` once the server relays it with the
  worst-case `:nick!user@host ` prefix. See the moduledoc.
  """
  @spec relay_frame_overhead(String.t()) :: pos_integer()
  def relay_frame_overhead(target) when is_binary(target) do
    @source_prefix_reserve + byte_size("PRIVMSG #{target} :") + byte_size("\r\n")
  end

  @doc """
  Splits `body` into fragments that fit within `linelen` bytes
  per wire frame, given the target prefix.

  Each fragment is sized so that, once the server RELAYS it as
  `:nick!user@host PRIVMSG <target> :<fragment>\\r\\n` with the worst-case
  source prefix, the whole line is ≤ `linelen` (#246) — not merely
  grappa's prefix-less client-side line.

  Returns a non-empty list of UTF-8 strings, each one a valid
  PRIVMSG body for `target`. Single-fragment input returns
  `[body]` unchanged (fast path).
  """
  @spec split_privmsg_body(String.t(), String.t(), pos_integer()) :: [String.t(), ...]
  def split_privmsg_body(body, target, linelen)
      when is_binary(body) and is_binary(target) and is_integer(linelen) and linelen > 0 do
    budget = linelen - relay_frame_overhead(target)

    cond do
      budget <= 0 -> [body]
      byte_size(body) <= budget -> [body]
      Grappa.IRC.CTCP.action?(body) -> split_ctcp_action(body, budget)
      true -> split_plain(body, budget)
    end
  end

  defp split_plain(body, budget) do
    body
    |> String.graphemes()
    |> chunk_by_bytes(budget, [], [], 0)
  end

  defp split_ctcp_action(body, budget) do
    inner =
      body
      |> String.replace_prefix("\x01ACTION ", "")
      |> String.replace_suffix("\x01", "")

    envelope_overhead = byte_size("\x01ACTION ") + byte_size("\x01")
    inner_budget = budget - envelope_overhead

    if inner_budget <= 0 do
      [body]
    else
      inner
      |> String.graphemes()
      |> chunk_by_bytes(inner_budget, [], [], 0)
      |> Enum.map(fn chunk -> "\x01ACTION " <> chunk <> "\x01" end)
    end
  end

  defp chunk_by_bytes([], _, current_chunk, acc, _) do
    case flush_chunk(current_chunk, acc) do
      [] -> [""]
      list -> Enum.reverse(list)
    end
  end

  defp chunk_by_bytes([g | rest], budget, current_chunk, acc, current_size) do
    g_size = byte_size(g)

    cond do
      g_size > budget ->
        acc = flush_chunk(current_chunk, acc)
        chunk_by_bytes(rest, budget, [], [g | acc], 0)

      current_size + g_size > budget ->
        chunk_str = IO.iodata_to_binary(Enum.reverse(current_chunk))
        chunk_by_bytes(rest, budget, [g], [chunk_str | acc], g_size)

      true ->
        chunk_by_bytes(rest, budget, [g | current_chunk], acc, current_size + g_size)
    end
  end

  defp flush_chunk([], acc), do: acc

  defp flush_chunk(chunk, acc),
    do: [IO.iodata_to_binary(Enum.reverse(chunk)) | acc]
end
