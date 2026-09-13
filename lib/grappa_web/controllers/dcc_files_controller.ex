defmodule GrappaWeb.DccFilesController do
  @moduledoc """
  Serving a DCC file the operator accepted (issue 2089).

  A sibling of `GrappaWeb.DccOffersController` rather than an action on
  it, because the two are different resources with different lifetimes: an
  OFFER is per-session memory whose hold runs out in minutes and dies with
  the process, a FILE is bytes on disk with a retention the reaper
  enforces. One controller with a mode would be the shared data model with
  a type flag.

  ## Not the public `/uploads/:slug` shape, deliberately

  These bytes came off a STRANGER's socket. They are not something the
  operator's user chose to publish, so they stay behind the same `:authn`
  + `ResolveNetwork` gate every other `/networks/:network_id/*` route has,
  and the lookup is scoped to the RESOLVED network — `Grappa.Dcc` takes
  the subject AND the network id, so "the caller owns a credential on the
  network in the path" is enforced rather than merely intended. Same call,
  same reasoning, as `NetworksController.peer_avatar/2`.

  ## The three response headers are the security posture

  `application/octet-stream` + `Content-Disposition: attachment` +
  `X-Content-Type-Options: nosniff`, always, with no branch. The peer
  declared no MIME type — a `DCC SEND` carries a filename, an address, a
  port and a size, and nothing else — so there is nothing to echo even if
  echoing it were safe, and the schema deliberately has no `mime` column
  to be tempted by. Anything that lets a browser decide for itself what
  these bytes are turns the spool into a stored-XSS door on the operator's
  own origin. The filename in the disposition is the NEUTRALISED one the
  banner and the scrollback row used.
  """
  use GrappaWeb, :controller

  # Registers `@sobelow_skip` so the annotation on `show/2` below does not
  # warn as an unused module attribute — same line, same reason, as
  # `GrappaWeb.NetworksController`.
  Module.register_attribute(__MODULE__, :sobelow_skip, accumulate: true, persist: true)

  alias Grappa.Dcc
  alias GrappaWeb.Subject

  @doc """
  `GET /networks/:network_id/dcc_files/:slug` — the accepted file's bytes.

  200 with the bytes; 404 for a malformed slug, a missing row, a row
  spooled for a different subject or network, and a row whose file is
  gone. One collapsed answer with no oracle — the same posture
  `UploadsController.show/2` and `NetworksController.peer_avatar/2` take,
  and here it also keeps an ownership refusal from doubling as proof that
  the slug exists at all.

  `path` comes from `Dcc.storage_path/1`, which RAISES on anything that is
  not the 26-char minted shape before joining it — so the peer's own
  filename, which is stored as display metadata and never as a path,
  cannot reach `File.read/1` even in principle. `bytes` is opaque content
  served as an attachment; Sobelow cannot follow either provenance across
  the module boundary.
  """
  @sobelow_skip ["Traversal.FileModule", "XSS.SendResp"]
  @spec show(Plug.Conn.t(), map()) :: Plug.Conn.t()
  def show(conn, %{"slug" => slug}) when is_binary(slug) do
    subject = Subject.to_session(conn.assigns.current_subject)

    with {:ok, row} <- Dcc.get_by_slug(subject, conn.assigns.network.id, slug),
         {:ok, bytes} <- File.read(Dcc.storage_path(row.slug)) do
      conn
      |> put_resp_header("content-type", "application/octet-stream")
      |> put_resp_header("content-disposition", disposition(row.filename))
      |> put_resp_header("x-content-type-options", "nosniff")
      |> put_resp_header("cache-control", "private, max-age=3600")
      |> send_resp(200, bytes)
    else
      _ -> not_found(conn)
    end
  end

  def show(conn, _), do: not_found(conn)

  # RFC 6266 `filename*` in UTF-8, plus a bare `filename` fallback with
  # every quote and backslash stripped. The stored name is already
  # neutralised for CONTROL bytes by `Grappa.Dcc.Report.display_filename/1`
  # — this strips what would break the HEADER, which is a different
  # alphabet and therefore a second pass rather than a duplicated one.
  defp disposition(filename) do
    bare = String.replace(filename, ~r/["\\]/, "")
    ~s{attachment; filename="#{bare}"; filename*=UTF-8''#{URI.encode_www_form(filename)}}
  end

  defp not_found(conn), do: conn |> put_status(:not_found) |> json(%{error: "not_found"})
end
