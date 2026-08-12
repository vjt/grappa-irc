defmodule Grappa.Uploads.ContentType do
  @moduledoc """
  Content-Type parsing + rebuilding for uploads (GH #1256).

  ## Why this exists

  `GET /uploads/:slug` echoed the stored MIME verbatim, and the stored
  MIME was a bare `text/plain` — no `charset`. A browser given
  unlabelled text falls back to its locale default (windows-1252 in
  Western locales), so a UTF-8 paste rendered as mojibake even though
  the bytes on disk were fine.

  The charset could not get in either: the upload allowlist matched the
  client-declared type by whole-string equality, which made a closed
  MIME allowlist accidentally a closed *parameter* allowlist. A client
  labelling its encoding correctly (`text/plain; charset=utf-8`) was
  exactly the one getting 415.

  ## The shape

  `parse/1` splits `type/subtype` from the parameter run so the caller
  can match the type against its allowlist, and returns the charset as
  an ATOM from a closed set — never the client's string.
  `header/2` rebuilds the response header from that atom.

  That asymmetry is the security property. Once parameters are
  accepted, the raw parameter run is client-controlled text on its way
  into a response header, and `x-content-type-options: nosniff`
  (`UploadsController.show/2`) only pins the browser to whatever we
  declare. So the parameter run is never stored and never echoed: an
  unrecognised charset is DROPPED and the upload is still accepted,
  which also leaves the mirror-image case intact — a genuinely Latin-1
  `.txt` uploaded by hand stays unlabelled and keeps rendering under
  the browser's locale default, as it did before #1256.

  A charset is only meaningful for text, so it is read only off a
  `text/*` type. That is derived from the type itself rather than kept
  as a second allowlist beside `@mime_categories`.
  """

  @typedoc "The closed set of charsets grappa will label bytes with."
  @type charset :: :utf8

  # charset atom → the ONLY spelling that may reach a response header.
  @wire %{utf8: "utf-8"}

  # Accepted client spellings → charset atom. Compared after trimming,
  # unquoting and ASCII-downcasing (RFC 2045: parameter names and the
  # charset value are case-insensitive, values may be quoted strings).
  # `utf8` is not the registered name but is a common client spelling,
  # and a client that sends it means the same thing — accepting it
  # costs nothing, because the OUTPUT is rebuilt from `@wire` either
  # way.
  @accepted %{"utf-8" => :utf8, "utf8" => :utf8}

  @doc """
  Split a client-declared content type into its `type/subtype` and the
  charset it declared, if that charset is one grappa will label bytes
  with. Total: an absent, malformed or unrecognised parameter run
  yields `nil`, never an error.
  """
  @spec parse(String.t()) :: {String.t(), charset() | nil}
  def parse(raw) when is_binary(raw) do
    [type | params] = String.split(raw, ";")
    mime = normalise(type)
    {mime, charset_of(mime, params)}
  end

  @doc """
  Rebuild a `content-type` header value from a stored MIME and a
  stored charset. The charset is re-spelled from `@wire`, so no
  client-supplied byte can reach the header through this function.
  """
  @spec header(String.t(), charset() | nil) :: String.t()
  def header(mime, nil) when is_binary(mime), do: mime

  def header(mime, charset) when is_binary(mime) and is_map_key(@wire, charset),
    do: mime <> "; charset=" <> Map.fetch!(@wire, charset)

  @doc """
  The charset atoms this module can store and re-emit. Feeds the
  `Ecto.Enum` on `Grappa.Uploads.Upload.charset`, so the column and
  the header builder cannot drift apart.
  """
  @spec charsets() :: [charset()]
  def charsets, do: Map.keys(@wire)

  defp charset_of("text/" <> _, params), do: Enum.find_value(params, &charset_param/1)
  defp charset_of(_, _), do: nil

  defp charset_param(param) do
    case String.split(param, "=", parts: 2) do
      [name, value] -> accepted(normalise(name), value)
      _ -> nil
    end
  end

  defp accepted("charset", value) do
    Map.get(@accepted, value |> String.trim() |> String.trim("\"") |> normalise())
  end

  defp accepted(_, _), do: nil

  defp normalise(s), do: s |> String.trim() |> String.downcase(:ascii)
end
