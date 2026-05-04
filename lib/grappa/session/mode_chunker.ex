defmodule Grappa.Session.ModeChunker do
  @moduledoc """
  Pure, stateless splitter for IRC MODE commands with multiple parameter targets.

  IRC servers advertise a `MODES=N` token in ISUPPORT (005 RPL_ISUPPORT) that
  caps how many mode changes a single `MODE` line may carry. When cicchetto
  sends `/op alice bob carol dave eve` the Session.Server must issue *two*
  `MODE` lines instead of one to stay within the server's limit.

  `ModeChunker` owns that splitting logic. It is a pure module — no GenServer
  state, no side effects, no Repo calls. Session.Server calls `chunk/3` with
  the ISUPPORT-derived `max_per_chunk` (defaulting to 3 when the server omits
  `MODES=`) and iterates the returned list to send each chunk upstream.

  ## Design

  `chunk/3` groups params into slices of at most `max_per_chunk` entries.
  For each slice it builds a mode string that repeats the single mode letter
  once per param (e.g. `+ooo` for three ops). The sign character is preserved
  verbatim in every chunk. The mode letter is repeated `length(params_slice)`
  times so the IRC framing is unambiguous — one letter per argument.

  Empty params (banlist query `MODE #chan b`, umode `MODE <nick> +i`) produce
  a single chunk with the original mode string and an empty param list.

  The `/mode` raw verb is exempt from chunking by design — it is the
  pass-through escape hatch for power users. Chunking only applies to the
  high-level `/op /deop /voice /devoice /ban /unban` verbs.

  ## Default max_per_chunk

  IRCv3 spec says 3 when `MODES=` is absent. Session.Server stores the
  advertised value (or the default) in `state.modes_per_chunk` and passes it
  to every `chunk/3` call.

  ## Round-trip contract

  `Enum.flat_map(ModeChunker.chunk(m, ps, n), fn {_, ps} -> ps end)`
  equals the original `ps` list — params are never reordered or dropped.
  """

  @doc """
  Splits `(mode_str, params, max_per_chunk)` into a list of `{mode, params}`
  chunks, each carrying at most `max_per_chunk` param entries.

  ## Arguments

    * `mode_str` — a single-change mode string, e.g. `"+o"`, `"-v"`, `"+b"`.
      Must carry exactly one sign (`+` or `-`) and exactly one letter.
    * `params` — list of target strings (nicks, masks, etc.). May be empty
      for query-form and no-param modes.
    * `max_per_chunk` — positive integer; the ISUPPORT `MODES=N` value (or
      default 3). Each returned chunk has at most this many params.

  ## Returns

  A list of `{mode_string, params_slice}` tuples. The mode letter is repeated
  once per param in each chunk (e.g. `"+ooo"` for 3 nicks, `"+o"` for 1).
  When `params` is empty a single `{mode_str, []}` tuple is returned.

  ## Examples

      iex> ModeChunker.chunk("+o", ["alice", "bob", "carol", "dave"], 3)
      [{"+ooo", ["alice", "bob", "carol"]}, {"+o", ["dave"]}]

      iex> ModeChunker.chunk("+b", [], 3)
      [{"+b", []}]

  """
  @spec chunk(String.t(), [String.t()], pos_integer()) :: [{String.t(), [String.t()]}]
  def chunk(mode_str, [], _) when is_binary(mode_str),
    do: [{mode_str, []}]

  def chunk(mode_str, params, max_per_chunk)
      when is_binary(mode_str) and is_list(params) and is_integer(max_per_chunk) and
             max_per_chunk >= 1 do
    {sign, letter} = split_mode(mode_str)
    do_chunk(params, sign, letter, max_per_chunk, [])
  end

  # ---------------------------------------------------------------------------
  # Private helpers
  # ---------------------------------------------------------------------------

  # Splits "+o" into {"+", "o"}, "-v" into {"-", "v"}, etc.
  # Assumes mode_str is well-formed (single sign + single letter).
  @spec split_mode(String.t()) :: {String.t(), String.t()}
  defp split_mode(<<sign::binary-size(1), letter::binary>>), do: {sign, letter}

  # Recursive accumulator: builds one chunk per slice, front-loaded.
  @spec do_chunk([String.t()], String.t(), String.t(), pos_integer(), [{String.t(), [String.t()]}]) ::
          [{String.t(), [String.t()]}]
  defp do_chunk([], _, _, _, acc), do: Enum.reverse(acc)

  defp do_chunk(params, sign, letter, max, acc) do
    {slice, rest} = Enum.split(params, max)
    mode_str = sign <> String.duplicate(letter, length(slice))
    do_chunk(rest, sign, letter, max, [{mode_str, slice} | acc])
  end
end
