defmodule GrappaWeb.MultipartLimits do
  @moduledoc """
  The two multipart body ceilings (issue 2529), read by the router's two
  multipart pipelines and pinned to the in-repo nginx configs by
  `GrappaWeb.MultipartBodyTest`.

  A multipart body is parsed by the route that takes it, after
  authentication (`GrappaWeb.Router`'s `:upload_body` and
  `:multipart_body`); the endpoint's `Plug.Parsers` carries no multipart
  parser at all. The three upload doors, whose body a per-file cap polices
  (`Grappa.ServerSettings.get_upload_per_file_cap_bytes/1`), read up to
  `upload_length/0`, sized to clear the largest cap an operator can set
  (`Grappa.ServerSettings.max_upload_per_file_cap_bytes/0`) with room for
  the framing, so every cap that saves is one an upload can reach. Any
  other route that takes a file reads up to `default_length/0`.

  The numbers are literals, not computed from `Grappa.ServerSettings`: the
  router reads them at compile time, and a compile-time call into a module
  with runtime dependencies would recompile the router, and the endpoint
  that plugs it, whenever anything in that module's graph changed.
  `GrappaWeb.MultipartBodyTest` fails when the maximum outgrows
  `upload_length/0`.
  """

  @mib 1024 * 1024

  # The ceiling every multipart body had before issue 2529, kept wherever
  # nothing needs more.
  @default_length 128 * @mib

  # The largest settable per-file cap (512 MiB) plus 8 MiB of room for the
  # multipart framing (boundary lines, part headers, the small sibling
  # fields). Whole MiB, so nginx states it exactly: `client_max_body_size
  # 520m`.
  @upload_length 520 * @mib

  @doc "The multipart body ceiling of a route that takes a file and is not an upload door."
  @spec default_length() :: unquote(@default_length)
  def default_length, do: @default_length

  @doc "The multipart body ceiling of the three upload doors."
  @spec upload_length() :: unquote(@upload_length)
  def upload_length, do: @upload_length
end
