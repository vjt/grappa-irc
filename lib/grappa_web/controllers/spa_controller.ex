defmodule GrappaWeb.SpaController do
  @moduledoc """
  #399 — serves the cicchetto SPA shell + service worker from the
  embedded Phoenix web server, so a plain `bin/grappa start` on an HTTP
  port yields a working instance without nginx in front.

  Replicates the two nginx location rules a self-hoster would otherwise
  need (`infra/snippets/locations-api.conf`):

    * `location / { try_files $uri /index.html; }` — the SPA
      history-mode fallback. `index/2` here is the router catch-all
      (`GET /*path`); it serves `index.html` for a browser navigation
      so a hard refresh on a client-side route (`/theme/:id`, `/login`,
      …) survives. The real static files were already served by the
      endpoint's `Plug.Static` before the router ran; this fires only
      for paths that matched neither a static file nor an explicit API
      route.
    * `location = /service-worker.js { add_header Cache-Control
      "no-cache"; }` — `service_worker/2`, so a PWA update is never
      pinned by a stale service worker.

  The dist directory is resolved via `Grappa.Cic.Bundle.root/0` (the
  single source of truth, boot `:persistent_term`), the same root the
  `Plug.Static` plug and the bundle hash/version live-read use.
  """

  use GrappaWeb, :controller

  alias Grappa.Cic.Bundle

  # Registers `@sobelow_skip` (consumed by Sobelow, not the compiler)
  # so the false-positive traversal finding on `serve/2` can be
  # suppressed with a justification — see that function. `accumulate:
  # true` + `persist: true` mirror `GrappaWeb.UploadsController`.
  Module.register_attribute(__MODULE__, :sobelow_skip, accumulate: true, persist: true)

  @doc """
  SPA history-mode fallback. Serves `index.html` for a browser
  navigation so a hard refresh on a client-side route (`/theme/:id`,
  `/login`, …) survives.

  Served when the request accepts HTML: a real browser navigation
  always sends `Accept: text/html`, and a bare client (curl, or a
  `fetch()` with no explicit Accept, which defaults to `*/*`) also gets
  the shell — so `curl http://host/` smoke-tests straight to the app
  page, the #399 self-hoster's first check. Only a client that sends an
  explicit non-HTML Accept (e.g. `application/json`) opts out to a JSON
  404. NOTE: cic's own REST client (`api.ts` `buildHeaders`) sends NO
  Accept AND only ever targets real route patterns (which win over this
  catch-all), so cic never reaches this arm — it is a narrow escape
  hatch, not cic's path.
  """
  @spec index(Plug.Conn.t(), map()) :: Plug.Conn.t()
  def index(conn, _) do
    if wants_html?(conn) do
      conn
      |> put_resp_content_type("text/html")
      |> serve("index.html")
    else
      not_found_json(conn)
    end
  end

  @doc """
  Serves `service-worker.js` with `Cache-Control: no-cache` (nginx
  parity), so browsers always re-fetch the SW script and PWA updates
  are never pinned by HTTP caching. The header itself comes from
  `serve/2` — see there for why it is not set per-action.
  """
  @spec service_worker(Plug.Conn.t(), map()) :: Plug.Conn.t()
  def service_worker(conn, _) do
    conn
    |> put_resp_content_type("text/javascript")
    |> serve("service-worker.js")
  end

  # `send_file/3` targets `Path.join(Bundle.root(), <compile-time
  # literal>)` — the filename is never user input and the root is boot
  # config, so the traversal finding is a false positive. Sobelow
  # attributes it to THIS function (the call site), not the public
  # actions that delegate here. Content-type is set by the caller with a
  # string literal (avoids an XSS.ContentType false positive on a
  # variable type).
  #
  # #1063 — `cache-control: no-cache` is set HERE, not per-action.
  # Every document served out of the bundle root is an update-delivery
  # entry point: `service-worker.js` is how a new worker reaches the
  # browser, and `index.html` is the SOLE carrier of the
  # `<script src="/assets/index-<hash>.js">` tag that decides which
  # bundle boots. A stale copy of either pins a client to an old
  # version. The policy was written for the worker and not the shell,
  # so it is now structural: a third document added below inherits it.
  #
  # MEASURED, against #1063's claim that the shell had "no cache policy
  # at all": it did — Phoenix's controller default,
  # `max-age=0, private, must-revalidate`, which already forbids the
  # heuristic freshness that claim rests on. This line replaces an
  # incidental framework default with a chosen one that reads the same
  # in both actions; it is a durability change, NOT a fix for a client
  # observed stranded on an old bundle.
  @sobelow_skip ["Traversal.SendFile"]
  defp serve(conn, filename) do
    path = Path.join(Bundle.root(), filename)

    conn = put_resp_header(conn, "cache-control", "no-cache")

    if File.regular?(path) do
      send_file(conn, 200, path)
    else
      # No bundle on disk (dev/CI before a cic build, or a release
      # deployed without one). Honest 404 — never a 500. An
      # nginx-fronted prod never reaches here: nginx serves the shell
      # itself.
      conn
      |> put_status(:not_found)
      |> put_resp_content_type("text/plain")
      |> text("cicchetto frontend bundle not built")
    end
  end

  defp not_found_json(conn) do
    conn
    |> put_status(:not_found)
    |> json(%{error: "not_found"})
  end

  # True for a browser document navigation (`Accept: text/html`, always
  # present on a real nav) and for a bare client (no Accept, or the
  # `fetch()`/curl default `*/*`) — both get the shell. False only for
  # an explicit non-HTML Accept (e.g. `application/json`), which opts out
  # to a JSON 404. See `index/2`'s docstring for why cic never reaches
  # the false branch.
  defp wants_html?(conn) do
    accept = conn |> get_req_header("accept") |> List.first() || ""
    accept == "" or String.contains?(accept, "text/html") or String.contains?(accept, "*/*")
  end
end
