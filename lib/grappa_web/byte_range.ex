defmodule GrappaWeb.ByteRange do
  @moduledoc """
  RFC 9110 §14 single-range `Range` header parser for file-serving
  controllers.

  iOS/macOS Safari refuse to play `<video>`/media-document resources
  from servers that answer `Range:` with a plain 200 — the 2026-06-10
  prod incident: uploads stored fine but never played on the dogfood
  iPhone. This module is the HTTP-layer arithmetic; the controller
  owns the response wiring (206/416/200 + `content-range`).

  Lives in `GrappaWeb` (like `GrappaWeb.Validation`) — it is wire
  shape, not domain logic, and is shared by any controller that
  `send_file`s.

  Verdicts:
  - `{:ok, {offset, length}}` — satisfiable single range; serve 206
    with `content-range: bytes offset-(offset+length-1)/total`.
  - `:unsatisfiable` — first-byte-pos ≥ total, or zero-length suffix;
    serve 416 with `content-range: bytes */total`.
  - `:ignore` — absent grammar, invalid spec (last < first), unknown
    unit, or multi-range (legal, but a server MAY ignore it); serve
    200 with the full body.
  """

  @doc """
  Parses a `Range` header value against a `total` resource size in
  bytes.
  """
  @spec parse(String.t(), pos_integer()) ::
          {:ok, {non_neg_integer(), pos_integer()}} | :unsatisfiable | :ignore
  def parse(header, total) when is_binary(header) and is_integer(total) and total > 0 do
    case String.split(header, "=", parts: 2) do
      [unit, spec] ->
        if String.downcase(unit) == "bytes" and not String.contains?(spec, ",") do
          parse_spec(spec, total)
        else
          :ignore
        end

      _ ->
        :ignore
    end
  end

  # suffix-range: "-N" = the last N bytes. N == 0 is unsatisfiable
  # per RFC 9110; N > total covers the whole file.
  defp parse_spec("-" <> suffix, total) do
    case parse_pos(suffix) do
      {:ok, 0} -> :unsatisfiable
      {:ok, n} -> ok_slice(max(total - n, 0), total)
      :error -> :ignore
    end
  end

  defp parse_spec(spec, total) do
    case String.split(spec, "-", parts: 2) do
      [first, ""] ->
        case parse_pos(first) do
          {:ok, f} when f >= total -> :unsatisfiable
          {:ok, f} -> ok_slice(f, total)
          :error -> :ignore
        end

      [first, last] ->
        parse_bounded(parse_pos(first), parse_pos(last), total)

      _ ->
        :ignore
    end
  end

  defp parse_bounded({:ok, f}, {:ok, l}, total) do
    cond do
      # last-byte-pos < first-byte-pos invalidates the whole header
      # (RFC 9110: recipient MUST ignore an invalid Range field).
      l < f -> :ignore
      f >= total -> :unsatisfiable
      true -> {:ok, {f, min(l, total - 1) - f + 1}}
    end
  end

  defp parse_bounded(_, _, _), do: :ignore

  defp ok_slice(offset, total), do: {:ok, {offset, total - offset}}

  # RFC 9110 positions are 1*DIGIT — no sign. Integer.parse/1 alone
  # would admit "+5"; the leading-digit guard closes that, and the
  # {n, ""} full-consumption match rejects any trailing junk.
  defp parse_pos(<<c, _::binary>> = s) when c in ?0..?9 do
    case Integer.parse(s) do
      {n, ""} -> {:ok, n}
      _ -> :error
    end
  end

  defp parse_pos(_), do: :error
end
