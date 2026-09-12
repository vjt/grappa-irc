defmodule Grappa.IRC.DCC do
  @moduledoc """
  The wire half of a `DCC SEND` offer — parsing only (issue 2089).

  A `DCC SEND` arrives inside an ordinary CTCP frame:
  `\\x01DCC SEND <filename> <address> <port> <size>[ <token>]\\x01`. This
  module turns the argument remainder into a typed offer, and does nothing
  else: no socket, no consent, no storage, no policy. It is a pure function
  over bytes.

  ## It composes with what already exists, rather than repeating it

  `Grappa.IRC.CTCP.verb_args/1` stays the single CTCP framing parser — the
  caller hands `parse/1` the `args` half of `{"DCC", args}`, so this file
  never touches `\\x01`:

      case CTCP.verb_args(body) do
        {"DCC", args} -> DCC.parse(args)
        _ -> :not_dcc
      end

  `ip` decodes all the way to an `:inet.ip_address()` tuple, which is exactly
  what `Grappa.Net.Ssrf.safe_public_ip?/1` already takes. The eventual dial
  site therefore reuses this repo's hardened guard verbatim instead of
  deriving a second one — a peer-supplied address is the textbook SSRF input,
  and `169.254.169.254` reaches a cloud metadata service just as happily over
  a DCC socket as over HTTP.

  ## What it deliberately refuses, and why each refusal is a safety property

    * **The sizeless historical form** (`DCC SEND <file> <addr> <port>`).
      Without a declared size a receiver cannot check its byte cap BEFORE
      dialling, so the cap degrades from a precondition to a hope; and the
      right-to-left split that recovers an unquoted filename with spaces
      stops being decidable. Both reasons are structural, not cosmetic.

    * **Port 0 with no trailing token.** Port 0 is the passive/reverse
      signal: the OFFERER cannot listen and asks the receiver to. Without
      the token that offer can be neither dialled nor answered, so calling
      it well-formed would hand the caller an unusable struct.

    * **Non-strict address literals.** `:inet.parse_strict_address/1` only,
      matching `Grappa.Net.Ssrf`'s posture exactly: a short or octal form
      (`127.1`, `017700000001`) must never be quietly decoded into a
      loopback address behind the guard's back.

  ## What it deliberately does NOT do: sanitise the filename

  `filename` comes back verbatim, traversal shapes included. Nothing
  downstream may use a peer's filename as a path — `Grappa.Uploads`
  derives every on-disk name from a 26-char base32 slug and
  `Uploads.storage_path/2` RAISES on anything else. Sanitising here would
  invent a second, weaker guard beside the real one and would corrupt the
  display name into the bargain.

  ## Scope, honestly stated

  Only `SEND` is parsed. `CHAT`, `RESUME` and `ACCEPT` come back as
  `{:error, {:unsupported_verb, verb}}` — naming the verb rather than
  claiming the frame was malformed — because whether grappa answers a
  resume, or speaks DCC CHAT at all, is an OPEN product decision on issue
  2089 and does not belong in a parser. There is no call site for this
  module yet, deliberately: the consent, cap, address-family and
  malware-surface questions are unresolved, and every one of them changes
  the shape of the code that would call this.
  """

  import Bitwise, only: [band: 2, bsr: 2]

  @enforce_keys [:filename, :ip, :port, :size, :token]
  defstruct [:filename, :ip, :port, :size, :token]

  @typedoc """
  A parsed `DCC SEND` offer.

  `token` is `nil` for a classic active offer (the offerer listens on
  `port`, we dial it) and an integer for a passive/reverse offer (`port` is
  `0`, the offerer asks US to listen and to echo the token back).
  """
  @type t :: %__MODULE__{
          filename: String.t(),
          ip: :inet.ip_address(),
          port: 0..65_535,
          size: non_neg_integer(),
          token: non_neg_integer() | nil
        }

  @typedoc """
  `:malformed` — the frame is not a usable `SEND` offer.
  `{:unsupported_verb, verb}` — a DCC verb this module does not parse, named
  so the caller can log or refuse it truthfully.
  """
  @type error :: :malformed | {:unsupported_verb, String.t()}

  # The historical address field is an unsigned 32-bit integer in network
  # byte order, rendered in decimal.
  @max_int32 4_294_967_295
  @max_port 65_535

  @digits ~r/\A[0-9]+\z/

  @doc """
  Parse the CTCP argument remainder of a `DCC` frame into an offer.

  Takes the `args` half of `Grappa.IRC.CTCP.verb_args/1` — e.g.
  `"SEND report.pdf 3221225985 5000 12345"`. Returns `{:ok, t()}` for a
  well-formed `SEND`, `{:error, {:unsupported_verb, verb}}` for another DCC
  verb, and `{:error, :malformed}` for anything else. Never raises.
  """
  @spec parse(String.t()) :: {:ok, t()} | {:error, error()}
  def parse(args) when is_binary(args) do
    case args |> String.trim_leading(" ") |> String.split(" ", parts: 2) do
      [""] -> {:error, :malformed}
      [verb] -> dispatch(String.upcase(verb, :ascii), "")
      [verb, rest] -> dispatch(String.upcase(verb, :ascii), rest)
    end
  end

  @spec dispatch(String.t(), String.t()) :: {:ok, t()} | {:error, error()}
  defp dispatch("SEND", rest) do
    case split_name_and_tail(squeeze_edges(rest)) do
      {name, tail} -> build(name, tail)
      :error -> {:error, :malformed}
    end
  end

  defp dispatch(verb, _), do: {:error, {:unsupported_verb, verb}}

  # Byte-level edge trim. `String.trim/1` is Unicode-aware and IRC is bytes
  # (CLAUDE.md), so the two-arity binary form is used throughout: it strips a
  # literal space and cannot trip over a Latin-1 filename.
  @spec squeeze_edges(String.t()) :: String.t()
  defp squeeze_edges(s), do: s |> String.trim_leading(" ") |> String.trim_trailing(" ")

  # The filename is whatever precedes the fixed-arity trailing fields. A
  # quoted name says where it ends; an unquoted one is recovered
  # right-to-left, which is the only way to read the shape the CTCP has no
  # way to quote.
  @spec split_name_and_tail(String.t()) :: {String.t(), [String.t()]} | :error
  defp split_name_and_tail(<<?", rest::binary>>) do
    case String.split(rest, "\"", parts: 2) do
      [name, tail] -> {name, String.split(tail, " ", trim: true)}
      [_] -> :error
    end
  end

  defp split_name_and_tail(args) do
    toks = String.split(args, " ")
    count = length(toks)
    arity = if count > 4 and passive_tail?(Enum.drop(toks, count - 4)), do: 4, else: 3

    if count > arity do
      {toks |> Enum.take(count - arity) |> Enum.join(" "), Enum.drop(toks, count - arity)}
    else
      :error
    end
  end

  # A passive tail is `<addr> 0 <size> <token>`: a literal `0` in the PORT
  # slot AND a decodable address in front of it AND at least one token left
  # over for the filename. All three are load-bearing, and each one was a
  # real misread before it was there:
  #
  #   * without the `count > 4` guard, `SEND f 0 1 1` — an active offer from
  #     0.0.0.0 — reads its own filename as the address slot;
  #   * without the address check, `SEND my file 0 10 7` reads the word
  #     `file` as an address and answers `:malformed` on a valid offer.
  #
  # Residual ambiguity, accepted knowingly: a filename that is itself a bare
  # decimal, offered from 0.0.0.0, is undecidable on the wire. 0.0.0.0 is not
  # dialable and `Grappa.Net.Ssrf` refuses it anyway, so the reading that
  # loses costs nothing real.
  @spec passive_tail?([String.t()]) :: boolean()
  defp passive_tail?([addr, "0", _, _]), do: match?({:ok, _}, decode_addr(addr))
  defp passive_tail?(_), do: false

  @spec build(String.t(), [String.t()]) :: {:ok, t()} | {:error, :malformed}
  defp build(name, [addr, port, size]) do
    with true <- named?(name),
         {:ok, ip} <- decode_addr(addr),
         {:ok, p} <- decode_port(port),
         {:ok, s} <- decode_non_neg(size) do
      {:ok, %__MODULE__{filename: name, ip: ip, port: p, size: s, token: nil}}
    else
      _ -> {:error, :malformed}
    end
  end

  defp build(name, [addr, "0", size, token]) do
    with true <- named?(name),
         {:ok, ip} <- decode_addr(addr),
         {:ok, s} <- decode_non_neg(size),
         {:ok, t} <- decode_non_neg(token) do
      {:ok, %__MODULE__{filename: name, ip: ip, port: 0, size: s, token: t}}
    else
      _ -> {:error, :malformed}
    end
  end

  defp build(_, _), do: {:error, :malformed}

  # Blank iff it is nothing but spaces. Byte-level for the same reason
  # `squeeze_edges/1` is.
  @spec named?(String.t()) :: boolean()
  defp named?(name), do: String.trim_leading(name, " ") != ""

  @spec decode_addr(String.t()) :: {:ok, :inet.ip_address()} | :error
  defp decode_addr(raw) do
    if Regex.match?(@digits, raw), do: decode_int32(raw), else: decode_literal(raw)
  end

  @spec decode_int32(String.t()) :: {:ok, :inet.ip_address()} | :error
  defp decode_int32(raw) do
    case Integer.parse(raw) do
      {n, ""} when n >= 0 and n <= @max_int32 ->
        {:ok, {band(bsr(n, 24), 0xFF), band(bsr(n, 16), 0xFF), band(bsr(n, 8), 0xFF), band(n, 0xFF)}}

      _ ->
        :error
    end
  end

  @spec decode_literal(String.t()) :: {:ok, :inet.ip_address()} | :error
  defp decode_literal(raw) do
    case :inet.parse_strict_address(:binary.bin_to_list(raw)) do
      {:ok, ip} -> {:ok, ip}
      {:error, _} -> :error
    end
  end

  @spec decode_port(String.t()) :: {:ok, 1..65_535} | :error
  defp decode_port(raw) do
    case Integer.parse(raw) do
      {n, ""} when n >= 1 and n <= @max_port -> {:ok, n}
      _ -> :error
    end
  end

  @spec decode_non_neg(String.t()) :: {:ok, non_neg_integer()} | :error
  defp decode_non_neg(raw) do
    case Integer.parse(raw) do
      {n, ""} when n >= 0 -> {:ok, n}
      _ -> :error
    end
  end
end
