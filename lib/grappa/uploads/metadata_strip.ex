defmodule Grappa.Uploads.MetadataStrip do
  @moduledoc """
  Server-side metadata stripping for uploaded media (#39).

  ## The guarantee

  Privacy is a SERVER guarantee (vjt 2026-06-10): every image and
  video accepted by `Grappa.Uploads.create/3` has its embedded
  metadata (EXIF GPS, device Make/Model, QuickTime location atoms,
  Matroska tags) removed BEFORE the bytes touch the storage root.
  Clients never participate in the decision — cic's transcode gate
  is pure performance and explicitly does NOT consult metadata.

  Failure mode is CLOSED: if the strip fails for any reason (tool
  missing, malformed file, unmapped media type) the upload is
  rejected with `{:error, {:metadata_strip, reason}}` — never
  stored-with-leak. Documents pass through untouched (vjt scope:
  images + videos only).

  ## Tooling (verified empirically 2026-06-10)

    * `exiftool -all=` — images (jpeg/png/gif/webp/apng) and
      QuickTime video (mp4/mov). Lossless: rewrites containers
      without re-encoding (ffmpeg would re-encode jpeg = quality
      loss), removes EXIF APP1, PNG `eXIf`, `udta` `loci`/`©xyz`
      and `mdta` Keys atoms, preserves moov-before-mdat
      (faststart) ordering.
    * `ffmpeg -map_metadata -1 -map_chapters -1 -c copy` — webm
      only. exiftool cannot write Matroska ("Writing of WEBM files
      is not yet supported"); a stream-copy remux drops the tags
      without touching the encoded streams.

  Both binaries ship in the container image (Dockerfile) and the
  m42 jail (docs/OPERATIONS.md "Jail package dependencies").

  ## Shape

  The tools are file-based, so the binary takes a round-trip
  through `System.tmp_dir!()`: unique slug-derived names, fixed
  extensions from the closed mime map — no user-controlled path
  segments. `System.cmd/3` with argument lists, never shell
  interpolation.
  """

  require Logger

  # Consumed by the Sobelow analyzer, not the compiler — without the
  # registration the unused-attribute warning fails
  # `mix compile --warnings-as-errors` (same dance as
  # `GrappaWeb.UploadsController`).
  Module.register_attribute(__MODULE__, :sobelow_skip, accumulate: true, persist: true)

  @type error :: {:error, {:metadata_strip, String.t()}}

  # Closed map: allowlisted mime → tmp-file extension exiftool uses
  # for output-format detection. Stays in lockstep with
  # `GrappaWeb.UploadsController.@mime_categories` — an image/video
  # mime added there without a mapping here fails closed below.
  @exiftool_exts %{
    "image/png" => "png",
    "image/apng" => "png",
    "image/jpeg" => "jpg",
    "image/gif" => "gif",
    "image/webp" => "webp",
    "video/mp4" => "mp4",
    "video/quicktime" => "mov"
  }

  @doc """
  Whether `mime` has a strip tool mapped. Image/video mimes returning
  `false` here FAIL CLOSED in `run/2` — the lockstep test against
  `GrappaWeb.UploadsController.mime_categories/0` pins that every
  allowlisted media type stays strippable.
  """
  @spec strippable?(String.t()) :: boolean()
  def strippable?("video/webm"), do: true
  def strippable?(mime) when is_binary(mime), do: Map.has_key?(@exiftool_exts, mime)

  @doc """
  Strip embedded metadata from `bytes` according to `mime`.

  Returns `{:ok, stripped_bytes}` (byte-identical passthrough for
  non-image/video mimes) or `{:error, {:metadata_strip, reason}}` —
  the caller MUST reject the upload on error.
  """
  @spec run(binary(), String.t()) :: {:ok, binary()} | error()
  def run(bytes, mime) when is_binary(bytes) and is_binary(mime) do
    case Map.fetch(@exiftool_exts, mime) do
      {:ok, ext} -> strip_via(:exiftool, bytes, ext, mime)
      :error -> run_unmapped(bytes, mime)
    end
  end

  defp run_unmapped(bytes, "video/webm" = mime), do: strip_via(:ffmpeg, bytes, "webm", mime)

  # Fail closed: an image/video mime that reaches here was added to
  # the upload allowlist without a strip mapping. Storing the
  # original would silently leak — reject loudly instead.
  defp run_unmapped(_, "image/" <> _ = mime), do: unmapped_error(mime)
  defp run_unmapped(_, "video/" <> _ = mime), do: unmapped_error(mime)

  # Documents pass through (vjt 2026-06-10: strip scope = images +
  # videos). PDF/office metadata is a known, accepted leak class.
  defp run_unmapped(bytes, _), do: {:ok, bytes}

  defp unmapped_error(mime) do
    strip_error(mime, "no strip tool mapped for #{mime}")
  end

  # ------------------------------------------------------------------
  # Tool plumbing
  # ------------------------------------------------------------------

  # `path` components: System.tmp_dir!() + literal prefix +
  # `Uploads.mint_slug/0` (26 chars of [a-z2-7]) + fixed extension
  # from the closed map above. No user input reaches the path.
  @sobelow_skip ["Traversal.FileModule"]
  defp strip_via(tool, bytes, ext, mime) do
    base = Path.join(System.tmp_dir!(), "grappa-strip-" <> Grappa.Uploads.mint_slug())
    in_path = "#{base}-in.#{ext}"
    out_path = "#{base}-out.#{ext}"

    try do
      with :ok <- write_tmp(in_path, bytes, mime),
           :ok <- run_tool(tool, in_path, out_path, mime) do
        read_tmp(out_path, mime)
      end
    after
      _ = File.rm(in_path)
      _ = File.rm(out_path)
    end
  end

  # Same provenance as strip_via/4 — slug-derived tmp path.
  @sobelow_skip ["Traversal.FileModule"]
  defp write_tmp(path, bytes, mime) do
    case File.write(path, bytes) do
      :ok -> :ok
      {:error, posix} -> strip_error(mime, "tmp write failed: #{posix}")
    end
  end

  # Same provenance as strip_via/4 — slug-derived tmp path.
  @sobelow_skip ["Traversal.FileModule"]
  defp read_tmp(path, mime) do
    case File.read(path) do
      {:ok, stripped} -> {:ok, stripped}
      {:error, posix} -> strip_error(mime, "stripped output missing: #{posix}")
    end
  end

  # The tools parse HOSTILE user bytes and exiftool has an RCE
  # history (CVE-2021-22204) — a compromised child must not find the
  # deployment's secrets in its environment. ALLOWLIST, not denylist:
  # the child keeps only what a media tool needs, so a secret added
  # to the deployment tomorrow cannot leak by omission. `{name, nil}`
  # REMOVES the variable (vs `env: []`, which only adds nothing).
  @kept_env ~w(PATH HOME LANG LC_ALL TMPDIR)

  defp scrubbed_env do
    for {name, _} <- System.get_env(), name not in @kept_env, do: {name, nil}
  end

  # Hard wall-clock ceiling on the child: a pathological crafted file
  # that wedges ffmpeg/exiftool must not pin the request process (and
  # the OS child) forever — System.cmd/3 itself has no timeout.
  # timeout(1) ships in busybox (alpine container) AND FreeBSD base
  # (m42 jail). SIGKILL directly: the tools are stateless over our
  # tmp files, nothing graceful to preserve.
  @tool_timeout_seconds 30
  # GNU/busybox/FreeBSD timeout exit codes for an expired child:
  # 124 (TERM default) / 137 (128+9 when -s KILL delivered).
  @timeout_exit_codes [124, 137]

  defp run_tool(tool, in_path, out_path, mime) do
    exe_name = exe_name(tool)

    with {:ok, timeout_exe} <- find_exe("timeout", "part of busybox / FreeBSD base", mime),
         {:ok, _} <- find_exe(exe_name, install_hint(tool), mime) do
      argv =
        ["-s", "KILL", Integer.to_string(@tool_timeout_seconds), exe_name] ++
          args(tool, in_path, out_path)

      case System.cmd(timeout_exe, argv, env: scrubbed_env(), stderr_to_stdout: true) do
        {_, 0} ->
          :ok

        {_, code} when code in @timeout_exit_codes ->
          strip_error(mime, "#{exe_name} timed out after #{@tool_timeout_seconds}s")

        {output, code} ->
          strip_error(mime, "#{exe_name} exit #{code}: #{String.trim(output)}")
      end
    end
  end

  defp find_exe(name, hint, mime) do
    case System.find_executable(name) do
      nil -> strip_error(mime, "#{name} not found on PATH — #{hint}")
      exe -> {:ok, exe}
    end
  end

  defp exe_name(:exiftool), do: "exiftool"
  defp exe_name(:ffmpeg), do: "ffmpeg"

  defp install_hint(:exiftool), do: "apk add exiftool / pkg install p5-Image-ExifTool"
  defp install_hint(:ffmpeg), do: "apk add ffmpeg / pkg install ffmpeg"

  # `-o` writes a fresh output file (never exists — slug-unique name)
  # so a failed run can't leave a half-written in-place original.
  defp args(:exiftool, in_path, out_path), do: ["-q", "-all=", "-o", out_path, in_path]

  defp args(:ffmpeg, in_path, out_path) do
    [
      "-nostdin",
      "-loglevel",
      "error",
      "-i",
      in_path,
      "-map_metadata",
      "-1",
      "-map_chapters",
      "-1",
      "-c",
      "copy",
      "-f",
      "webm",
      out_path
    ]
  end

  # Single error funnel: the operator MUST see every rejected upload
  # (no-silent-swallow) — the wire response is a bare
  # `metadata_strip_failed` token, so the reason only exists here.
  defp strip_error(mime, reason) do
    Logger.warning("metadata strip failed for #{mime}: #{reason}")
    {:error, {:metadata_strip, reason}}
  end
end
