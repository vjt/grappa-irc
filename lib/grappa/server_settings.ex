defmodule Grappa.ServerSettings do
  @moduledoc """
  Admin-managed server-wide configuration — UX-6 bucket B1 (2026-05-20).

  ## Public surface

  Typed accessors per setting. Each `get_*` returns the typed value
  (or a sane default if not set); each `put_*` validates + upserts
  the row. Adding a new setting = add a (`get`, `put`) pair here +
  document the key in the registry below.

  ## Registry of known keys

  | Key                                     | Type                       | Default          | Owner |
  |-----------------------------------------|----------------------------|------------------|-------|
  | `"upload.active_host"`                  | `:embedded \\| :litterbox` | `:embedded`      | UX-6-B |
  | `"upload.image_per_file_cap_bytes"`     | `pos_integer()`            | 10_485_760 (10MB)| UX-6-B |
  | `"upload.video_per_file_cap_bytes"`     | `pos_integer()`            | 52_428_800 (50MB)| UX-6-B |
  | `"upload.document_per_file_cap_bytes"`  | `pos_integer()`            | 10_485_760 (10MB)| UX-6-B |
  | `"upload.audio_per_file_cap_bytes"`     | `pos_integer()`            | 26_214_400 (25MB)| audio-uploads |
  | `"upload.global_cap_bytes"`             | `pos_integer()`            | 10_737_418_240 (10GB) | UX-6-B |

  ## Public-subset shape (`public_view/0`)

  Returns the operator-visible subset for `GET /api/server-settings`:
  the upload block (active_host + the per-category per-file caps +
  global_cap_bytes) plus `http_host_aliases` — the deployment's HTTP
  host aliases (#324, from `Grappa.HttpHosts`, config-derived not
  DB-backed) that cic's media-link classifier admits. Admin-only
  settings (when added) stay out of this view.

  ## PubSub broadcast on change

  `put_*/1` broadcasts a `kind: "server_settings_changed"` event on
  `Grappa.PubSub.Topic.server_settings/0` via
  `Grappa.PubSub.broadcast_event/2` — same single-source-of-truth path
  every other context uses. Retained as an in-process signal for tests
  + any future internal subscriber. The cic fan-out path lives at
  `GrappaWeb.Admin.SettingsController`'s `PUT /admin/settings` (mirrors
  `GrappaWeb.AdminController.cic_bundle_changed/2`'s per-user-topic broadcast
  via `WSPresence.list_user_names/0`); subscribers on this topic
  receive `%Phoenix.Socket.Broadcast{event: "event", payload: ...}`
  with the typed wire payload from `ServerSettings.Wire.server_settings_changed/1`.

  ## Why direct Repo reads vs cache

  Settings reads are infrequent (cic boots once per session and on
  WS-pushed change; admin reads on AdminPane mount). A single sqlite
  point-read is sub-millisecond. Caching adds an invalidation path
  for marginal latency gain. KISS — no cache in v1.

  ## Boundary

  Deps: `Grappa.PubSub`, `Grappa.Repo`, `Grappa.HttpHosts`.
  `public_view/0` ASSEMBLES the cic-facing view from two sources: the
  DB-backed `upload` knobs (Repo) and the deployment-global HTTP host
  aliases (`Grappa.HttpHosts`, #324) — the latter is config, not DB
  state, so it is derived at read time, never persisted here.
  """

  use Boundary,
    top_level?: true,
    deps: [Grappa.Repo, Grappa.PubSub, Grappa.ServerSettings.Wire, Grappa.HttpHosts]

  alias Grappa.PubSub, as: GrappaPubSub
  alias Grappa.PubSub.Topic
  alias Grappa.Repo
  alias Grappa.ServerSettings.{Setting, Wire}

  # Setting keys
  @key_upload_active_host "upload.active_host"
  @key_upload_image_per_file_cap_bytes "upload.image_per_file_cap_bytes"
  @key_upload_video_per_file_cap_bytes "upload.video_per_file_cap_bytes"
  @key_upload_document_per_file_cap_bytes "upload.document_per_file_cap_bytes"
  @key_upload_audio_per_file_cap_bytes "upload.audio_per_file_cap_bytes"
  @key_upload_global_cap_bytes "upload.global_cap_bytes"

  # Defaults
  @default_upload_active_host :embedded
  @default_upload_image_per_file_cap_bytes 10 * 1024 * 1024
  @default_upload_video_per_file_cap_bytes 50 * 1024 * 1024
  @default_upload_document_per_file_cap_bytes 10 * 1024 * 1024
  # Audio sits between image (10MiB) and video (50MiB): lossless flac/wav
  # are large, but a single shared clip is not a movie. Born from this
  # code default — like video + document, NO seed-row migration (see
  # 20260609204800_rename_per_file_cap_setting_to_image.exs).
  @default_upload_audio_per_file_cap_bytes 25 * 1024 * 1024
  @default_upload_global_cap_bytes 10 * 1024 * 1024 * 1024

  @type upload_host :: :embedded | :litterbox

  @typedoc "Closed set of upload categories — one per-file cap each."
  @type upload_category :: :image | :video | :document | :audio
  @upload_categories [:image, :video, :document, :audio]

  @type public_view :: %{
          upload: %{
            active_host: upload_host(),
            image_per_file_cap_bytes: pos_integer(),
            video_per_file_cap_bytes: pos_integer(),
            document_per_file_cap_bytes: pos_integer(),
            audio_per_file_cap_bytes: pos_integer(),
            global_cap_bytes: pos_integer()
          },
          http_host_aliases: [String.t()]
        }

  @doc "PubSub topic name for settings changes."
  @spec topic() :: String.t()
  def topic, do: Topic.server_settings()

  # ---- upload.active_host ------------------------------------------

  @doc "Returns the configured upload host (`:embedded` default)."
  @spec get_upload_active_host() :: upload_host()
  def get_upload_active_host do
    case get_raw(@key_upload_active_host) do
      "embedded" -> :embedded
      "litterbox" -> :litterbox
      _ -> @default_upload_active_host
    end
  end

  @doc "Pins the upload host. Validates the value at the boundary."
  @spec put_upload_active_host(upload_host()) :: :ok | {:error, :invalid_value}
  def put_upload_active_host(host) when host in [:embedded, :litterbox] do
    put_raw(@key_upload_active_host, Atom.to_string(host))
  end

  def put_upload_active_host(_), do: {:error, :invalid_value}

  # ---- upload.{image,video,document}_per_file_cap_bytes ------------

  @doc "Returns the per-file upload byte cap for `category`."
  @spec get_upload_per_file_cap_bytes(upload_category()) :: pos_integer()
  def get_upload_per_file_cap_bytes(:image),
    do: read_cap(@key_upload_image_per_file_cap_bytes, @default_upload_image_per_file_cap_bytes)

  def get_upload_per_file_cap_bytes(:video),
    do: read_cap(@key_upload_video_per_file_cap_bytes, @default_upload_video_per_file_cap_bytes)

  def get_upload_per_file_cap_bytes(:document),
    do:
      read_cap(
        @key_upload_document_per_file_cap_bytes,
        @default_upload_document_per_file_cap_bytes
      )

  def get_upload_per_file_cap_bytes(:audio),
    do: read_cap(@key_upload_audio_per_file_cap_bytes, @default_upload_audio_per_file_cap_bytes)

  @doc "Pins the per-file upload byte cap for `category`. Positive integer only."
  @spec put_upload_per_file_cap_bytes(upload_category(), pos_integer()) ::
          :ok | {:error, :invalid_value}
  def put_upload_per_file_cap_bytes(category, n)
      when category in @upload_categories and is_integer(n) and n > 0 do
    put_raw(cap_key_for(category), Integer.to_string(n))
  end

  def put_upload_per_file_cap_bytes(_, _), do: {:error, :invalid_value}

  defp cap_key_for(:image), do: @key_upload_image_per_file_cap_bytes
  defp cap_key_for(:video), do: @key_upload_video_per_file_cap_bytes
  defp cap_key_for(:document), do: @key_upload_document_per_file_cap_bytes
  defp cap_key_for(:audio), do: @key_upload_audio_per_file_cap_bytes

  defp read_cap(key, default) do
    case decode_pos_int(get_raw(key)) do
      {:ok, n} -> n
      :error -> default
    end
  end

  # ---- upload.global_cap_bytes -------------------------------------

  @doc "Returns the global disk-budget byte ceiling (default 10 GiB)."
  @spec get_upload_global_cap_bytes() :: pos_integer()
  def get_upload_global_cap_bytes do
    case decode_pos_int(get_raw(@key_upload_global_cap_bytes)) do
      {:ok, n} -> n
      :error -> @default_upload_global_cap_bytes
    end
  end

  @doc "Pins the global disk-budget byte ceiling. Must be a positive integer."
  @spec put_upload_global_cap_bytes(pos_integer()) :: :ok | {:error, :invalid_value}
  def put_upload_global_cap_bytes(n) when is_integer(n) and n > 0 do
    put_raw(@key_upload_global_cap_bytes, Integer.to_string(n))
  end

  def put_upload_global_cap_bytes(_), do: {:error, :invalid_value}

  # ---- Public projection -------------------------------------------

  @doc "Returns the operator-visible subset for cic + admin REST surfaces."
  @spec public_view() :: public_view()
  def public_view do
    %{
      upload: %{
        active_host: get_upload_active_host(),
        image_per_file_cap_bytes: get_upload_per_file_cap_bytes(:image),
        video_per_file_cap_bytes: get_upload_per_file_cap_bytes(:video),
        document_per_file_cap_bytes: get_upload_per_file_cap_bytes(:document),
        audio_per_file_cap_bytes: get_upload_per_file_cap_bytes(:audio),
        global_cap_bytes: get_upload_global_cap_bytes()
      },
      # #324 — deployment HTTP host aliases (config, not DB): boot-derived
      # in config/runtime.exs, stashed via Grappa.HttpHosts. cic's media-
      # link classifier admits an upload link on ANY alias.
      http_host_aliases: Grappa.HttpHosts.aliases()
    }
  end

  # ---- Internal ----------------------------------------------------

  defp get_raw(key) do
    case Repo.get_by(Setting, key: key) do
      nil -> nil
      %Setting{value: v} -> v
    end
  end

  defp put_raw(key, value) when is_binary(value) do
    attrs = %{key: key, value: value}

    result =
      case Repo.get_by(Setting, key: key) do
        nil -> %Setting{} |> Setting.changeset(attrs) |> Repo.insert()
        %Setting{} = existing -> existing |> Setting.changeset(attrs) |> Repo.update()
      end

    case result do
      {:ok, _} ->
        :ok = broadcast_changed()
        :ok

      {:error, %Ecto.Changeset{}} ->
        # Validation/uniqueness collision — shouldn't happen given
        # the get-or-insert above; surface as a generic invalid_value
        # rather than leaking changeset internals to callers.
        {:error, :invalid_value}
    end
  end

  defp broadcast_changed do
    # broadcast_event/2 is the documented single source of truth
    # (CLAUDE.md PubSub invariant). Routes through Phoenix's channel-
    # server dispatcher with the typed `kind: "server_settings_changed"`
    # wire payload — same fastlane-aware fan-out every other context
    # uses, and the topic now appears in Topic.parse/1's enumeration so
    # the public PubSub grammar is single-sourced.
    GrappaPubSub.broadcast_event(
      Topic.server_settings(),
      Wire.server_settings_changed(public_view())
    )
  end

  defp decode_pos_int(nil), do: :error

  defp decode_pos_int(s) when is_binary(s) do
    case Integer.parse(s) do
      {n, ""} when n > 0 -> {:ok, n}
      _ -> :error
    end
  end
end
