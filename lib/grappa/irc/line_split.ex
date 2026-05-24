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

  ## Why server-side

  Per CLAUDE.md "IRC is bytes; the web is UTF-8" + "one parser,
  on the server" — payload framing belongs to grappa, not cic.
  cic POSTs an arbitrary-length string; grappa fans out the
  fragments. Each fragment becomes its own scrollback row + its
  own upstream PRIVMSG, matching what every other IRC client
  renders + what the operator's own past view will reconstruct.

  ## CTCP awareness

  A body beginning with `\\x01ACTION ` and ending with `\\x01` is
  a CTCP ACTION. Fragmenting NAIVELY would emit
  `\\x01ACTION text-chunk-1` (no trailing `\\x01`) and
  `text-chunk-2\\x01` (no leading envelope) — both garbage on the
  wire. This module preserves the envelope on every fragment so
  each one is a self-contained valid CTCP message. Budget
  accounts for the per-fragment overhead.

  Other CTCP verbs (`\\x01VERSION\\x01`, DCC, etc.) are single-
  line by convention; this module's CTCP detection only triggers
  for ACTION.
  """

  @doc """
  Splits `body` into fragments that fit within `linelen` bytes
  per wire frame, given the target prefix.

  Returns a non-empty list of UTF-8 strings, each one a valid
  PRIVMSG body for `target`. Single-fragment input returns
  `[body]` unchanged (fast path).
  """
  @spec split_privmsg_body(String.t(), String.t(), pos_integer()) :: [String.t(), ...]
  def split_privmsg_body(body, target, linelen)
      when is_binary(body) and is_binary(target) and is_integer(linelen) and linelen > 0 do
    overhead = byte_size("PRIVMSG #{target} :") + byte_size("\r\n")
    budget = linelen - overhead

    cond do
      budget <= 0 -> [body]
      byte_size(body) <= budget -> [body]
      ctcp_action?(body) -> split_ctcp_action(body, budget)
      true -> split_plain(body, budget)
    end
  end

  defp ctcp_action?(<<"\x01ACTION ", _::binary>> = body),
    do: String.ends_with?(body, "\x01")

  defp ctcp_action?(_), do: false

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
