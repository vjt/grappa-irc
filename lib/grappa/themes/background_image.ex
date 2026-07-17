defmodule Grappa.Themes.BackgroundImage do
  @moduledoc """
  Theme background-image pipeline (#75): raster in → canonical PNG re-hosted on
  our own origin.

  A theme background is CSS `background-image: url(/uploads/<slug>)` rendered in
  every viewer's browser. Two threats: a polyglot file (valid image AND valid
  script) and an SSRF via fetch-by-URL. The defences, in order:

    1. **Source** — either a direct `Plug.Upload` or a URL fetched through the
       SSRF-guarded, size-capped `Grappa.Themes.ImageFetcher` (injected impl).
       Uploads are validated against the raster content-type allowlist (no SVG)
       and the same byte cap.
    2. **Decode + re-encode** — the bytes are run through ffmpeg (`-frames:v 1`,
       PNG encoder) under the shared `Grappa.Sys.HardenedCmd` hardening
       (wall-clock timeout, scrubbed env). This DECODES the pixels and emits a
       fresh flat PNG, so any non-image bytes riding a polyglot are dropped — a
       stronger guarantee than metadata stripping alone.
    3. **Re-host** — the re-encoded PNG is stored via `Grappa.Uploads.create/3`
       with a forced `image/png` mime and NO expiry (`expires_at` omitted → NULL
       → the Uploads Reaper never sweeps it; theme backgrounds are durable).
       `create/3` additionally runs its own metadata strip (belt-and-braces).

  The download surface serves the stored bytes with `Content-Type: image/png` +
  `nosniff`, so even a hypothetical surviving polyglot can't be script-executed
  by the browser.

  Returns `{:ok, slug}` or a tagged `{:error, reason}`; never raises.
  """
  require Logger

  alias Grappa.Sys.HardenedCmd
  alias Grappa.Themes.ImageFetcher
  alias Grappa.Uploads

  # Consumed by Sobelow (the tmp round-trip touches File.*); registered so the
  # unused-attribute warning doesn't trip --warnings-as-errors (mirrors
  # MetadataStrip / UploadsController).
  Module.register_attribute(__MODULE__, :sobelow_skip, accumulate: true, persist: true)

  @max_bytes 8 * 1024 * 1024
  @reencode_timeout_s 30

  @type source :: {:upload, Plug.Upload.t()} | {:url, String.t()}
  @type error :: :not_raster | :too_large | :ssrf_blocked | :fetch_failed | :image_reencode_failed

  @doc """
  Take a raster source, re-encode it to a canonical PNG, re-host it, and return
  the Uploads slug for storing in a theme payload's `background.image_id`.
  """
  @spec process_and_store(Grappa.Subject.t(), source()) :: {:ok, String.t()} | {:error, error()}
  def process_and_store(subject, source) do
    with {:ok, bytes} <- source_bytes(source),
         {:ok, png} <- reencode_png(bytes) do
      store(subject, png)
    end
  end

  ## Source acquisition

  defp source_bytes({:url, url}) when is_binary(url) do
    # The fetcher has already enforced the raster allowlist + size cap + SSRF
    # guard; its errors (`:ssrf_blocked | :not_raster | :too_large |
    # :fetch_failed`) are all in our error set, so they propagate as-is.
    case fetcher().fetch(url) do
      {:ok, bytes, _content_type} -> {:ok, bytes}
      {:error, reason} -> {:error, reason}
    end
  end

  defp source_bytes({:upload, %Plug.Upload{path: path, content_type: content_type}}) do
    with :ok <- validate_raster(content_type),
         {:ok, bytes} <- read_upload(path),
         :ok <- validate_size(bytes) do
      {:ok, bytes}
    end
  end

  # DI seam resolved at RUNTIME (mirrors Grappa.Push.BadgeSource.impl/0): reading
  # the injected impl from config here — rather than baking it via
  # `compile_env` into a module attribute — keeps a runtime-generated Mox mock
  # (test) from becoming a compile-time "module not available" warning, and
  # degrades gracefully to the real impl in the transient hot-deploy window
  # before `config.exs` re-runs.
  defp fetcher do
    :grappa
    |> Application.get_env(:themes, [])
    |> Keyword.get(:image_fetcher, ImageFetcher.Req)
  end

  defp validate_raster(content_type) when is_binary(content_type) do
    normalized =
      content_type
      |> String.split(";", parts: 2)
      |> List.first()
      |> String.trim()
      |> String.downcase()

    if normalized in ImageFetcher.raster_content_types(), do: :ok, else: {:error, :not_raster}
  end

  defp validate_raster(_), do: {:error, :not_raster}

  defp validate_size(bytes) when byte_size(bytes) > @max_bytes, do: {:error, :too_large}
  defp validate_size(_bytes), do: :ok

  # The path is Plug-managed (a multipart temp file), not a user-controlled
  # string — same provenance as UploadsController's read of the upload.
  @sobelow_skip ["Traversal.FileModule"]
  defp read_upload(path) do
    case File.read(path) do
      {:ok, bytes} -> {:ok, bytes}
      {:error, _posix} -> {:error, :image_reencode_failed}
    end
  end

  ## Re-encode

  defp reencode_png(bytes) do
    base = Path.join(System.tmp_dir!(), "grappa-theme-bg-" <> Uploads.mint_slug())
    in_path = base <> "-in"
    out_path = base <> "-out.png"

    try do
      with :ok <- write_tmp(in_path, bytes),
           :ok <- run_ffmpeg(in_path, out_path),
           {:ok, png} <- read_tmp(out_path) do
        {:ok, png}
      end
    after
      _ = File.rm(in_path)
      _ = File.rm(out_path)
    end
  end

  # Slug-derived tmp path (mint_slug/0 → 26 chars of [a-z2-7]); no user input.
  @sobelow_skip ["Traversal.FileModule"]
  defp write_tmp(path, bytes) do
    case File.write(path, bytes) do
      :ok -> :ok
      {:error, _posix} -> {:error, :image_reencode_failed}
    end
  end

  @sobelow_skip ["Traversal.FileModule"]
  defp read_tmp(path) do
    case File.read(path) do
      {:ok, png} -> {:ok, png}
      {:error, _posix} -> {:error, :image_reencode_failed}
    end
  end

  # Decode the first frame and re-encode as PNG. `-frames:v 1` collapses an
  # animated gif/apng/webp to a single still. A decode failure (garbage /
  # polyglot with no valid image stream) is a non-zero ffmpeg exit → error.
  defp run_ffmpeg(in_path, out_path) do
    args = [
      "-nostdin",
      "-y",
      "-loglevel",
      "error",
      "-i",
      in_path,
      "-frames:v",
      "1",
      "-f",
      "image2",
      "-c:v",
      "png",
      out_path
    ]

    case HardenedCmd.run("ffmpeg", args, @reencode_timeout_s) do
      {:ok, _output} -> :ok
      {:error, _reason} -> {:error, :image_reencode_failed}
    end
  end

  ## Re-host

  defp store(subject, png) do
    # `expires_at` omitted → NULL → the Uploads Reaper never sweeps theme
    # backgrounds. mime forced to image/png (we just produced it).
    attrs = %{subject: subject, mime: "image/png"}

    case Uploads.create(png, attrs, storage_root: Uploads.storage_root()) do
      {:ok, %Uploads.Upload{slug: slug}} ->
        {:ok, slug}

      {:error, reason} ->
        # Post-reencode store failure (fs / metadata-strip / changeset) is
        # unexpected on already-clean PNG bytes. Fail closed but LOG the real
        # reason (no-silent-swallow) — the wire result stays in the closed set.
        Logger.warning("theme background store failed", reason: inspect(reason))
        {:error, :image_reencode_failed}
    end
  end
end
