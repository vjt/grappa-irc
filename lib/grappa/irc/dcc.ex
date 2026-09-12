defmodule Grappa.IRC.DCC do
  @moduledoc """
  Parser for the argument string of a CTCP `DCC` frame (issue 2089).

  `Grappa.IRC.CTCP.verb_args/1` splits a CTCP body into `{verb, args}`;
  when the verb is `DCC`, THIS module turns `args` into either a typed
  `Grappa.IRC.DCC.Offer` or a typed refusal. It is pure framing — no
  socket, no policy, no storage. Whether an offer is ALLOWED (SSRF class
  of the address, per-transfer cap, daily quota, user consent) is decided
  by the caller, deliberately: a parser that also judged would make the
  refusal reasons impossible to report separately, and issue 2089's rule
  is that every refusal is reported to the user.

  ## Only SEND, and every other subcommand is refused BY NAME

  `RESUME`/`ACCEPT` are not implemented — an honest refusal, revisited if
  it hurts. `CHAT` and the rest are equally out. The refusal carries the
  offending subcommand precisely so the synthesised status message can
  say which verb was declined instead of going quiet, which is the one
  outcome issue 2089 forbids.

  ## Passive (reverse) DCC is refused, and that is load-bearing

  In passive DCC the sender advertises port `0` plus a token and expects
  the RECEIVER to listen. Receive-only exists exactly because we never
  open a listener, so accepting a passive offer would reintroduce the
  inbound-P2P posture `DESIGN_NOTES` entry 1280 rejected. Both the
  port-`0` form and the extra-token form are refused as
  `:passive_unsupported` — a distinct reason from `:malformed`, because
  a passive offer is well-formed and declined on policy, and a user
  reading the status message deserves that difference.

  ## Address decoding, and the loopback-smuggling door

  The historical address field is a 32-bit unsigned integer in network
  byte order, so classic senders put IPv4 there in decimal; an IPv6
  literal is the de-facto extension (the integer field cannot hold one).
  Both are decoded here into an `:inet` tuple. The literal path routes
  through `Grappa.Net.IpLiteral.to_tuple/1` — the tree's single strict
  literal parser — rather than a second hand-rolled one, and its
  STRICTNESS is the point: a zero-padded or octal-looking form
  (`017700000001`, `010.0.0.1`) is refused rather than decoded to
  loopback. A hostname is refused outright; DCC carries an address, and
  accepting a name would hand the peer a DNS-rebind lever over a
  connection we make on the user's behalf.

  Deciding whether the decoded address is one we may DIAL is not this
  module's job — that is `Grappa.Net.Ssrf.safe_public_ip?/1`, applied by
  the caller before it connects.
  """

  alias Grappa.IRC.DCC.Offer
  alias Grappa.Net.IpLiteral

  @v4_max 4_294_967_295
  @port_max 65_535

  @typedoc """
  Why an offer was not turned into an `Offer`.

  * `:passive_unsupported` — well-formed, declined on policy (we never listen).
  * `{:unsupported_subcommand, verb}` — a DCC verb we do not implement; `verb`
    is upper-cased so the reason is canonical whatever the sender's casing.
  * `:malformed` — the argument string is not a DCC offer at all.
  """
  @type refusal :: :passive_unsupported | {:unsupported_subcommand, String.t()} | :malformed

  @doc """
  Parses the argument string of a CTCP `DCC` frame.

  Takes what `Grappa.IRC.CTCP.verb_args/1` returns as `args` for the
  `DCC` verb — i.e. `"SEND name addr port size"`, with the CTCP
  delimiters already stripped.
  """
  @spec parse(String.t()) :: {:ok, Offer.t()} | {:error, refusal()}
  def parse(args) when is_binary(args) do
    case String.split(args, " ", parts: 2) do
      [subcommand, rest] -> dispatch(String.upcase(subcommand), rest)
      [_] -> {:error, :malformed}
    end
  end

  defp dispatch("SEND", rest), do: parse_send(rest)
  defp dispatch("", _), do: {:error, :malformed}
  defp dispatch(subcommand, _), do: {:error, {:unsupported_subcommand, subcommand}}

  defp parse_send(rest) do
    case split_filename(rest) do
      {:ok, filename, tail} -> build(filename, String.split(tail, " "))
      :error -> {:error, :malformed}
    end
  end

  # A filename containing spaces is quoted by every classic sender.
  # Guessing an unquoted split would make the ADDRESS field's position
  # depend on the filename's content, so an unquoted name with spaces is
  # refused by falling through to the arity check in `build/2`.
  defp split_filename(<<?", rest::binary>>) do
    case String.split(rest, ~s{" }, parts: 2) do
      [filename, tail] -> {:ok, filename, tail}
      [_] -> :error
    end
  end

  defp split_filename(rest) do
    case String.split(rest, " ", parts: 2) do
      [filename, tail] -> {:ok, filename, tail}
      [_] -> :error
    end
  end

  # Three fields is the normal offer; four means a passive token rides
  # along. The passive arm still validates the triple first, so an
  # UNQUOTED filename with spaces (which also lands here with the wrong
  # arity or unparseable fields) is reported as malformed rather than
  # mislabelled as a declined passive offer.
  defp build(filename, [address, port, size]) do
    case parse_triple(address, port, size) do
      {:ok, _, 0, _} -> {:error, :passive_unsupported}
      {:ok, ip, port_number, size_bytes} -> {:ok, offer(filename, ip, port_number, size_bytes)}
      :error -> {:error, :malformed}
    end
  end

  defp build(_, [address, port, size, _]) do
    case parse_triple(address, port, size) do
      {:ok, _, _, _} -> {:error, :passive_unsupported}
      :error -> {:error, :malformed}
    end
  end

  defp build(_, _), do: {:error, :malformed}

  defp offer(filename, ip, port, size) do
    %Offer{filename: filename, ip: ip, port: port, size: size}
  end

  # Port `0` is carried through as a legal value so `build/2` can tell a
  # passive offer (well-formed, declined) from a malformed one.
  defp parse_triple(address, port, size) do
    with {:ok, ip} <- parse_address(address),
         {:ok, port_number} <- parse_integer(port, 0, @port_max),
         {:ok, size_bytes} <- parse_size(size) do
      {:ok, ip, port_number, size_bytes}
    end
  end

  defp parse_address(address) do
    case Integer.parse(address) do
      {int, ""} when int >= 0 and int <= @v4_max -> {:ok, v4_tuple(int)}
      _ -> literal_address(address)
    end
  end

  # Strict-only, via the tree's single literal parser: a zero-padded or
  # octal-looking form must never decode to loopback.
  defp literal_address(address) do
    case IpLiteral.to_tuple(address) do
      {:ok, tuple} -> {:ok, tuple}
      :error -> :error
    end
  end

  defp v4_tuple(int) do
    <<a, b, c, d>> = <<int::unsigned-big-integer-size(32)>>
    {a, b, c, d}
  end

  # No upper bound on a declared size: the cap is a policy the caller
  # applies, and a parser that silently clamped it would hide the claim
  # the cap has to judge.
  defp parse_size(size) do
    case Integer.parse(size) do
      {int, ""} when int >= 0 -> {:ok, int}
      _ -> :error
    end
  end

  defp parse_integer(value, min, max) do
    case Integer.parse(value) do
      {int, ""} when int >= min and int <= max -> {:ok, int}
      _ -> :error
    end
  end
end
