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
       document / audio allowlists) → 415 unsupported. The category is
       DERIVED from the MIME at request time, never stored — no
       schema change. Audio uploads the OS labels
       `application/octet-stream` (common for .m4a/.flac) are rescued
       by extension to their canonical audio MIME (see
       `@audio_ext_canonical_mime`); every other octet-stream stays
       415.
    3. Per-file cap — `byte_size(content) <= cap` where cap comes
       from `Grappa.ServerSettings.get_upload_per_file_cap_bytes/1`
       for the derived category (image 10MiB / video 50MiB /
       document 10MiB / audio 25MiB defaults). Else 413 file_too_large.
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
    "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet" => :document,
    # Audio (GH #115) — "anything modern browsers reliably play": mp3,
    # m4a/m4r (AAC + ALAC both ride audio/mp4), wav, flac. opus/ogg are
    # deferred OUT (Safari support patchy). Mirror order with cic's
    # AUDIO_MIMES in cicchetto/src/lib/uploadCategory.ts.
    "audio/mpeg" => :audio,
    "audio/mp4" => :audio,
    "audio/x-m4a" => :audio,
    "audio/aac" => :audio,
    "audio/wav" => :audio,
    "audio/x-wav" => :audio,
    "audio/wave" => :audio,
    "audio/flac" => :audio,
    "audio/x-flac" => :audio
  }

  # Audio extension → canonical MIME for the octet-stream rescue below.
  # iOS/macOS commonly send `application/octet-stream` for .m4a/.flac;
  # the MIME-only allowlist would 415 those. We normalize by extension
  # to the canonical audio MIME so the STORED (and therefore SERVED)
  # Content-Type is one the browser will play — not octet-stream
  # (vjt 2026-06-27: "ensure grappa emits the right mime"). Scoped to
  # the audio set ONLY; every other octet-stream stays 415, so the
  # closed-allowlist model holds for non-audio.
  @audio_ext_canonical_mime %{
    "mp3" => "audio/mpeg",
    "m4a" => "audio/mp4",
    "m4r" => "audio/mp4",
    "wav" => "audio/wav",
    "flac" => "audio/flac"
  }

  # Generic MIMEs the OS sends when it can't identify an audio file.
  # Only these trigger the extension sniff; a correct non-audio MIME
  # is never reinterpreted.
  @sniffable_generic_mimes ["application/octet-stream"]

  @allowed_ttl_seconds [3600, 43_200, 86_400, 259_200]
  @default_ttl_seconds 86_400

  @doc """
  The closed MIME → cap-category allowlist. Public so the
  `Grappa.Uploads.MetadataStrip` lockstep test can assert every
  image/video entry has a strip mapping — an allowlist addition
  without one fails CLOSED at upload time (422); the test turns that
  prod surprise into a red suite. Audio entries are exempt: audio
  passes through MetadataStrip untouched (documents do the same), so
  the lockstep only pins `category in [:image, :video]`.
  """
  @spec mime_categories() :: %{String.t() => :image | :video | :document | :audio}
  def mime_categories, do: @mime_categories

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
         :ok <- check_per_file_cap(upload, category),
         {:ok, bytes} <- read_file(upload),
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
      # S5: user bytes are served inline from the SAME origin as cic and
      # text/plain is in the accept allowlist, so uploaded text carrying
      # HTML/JS could be MIME-sniffed into an executable HTML response on
      # the app origin (where the bearer lives in client storage).
      # `nosniff` pins the browser to the declared content-type. Set here,
      # BEFORE send_ranged/4, so it rides every path it emits — 200, 206
      # (range), and 416 — from one source.
      |> put_resp_header("x-content-type-options", "nosniff")
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
  # anyway), as is a zero-size on-disk file (DB validates bytes > 0,
  # but disk truncation can diverge — ByteRange contracts total > 0,
  # and an empty 200 preserves the no-oracle failure surface).
  # iOS Safari requires the 206 path to play video at all.
  #
  # `path` comes from `Uploads.storage_path/2` which validates the
  # slug against `^[a-z2-7]{26}$` — no `..` traversal reachable.
  # Sobelow can't follow the validator across the call boundary.
  @sobelow_skip ["Traversal.SendFile"]
  defp send_ranged(conn, path, size, range_headers) do
    verdict =
      case range_headers do
        [header] when size > 0 -> ByteRange.parse(header, size)
        _ -> :ignore
      end

    case verdict do
      {:ok, {offset, length}} ->
        conn
        |> put_resp_header(
          "content-range",
          "bytes #{offset}-#{offset + length - 1}/#{size}"
        )
        |> send_file(206, path, offset, length)

      :unsatisfiable ->
        # Strip the freshness grant: a shared cache may store any
        # explicitly-fresh final response, and a cached 416 would pin
        # the bare URL dead for an hour.
        conn
        |> delete_resp_header("cache-control")
        |> put_resp_header("content-range", "bytes */#{size}")
        |> send_resp(416, "")

      :ignore ->
        send_file(conn, 200, path)
    end
  end

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

  defp validate_mime(%Plug.Upload{content_type: ct, filename: filename}) when is_binary(ct) do
    case Map.fetch(@mime_categories, ct) do
      {:ok, category} -> {:ok, ct, category}
      :error -> sniff_audio(ct, filename)
    end
  end

  defp validate_mime(_), do: {:error, :unsupported_media_type}

  # octet-stream rescue: normalize a generically-typed audio upload to
  # its canonical audio MIME by file extension (see
  # @audio_ext_canonical_mime). Anything outside the audio extension
  # set — or a non-generic MIME — stays 415, preserving the closed
  # allowlist for every other type.
  defp sniff_audio(ct, filename)
       when ct in @sniffable_generic_mimes and is_binary(filename) do
    ext = filename |> Path.extname() |> String.downcase() |> String.trim_leading(".")

    case Map.fetch(@audio_ext_canonical_mime, ext) do
      {:ok, mime} -> {:ok, mime, :audio}
      :error -> {:error, :unsupported_media_type}
    end
  end

  defp sniff_audio(_, _), do: {:error, :unsupported_media_type}

  # `path` is `Plug.Upload.path`, a tmp file synthesized by
  # `Plug.Parsers :multipart` — never user-controlled string input.
  @sobelow_skip ["Traversal.FileModule"]
  defp read_file(%Plug.Upload{path: path}) do
    case File.read(path) do
      {:ok, bytes} -> {:ok, bytes}
      {:error, _} -> {:error, :bad_request}
    end
  end

  # S4: enforce the per-file cap against the on-disk size (`File.stat`)
  # BEFORE `read_file/1` pulls the whole temp file into the BEAM heap.
  # The transport ceiling is 128 MiB (endpoint.ex:79) but the image cap
  # is 10 MiB — without this pre-read gate an authenticated user OR a
  # visitor can buffer ~127 MiB into the heap before the policy rejects
  # it (~12× amplification, repeatable concurrently, visitor-eligible).
  # The cap is checked on the RAW file size, identical to the previous
  # post-read `byte_size(bytes)` semantics (the cap always applied to the
  # pre-strip bytes) — only the ordering moved earlier. A stat failure
  # (temp file vanished under us) collapses to 400, the same reject
  # `read_file/1` would have produced on the following line.
  #
  # `path` is `Plug.Upload.path`, a tmp file synthesized by
  # `Plug.Parsers :multipart` — never user-controlled string input.
  defp check_per_file_cap(%Plug.Upload{path: path}, category) do
    cap = ServerSettings.get_upload_per_file_cap_bytes(category)

    case File.stat(path) do
      {:ok, %File.Stat{size: size}} when size <= cap -> :ok
      {:ok, %File.Stat{}} -> {:error, {:file_too_large, cap}}
      {:error, _} -> {:error, :bad_request}
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
