defmodule Grappa.IRC.E2e do
  @moduledoc """
  The IRC framing of end-to-end encrypted queries (issue 2430).

  An encrypted query travels as CTCP inside PRIVMSG to the peer's nick
  (wire v2, multi-device: 2430 comments 6346236542, 6346384093 and
  6346686730):

      \\x01E2E <verb> <msgid> <i>/<n> <from> <to> <chunk>\\x01

  This module owns that OUTER line and nothing inside it. The payload a
  line carries a slice of is the business of the two endpoints (cicchetto
  and the peer's client, both running vodozemac); grappa never decodes it,
  never re-encodes it, and has no key to read it with. The agreed wire is
  the 2430 issue body, the v1 payload proposal (issuecomment-6252857813 /
  -6252874041) and the v2 comments above; every rule below is quoted from
  those, not invented here.

  ## Why grappa parses the frame at all

  The draft says grappa passes E2E lines "byte for byte". CLAUDE.md says
  there is ONE IRC parser and it is on the server: cicchetto consumes
  typed events and never touches `\\x01`. Both hold at once by putting the
  cut in the right place — grappa parses the frame and reassembles the
  fragments (`Grappa.Session.E2eReassembly`), and what it hands the client
  is the verb, the msgid, the two addresses and the payload STRING,
  untouched. The payload is never re-encoded: the only operations on it
  are slicing its text on the way out and concatenating the slices on the
  way in.

  ## The rules this module enforces

    * `verb` is a closed set (`t:verb/0`); an unknown verb is malformed.
    * `msgid` is an opaque token, at most 24 base64 bytes; the agreed
      shape is 8 random bytes unpadded (11 chars), which `new_msgid/0`
      mints. Inbound is accepted a little wider, never with a space.
    * `i/n` is decimal and 1-based, `1 <= i <= n <= 64`.
    * `from` and `to` are each a device id (`did?/1`: exactly 11 characters
      of the base64url alphabet) or `*`, in the closed combinations
      `addressed?/3` allows: KEYREQ `did → *`, KEYS `* → did`, PKMSG and
      MSG `did → did` or `did → *` (one message carrying a body for each of
      several devices), NACK `did → did`.
    * `chunk` is a NON-EMPTY slice of the payload's compact JSON text, so
      printable ASCII without a space (`chunk?/1`). It is no longer base64:
      v2 dropped the outer encoding, which cost a third of every line. The
      relay checks the characters and never parses the JSON.
    * CTCP's closing `\\x01` is optional on the way in (the same leniency as
      `Grappa.IRC.CTCP`) and always written on the way out.

  ## Fragmenting

  `fragment/5` cuts a payload into lines that each fit a body budget the
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

  @typedoc "A frame address: a device id (`did?/1`), or `*`."
  @type address :: String.t()

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

  `{:error, :malformed}` for anything that is not exactly the seven-field
  frame described in the moduledoc — including a body `framed?/1` accepts,
  and a v1 line, which carries neither `from` nor `to` (flag-day: no
  release carries E2E).
  """
  @spec parse(binary()) :: {:ok, Fragment.t()} | {:error, :malformed}
  def parse(body) when is_binary(body) do
    # `CTCP.verb_args/1` is the one CTCP frame parser (#591): it peels the
    # opening `\x01`, the optional closing one, and the verb. What is left
    # here is only E2E's own six fields.
    with {"E2E", args} <- CTCP.verb_args(body),
         [verb, msgid, fraction, from, to, chunk] <- :binary.split(args, " ", [:global]) do
      parse_fields(verb, msgid, fraction, {from, to}, chunk)
    else
      _ -> {:error, :malformed}
    end
  end

  @spec parse_fields(binary(), binary(), binary(), {binary(), binary()}, binary()) ::
          {:ok, Fragment.t()} | {:error, :malformed}
  defp parse_fields(verb, msgid, fraction, {from, to}, chunk) do
    with {:ok, verb} <- Map.fetch(@verbs, verb),
         true <- msgid?(msgid),
         {:ok, index, total} <- parse_fraction(fraction),
         true <- addressed?(verb, from, to),
         true <- chunk?(chunk) do
      {:ok, %Fragment{verb: verb, msgid: msgid, index: index, total: total, from: from, to: to, chunk: chunk}}
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
  True iff `token` is a device id: the unpadded, canonical base64url of 8
  bytes, 11 characters (`Grappa.E2eKeys.Device` derives it). A `+` or a
  `/` makes it malformed: the standard alphabet is not a did. The shape
  only: a did is a routing label, and no trust rests on it.
  """
  @spec did?(term()) :: boolean()
  def did?(token) when is_binary(token) and byte_size(token) == 11 do
    case Base.url_decode64(token, padding: false) do
      {:ok, raw} -> Base.url_encode64(raw, padding: false) == token
      :error -> false
    end
  end

  def did?(_), do: false

  @doc """
  True iff `from → to` is an addressing `verb` may carry (wire v2): KEYREQ
  from a device to the user (`*`), KEYS from the user to the device that
  asked, PKMSG and MSG from a device to a device or to several (`*`), NACK
  from a device to a device. The one table, for the parser and the send
  door alike.
  """
  @spec addressed?(verb(), term(), term()) :: boolean()
  def addressed?(:keyreq, from, "*"), do: did?(from)
  def addressed?(:keys, "*", to), do: did?(to)
  def addressed?(verb, from, "*") when verb in [:pkmsg, :msg], do: did?(from)
  def addressed?(verb, from, to) when verb in [:pkmsg, :msg, :nack], do: did?(from) and did?(to)
  def addressed?(_, _, _), do: false

  @doc """
  True iff `payload` is a non-empty run of printable ASCII without a space
  (`0x21..0x7E`) — the characters of compact JSON whose strings hold only
  base64, numbers and punctuation. What a chunk, and the whole payload a
  client hands grappa to send, must be. Not a parse: grappa never parses a
  payload.
  """
  @spec chunk?(binary()) :: boolean()
  def chunk?(payload) when is_binary(payload), do: payload != "" and json_chars?(payload)

  @spec json_chars?(binary()) :: boolean()
  defp json_chars?(<<>>), do: true
  defp json_chars?(<<c, rest::binary>>) when c in 0x21..0x7E, do: json_chars?(rest)
  defp json_chars?(_), do: false

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
  Cuts `payload` into E2E line bodies from `from` to `to`, each at most
  `budget` bytes.

  `budget` is the PRIVMSG body budget for the target (see the moduledoc).
  `{:error, :too_large}` when the payload needs more than
  `max_fragments/0` lines, or when the budget cannot hold even the frame
  around a one-byte chunk. `payload` must already satisfy `chunk?/1` and
  the addresses `addressed?/3`; the caller validated both at its boundary.
  """
  @spec fragment(verb(), String.t(), {address(), address()}, String.t(), integer()) ::
          {:ok, [binary(), ...]} | {:error, :too_large}
  def fragment(verb, msgid, {from, to}, payload, budget)
      when is_map_key(@wire_verbs, verb) and is_binary(msgid) and is_binary(from) and is_binary(to) and
             is_binary(payload) and payload != "" and is_integer(budget) do
    head = {Map.fetch!(@wire_verbs, verb), msgid, from, to}
    size = byte_size(payload)

    case chunk_size(head, size, budget) do
      {:ok, chunk_size} ->
        chunks = slice(payload, chunk_size)
        total = length(chunks)

        lines =
          chunks
          |> Enum.with_index(1)
          |> Enum.map(fn {chunk, index} -> line(head, index, total, chunk) end)

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
  @spec chunk_size(head(), pos_integer(), integer()) :: {:ok, pos_integer()} | :error
  defp chunk_size(head, size, budget) do
    Enum.find_value(1..@max_fragments, :error, fn n ->
      room = budget - byte_size(line(head, n, n, ""))

      if room > 0 and room * n >= size, do: {:ok, room}
    end)
  end

  @spec slice(binary(), pos_integer()) :: [binary(), ...]
  defp slice(payload, chunk_size) when byte_size(payload) <= chunk_size, do: [payload]

  defp slice(payload, chunk_size) do
    <<chunk::binary-size(chunk_size), rest::binary>> = payload
    [chunk | slice(rest, chunk_size)]
  end

  # The wire verb, the msgid and the two addresses: what every line of one
  # message repeats.
  @typep head :: {String.t(), String.t(), address(), address()}

  @spec line(head(), pos_integer(), pos_integer(), binary()) :: binary()
  defp line({wire_verb, msgid, from, to}, index, total, chunk),
    do:
      <<0x01, "E2E ", wire_verb::binary, " ", msgid::binary, " ", Integer.to_string(index)::binary, "/",
        Integer.to_string(total)::binary, " ", from::binary, " ", to::binary, " ", chunk::binary, 0x01>>
end
