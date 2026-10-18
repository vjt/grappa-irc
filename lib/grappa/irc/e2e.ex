defmodule Grappa.IRC.E2e do
  @moduledoc """
  The IRC framing of end-to-end encrypted queries (issue 2430).

  An encrypted query travels as CTCP inside PRIVMSG to the peer's nick:

      \\x01E2E <verb> <msgid> <i>/<n> <chunk>\\x01

  This module owns that OUTER line and nothing inside it. The payload a
  line carries a slice of is the business of the two endpoints (cicchetto
  and the peer's client, both running vodozemac); grappa never decodes it,
  never re-encodes it, and has no key to read it with. The agreed wire is
  the 2430 issue body plus the payload proposal w2 posted there and w1
  acked (issuecomment-6252857813 / -6252874041); every rule below is
  quoted from those, not invented here.

  ## Why grappa parses the frame at all

  The draft says grappa passes E2E lines "byte for byte". CLAUDE.md says
  there is ONE IRC parser and it is on the server: cicchetto consumes
  typed events and never touches `\\x01`. Both hold at once by putting the
  cut in the right place — grappa parses the frame and reassembles the
  fragments (`Grappa.Session.E2eReassembly`), and what it hands the client
  is the verb, the msgid and the payload STRING, untouched. The ciphertext
  is never re-encoded: the only operations on it are slicing a base64
  string on the way out and concatenating the slices on the way in.

  ## The rules this module enforces

    * `verb` is a closed set (`t:verb/0`); an unknown verb is malformed.
    * `msgid` is an opaque token, at most 24 base64 bytes; the agreed
      shape is 8 random bytes unpadded (11 chars), which `new_msgid/0`
      mints. Inbound is accepted a little wider, never with a space.
    * `i/n` is decimal and 1-based, `1 <= i <= n <= 64`.
    * `chunk` is a NON-EMPTY run of standard base64 characters (padding
      included — the chunk is a slice of the padded base64 of the whole
      payload, so `=` can only appear in the last one, which this module
      does not police: the endpoint decodes, not the relay).
    * CTCP's closing `\\x01` is optional on the way in (the same leniency as
      `Grappa.IRC.CTCP`) and always written on the way out.

  ## Fragmenting

  `fragment/4` cuts a payload into lines that each fit a body budget the
  CALLER computes — `Session.Server` passes `LineSplit.frame_budget/2`,
  the worst-case relayed-prefix budget, which is never larger than the
  "own mask + 14" formula the draft gives, so a line sized by it cannot be
  truncated by the ircd on relay.
  """

  alias Grappa.IRC.CTCP
  alias Grappa.IRC.E2e.Fragment

  @typedoc """
  The E2E verbs, closed. Draft 7 also listed `OFFLINE`; vjt dropped it
  (2430, 2026-10-18 19:3x: no sender-side notice of any kind), so a line
  carrying it is malformed here.
  """
  @type verb :: :keyreq | :keys | :pkmsg | :msg | :nack

  @verbs %{
    "KEYREQ" => :keyreq,
    "KEYS" => :keys,
    "PKMSG" => :pkmsg,
    "MSG" => :msg,
    "NACK" => :nack
  }

  @wire_verbs Map.new(@verbs, fn {wire, verb} -> {verb, wire} end)

  @max_fragments 64
  @max_msgid_bytes 24
  @max_payload_bytes 32 * 1024

  @doc "Every verb. For validators that need the closed set."
  @spec verbs() :: [verb(), ...]
  def verbs, do: Map.values(@verbs)

  @doc "The most fragments one logical message may span."
  @spec max_fragments() :: 64
  def max_fragments, do: @max_fragments

  @doc """
  The most payload bytes a receiver buffers from one sender: 32 KiB, the
  figure both implementations took (2430). A larger payload can never be
  reassembled, so a sender refuses it outright.
  """
  @spec max_payload_bytes() :: 32_768
  def max_payload_bytes, do: @max_payload_bytes

  @doc """
  True iff `body` is a CTCP frame whose verb is `E2E`, whatever follows.

  This is the classifier for the never-persist rule, and it is deliberately
  wider than `parse/1`: a MALFORMED E2E line (a bare `\\x01E2E\\x01`, a
  dropped verb, a broken fraction) is still an E2E line, and must no more
  land in scrollback than a well-formed one. The verb comes from
  `CTCP.verb_args/1`, the one CTCP frame parser.
  """
  @spec framed?(binary()) :: boolean()
  def framed?(body) when is_binary(body), do: match?({"E2E", _}, CTCP.verb_args(body))

  @doc """
  Parses one E2E line body (the PRIVMSG trailing parameter).

  `{:error, :malformed}` for anything that is not exactly the five-field
  frame described in the moduledoc — including a body `framed?/1` accepts.
  """
  @spec parse(binary()) :: {:ok, Fragment.t()} | {:error, :malformed}
  def parse(body) when is_binary(body) do
    # `CTCP.verb_args/1` is the one CTCP frame parser (#591): it peels the
    # opening `\x01`, the optional closing one, and the verb. What is left
    # here is only E2E's own four fields.
    with {"E2E", args} <- CTCP.verb_args(body),
         [verb, msgid, fraction, chunk] <- :binary.split(args, " ", [:global]) do
      parse_fields(verb, msgid, fraction, chunk)
    else
      _ -> {:error, :malformed}
    end
  end

  @spec parse_fields(binary(), binary(), binary(), binary()) ::
          {:ok, Fragment.t()} | {:error, :malformed}
  defp parse_fields(verb, msgid, fraction, chunk) do
    with {:ok, verb} <- Map.fetch(@verbs, verb),
         true <- msgid?(msgid),
         {:ok, index, total} <- parse_fraction(fraction),
         true <- chunk?(chunk) do
      {:ok, %Fragment{verb: verb, msgid: msgid, index: index, total: total, chunk: chunk}}
    else
      _ -> {:error, :malformed}
    end
  end

  @spec parse_fraction(binary()) :: {:ok, pos_integer(), pos_integer()} | :error
  defp parse_fraction(fraction) do
    with [i, n] <- :binary.split(fraction, "/"),
         {index, ""} <- decimal(i),
         {total, ""} <- decimal(n),
         true <- index >= 1 and index <= total and total <= @max_fragments do
      {:ok, index, total}
    else
      _ -> :error
    end
  end

  # Digits only — `Integer.parse/1` would also take a sign.
  @spec decimal(binary()) :: {non_neg_integer(), binary()} | :error
  defp decimal(<<d, _::binary>> = s) when d in ?0..?9, do: Integer.parse(s)
  defp decimal(_), do: :error

  @doc """
  True iff `token` is an acceptable msgid: 1..#{@max_msgid_bytes} bytes of
  the standard base64 alphabet (with `=`). For the outbound validator as
  well as the parser, so the two cannot disagree on what a msgid is.
  """
  @spec msgid?(binary()) :: boolean()
  def msgid?(token) when is_binary(token) do
    byte_size(token) in 1..@max_msgid_bytes and base64_chars?(token)
  end

  @doc """
  True iff `payload` is a non-empty run of standard base64 characters —
  what a chunk, and the whole payload a client hands grappa to send, must
  be. Not a decode: grappa never decodes a payload.
  """
  @spec chunk?(binary()) :: boolean()
  def chunk?(payload) when is_binary(payload), do: payload != "" and base64_chars?(payload)

  @spec base64_chars?(binary()) :: boolean()
  defp base64_chars?(<<>>), do: true

  defp base64_chars?(<<c, rest::binary>>)
       when c in ?A..?Z or c in ?a..?z or c in ?0..?9 or c in [?+, ?/, ?=],
       do: base64_chars?(rest)

  defp base64_chars?(_), do: false

  @doc """
  A fresh msgid: 8 random bytes, standard base64, unpadded (11 chars) —
  the shape agreed on 2430.
  """
  @spec new_msgid() :: String.t()
  def new_msgid, do: Base.encode64(:crypto.strong_rand_bytes(8), padding: false)

  @doc """
  Cuts `payload` into E2E line bodies, each at most `budget` bytes.

  `budget` is the PRIVMSG body budget for the target (see the moduledoc).
  `{:error, :too_large}` when the payload needs more than
  `max_fragments/0` lines, or when the budget cannot hold even the frame
  around a one-byte chunk. `payload` must already satisfy `chunk?/1`; the
  caller validated it at its boundary.
  """
  @spec fragment(verb(), String.t(), String.t(), integer()) ::
          {:ok, [binary(), ...]} | {:error, :too_large}
  def fragment(verb, msgid, payload, budget)
      when is_map_key(@wire_verbs, verb) and is_binary(msgid) and is_binary(payload) and
             payload != "" and is_integer(budget) do
    wire_verb = Map.fetch!(@wire_verbs, verb)
    size = byte_size(payload)

    case chunk_size(wire_verb, msgid, size, budget) do
      {:ok, chunk_size} ->
        chunks = slice(payload, chunk_size)
        total = length(chunks)

        lines =
          chunks
          |> Enum.with_index(1)
          |> Enum.map(fn {chunk, index} -> line(wire_verb, msgid, index, total, chunk) end)

        {:ok, lines}

      :error ->
        {:error, :too_large}
    end
  end

  # The largest chunk such that every line fits `budget`. The head grows
  # with the digit count of `i/n`, so the size is found by trying each
  # possible total: with `n` lines the widest head is the one for `n/n`,
  # and if `n` chunks of the room that head leaves cover the payload, the
  # payload fits. The real total can then only be <= n, whose head is no
  # wider — so every line still fits.
  @spec chunk_size(String.t(), String.t(), pos_integer(), integer()) :: {:ok, pos_integer()} | :error
  defp chunk_size(wire_verb, msgid, size, budget) do
    Enum.find_value(1..@max_fragments, :error, fn n ->
      room = budget - byte_size(line(wire_verb, msgid, n, n, ""))

      if room > 0 and room * n >= size, do: {:ok, room}
    end)
  end

  @spec slice(binary(), pos_integer()) :: [binary(), ...]
  defp slice(payload, chunk_size) when byte_size(payload) <= chunk_size, do: [payload]

  defp slice(payload, chunk_size) do
    <<chunk::binary-size(chunk_size), rest::binary>> = payload
    [chunk | slice(rest, chunk_size)]
  end

  @spec line(String.t(), String.t(), pos_integer(), pos_integer(), binary()) :: binary()
  defp line(wire_verb, msgid, index, total, chunk),
    do:
      <<0x01, "E2E ", wire_verb::binary, " ", msgid::binary, " ", Integer.to_string(index)::binary, "/",
        Integer.to_string(total)::binary, " ", chunk::binary, 0x01>>
end
