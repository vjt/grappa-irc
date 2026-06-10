defmodule GrappaWeb.UploadsController do
  @moduledoc """
  Embedded media upload (image / video / document) — UX-6 bucket B1
  (2026-05-20), extended to per-category MIMEs (2026-06-09).

  ## POST /api/uploads (authenticated)

  Multipart body:

    * `file` — binary, required. The file bytes.
    * `expire` — integer string in seconds, optional. Translates to
      `expires_at = now + expire`. Allowed values: matches the
      `1h/12h/24h/72h` ladder (3600 / 43200 / 86400 / 259200) per
      cluster spec. Defaults to 86400 (24h) when omitted, mirroring
      litterbox + `Grappa.UserSettings.get_upload_ttl_seconds/1`'s
      ladder.

  Boundary checks (in order — fail fast on the cheapest):

    1. Multipart shape — missing `file` → 400 bad_request.
    2. MIME — must be a key of `@mime_categories` (image / video /
       document allowlists) → 415 unsupported. The category is
       DERIVED from the MIME at request time, never stored — no
       schema change.
    3. Per-file cap — `byte_size(content) <= cap` where cap comes
       from `Grappa.ServerSettings.get_upload_per_file_cap_bytes/1`
       for the derived category (image 10MiB / video 50MiB /
       document 10MiB defaults). Else 413 file_too_large.
    4. Global cap — `live_bytes_sum + byte_size <= global_cap_bytes`.
       Else 507 insufficient_storage.
    5. Slug minted, file written, row inserted via
       `Grappa.Uploads.create/3`.

  Response: 201 with `%{slug, url, expires_at}` (url absolute, via
  Endpoint.url/0).

  ## GET /uploads/:slug (public, NO auth)

  Streams the file via `Plug.Conn.send_file/5`. Validates slug shape
  + row + on-disk file. Any failure → 404 with no oracle.
  Cache-Control short to allow CDN/browser reuse of the immediate
  fetch without staleness on TTL expiry.

  Honors single-range `Range:` requests (206 + `content-range`,
  416 when unsatisfiable, full 200 when ignorable) via
  `GrappaWeb.ByteRange` — iOS/macOS Safari refuse to play video
  without byte-range support (2026-06-10 prod incident).
  """

  use GrappaWeb, :controller

  alias Grappa.{ServerSettings, Subject, Uploads}
  alias GrappaWeb.ByteRange

  # `@sobelow_skip` is consumed by the Sobelow analyzer, not by the
  # Elixir compiler. Without this `register_attribute` it would emit
  # "module attribute set but never used" warnings + fail
  # `mix compile --warnings-as-errors`. `accumulate: true` lets
  # multiple functions in the module each carry their own skip-list.
  Module.register_attribute(__MODULE__, :sobelow_skip, accumulate: true, persist: true)

  # MIME → cap-category map. Closed allowlist: unknown MIME → 415.
  # The category picks WHICH per-file cap applies (a 50MiB video
  # ceiling must not gift 50MiB to raw images); it is derived here
  # per request and never persisted.
  @mime_categories %{
    "image/png" => :image,
    "image/jpeg" => :image,
    "image/gif" => :image,
    "image/webp" => :image,
    "image/apng" => :image,
    "video/mp4" => :video,
    "video/quicktime" => :video,
    "video/webm" => :video,
    "application/pdf" => :document,
    "text/plain" => :document,
    "application/vnd.oasis.opendocument.text" => :document,
    "application/vnd.oasis.opendocument.spreadsheet" => :document,
    "application/vnd.openxmlformats-officedocument.wordprocessingml.document" => :document,
    "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet" => :document
  }

  @allowed_ttl_seconds [3600, 43_200, 86_400, 259_200]
  @default_ttl_seconds 86_400

  # ------------------------------------------------------------------
  # POST /api/uploads
  # ------------------------------------------------------------------

  # @sobelow_skip ["Traversal.FileModule"]
  # `read_file/1` reads `Plug.Upload.path`, a tmp file synthesized by
  # `Plug.Parsers :multipart` — never user-controlled string input.
  # Sobelow can't follow provenance through the multipart parser.
  @sobelow_skip ["Traversal.FileModule"]
  @doc false
  @spec create(Plug.Conn.t(), map()) :: Plug.Conn.t() | {:error, atom()}
  def create(conn, params) do
    subject = Subject.from_assigns(conn.assigns)

    with {:ok, upload} <- extract_upload_field(params),
         {:ok, ttl_seconds} <- parse_ttl(params),
         {:ok, mime, category} <- validate_mime(upload),
         {:ok, bytes} <- read_file(upload),
         :ok <- check_per_file_cap(bytes, category),
         :ok <-
           Uploads.check_global_cap(byte_size(bytes), ServerSettings.get_upload_global_cap_bytes()),
         {:ok, row} <-
           Uploads.create(bytes, build_attrs(subject, mime, upload, ttl_seconds), storage_root: storage_root()) do
      conn
      |> put_status(:created)
      |> json(%{
        slug: row.slug,
        url: public_url(row.slug),
        expires_at: DateTime.to_iso8601(row.expires_at)
      })
    end
  end

  # ------------------------------------------------------------------
  # GET /uploads/:slug
  # ------------------------------------------------------------------

  @doc false
  @spec show(Plug.Conn.t(), map()) :: Plug.Conn.t()
  def show(conn, %{"slug" => slug}) when is_binary(slug) do
    with {:ok, row} <- Uploads.get_by_slug(slug, DateTime.utc_now()),
         path = Uploads.storage_path(storage_root(), row.slug),
         {:ok, %File.Stat{size: size}} <- File.stat(path) do
      conn
      |> put_resp_header("content-type", row.mime)
      |> put_resp_header("content-disposition", disposition_header(row))
      |> put_resp_header("cache-control", "public, max-age=3600")
      |> put_resp_header("accept-ranges", "bytes")
      |> send_ranged(path, size, get_req_header(conn, "range"))
    else
      _ ->
        # No oracle — slug shape, row missing, deleted, expired, file
        # missing all collapse to the same 404.
        conn
        |> put_status(:not_found)
        |> put_resp_content_type("application/json")
        |> json(%{error: "not_found"})
    end
  end

  def show(conn, _) do
    conn |> put_status(:not_found) |> json(%{error: "not_found"})
  end

  # ------------------------------------------------------------------
  # Internal — Range serving
  # ------------------------------------------------------------------

  # Single Range header → 206 slice / 416 / full 200 per
  # GrappaWeb.ByteRange's verdict. Zero or multiple Range headers →
  # full 200 (a server MAY ignore Range; multi-header is malformed
  # anyway). iOS Safari requires the 206 path to play video at all.
  #
  # `path` comes from `Uploads.storage_path/2` which validates the
  # slug against `^[a-z2-7]{26}$` — no `..` traversal reachable.
  # Sobelow can't follow the validator across the call boundary.
  @sobelow_skip ["Traversal.SendFile"]
  defp send_ranged(conn, path, size, [header]) do
    case ByteRange.parse(header, size) do
      {:ok, {offset, length}} ->
        conn
        |> put_resp_header(
          "content-range",
          "bytes #{offset}-#{offset + length - 1}/#{size}"
        )
        |> send_file(206, path, offset, length)

      :unsatisfiable ->
        conn
        |> put_resp_header("content-range", "bytes */#{size}")
        |> send_resp(416, "")

      :ignore ->
        send_file(conn, 200, path)
    end
  end

  @sobelow_skip ["Traversal.SendFile"]
  defp send_ranged(conn, path, _, _), do: send_file(conn, 200, path)

  # ------------------------------------------------------------------
  # Internal — extraction + validation
  # ------------------------------------------------------------------

  defp extract_upload_field(%{"file" => %Plug.Upload{} = upload}), do: {:ok, upload}
  defp extract_upload_field(_), do: {:error, :bad_request}

  defp parse_ttl(%{"expire" => raw}) when is_binary(raw) do
    case Integer.parse(raw) do
      {n, ""} when n in @allowed_ttl_seconds -> {:ok, n}
      _ -> {:error, :bad_request}
    end
  end

  defp parse_ttl(%{"expire" => n}) when is_integer(n) and n in @allowed_ttl_seconds, do: {:ok, n}
  defp parse_ttl(%{"expire" => _}), do: {:error, :bad_request}
  defp parse_ttl(_), do: {:ok, @default_ttl_seconds}

  defp validate_mime(%Plug.Upload{content_type: ct}) when is_binary(ct) do
    case Map.fetch(@mime_categories, ct) do
      {:ok, category} -> {:ok, ct, category}
      :error -> {:error, :unsupported_media_type}
    end
  end

  defp validate_mime(_), do: {:error, :unsupported_media_type}

  # `path` is `Plug.Upload.path`, a tmp file synthesized by
  # `Plug.Parsers :multipart` — never user-controlled string input.
  @sobelow_skip ["Traversal.FileModule"]
  defp read_file(%Plug.Upload{path: path}) do
    case File.read(path) do
      {:ok, bytes} -> {:ok, bytes}
      {:error, _} -> {:error, :bad_request}
    end
  end

  defp check_per_file_cap(bytes, category) do
    cap = ServerSettings.get_upload_per_file_cap_bytes(category)

    if byte_size(bytes) <= cap do
      :ok
    else
      {:error, {:file_too_large, cap}}
    end
  end

  defp build_attrs(subject, mime, %Plug.Upload{filename: filename}, ttl_seconds) do
    now = DateTime.utc_now()

    # `:bytes` is set inside `Uploads.create/3` from the actual
    # binary size — passing 0 here would be ignored, but it's
    # cleaner to omit it entirely.
    %{
      subject: subject,
      mime: mime,
      original_filename: filename,
      expires_at: DateTime.add(now, ttl_seconds, :second)
    }
  end

  defp public_url(slug), do: GrappaWeb.Endpoint.url() <> "/uploads/" <> slug

  defp disposition_header(%{original_filename: nil}), do: "inline"

  defp disposition_header(%{original_filename: filename}) when is_binary(filename) do
    # RFC 5987 ext-value: ASCII-quoted filename + filename* with
    # percent-encoded UTF-8 fallback. Browsers honour the encoded form.
    #
    # REV-J M18: pre-fix this used `URI.encode_www_form/1` which is
    # form-URL-encoded (space → `+`, plus-sign → `%2B`). RFC 5987
    # `ext-value` (used inside `filename*=UTF-8''...`) requires
    # percent-encoded UTF-8 per RFC 3986 `pct-encoded` — space MUST
    # be `%20`, not `+`. Strict-spec browsers receive the wrong
    # filename when given the form-encoded shape. `URI.encode/2`
    # with the RFC 3986 unreserved-char predicate produces the
    # correct shape.
    encoded = URI.encode(filename, &URI.char_unreserved?/1)
    ~s|inline; filename="#{ascii_safe(filename)}"; filename*=UTF-8''#{encoded}|
  end

  defp ascii_safe(s) do
    s
    |> String.replace(~r/[^\x20-\x7E]/, "_")
    |> String.replace(~r/["\\]/, "_")
  end

  defp storage_root, do: Grappa.Uploads.storage_root()
end
