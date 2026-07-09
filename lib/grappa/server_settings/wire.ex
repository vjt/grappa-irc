defmodule Grappa.ServerSettings.Wire do
  @moduledoc """
  Single source of truth for the public JSON wire shape of the
  `server_settings_changed` push and the matching after-join snapshot.

  UX-6-B2 (2026-05-21). Two doors emit this contract:

    * `GrappaWeb.GrappaChannel` after-join — `push_server_settings/1`
      private helper, parity with `push_bundle_hash/1`.
    * `GrappaWeb.Admin.SettingsController`'s `PUT /admin/settings` — after
      a successful update, iterates
      `Grappa.WSPresence.list_user_names/0` + broadcasts on every live
      `Topic.user(name)`. Same fanout pattern as
      `GrappaWeb.AdminController.cic_bundle_changed/2` (cluster `cic-bundle-
      changed`, CP23 S4 B5).

  ## Why per-user-topic re-broadcast (not a dedicated channel)

  Per CLAUDE.md "implement once, reuse everywhere": the
  `bundle_hash` precedent already wires server-originated state every
  operator needs to mirror through the user-topic. Reusing that
  carrier means no new channel module, no new cic-side
  `socket.channel(...).join()`, and an existing snapshot site for
  cold WS subscribe parity.

  ## Wire shape — atom passes through, codegen pins the literal union (S15)

  `Grappa.ServerSettings.public_view/0` returns the upload subtree
  with the host as an atom (`ServerSettings.upload_host/0` =
  `:embedded | :litterbox`). The Wire typespec declares
  `active_host: :embedded | :litterbox` and `upload_view/1` passes the
  atom through UNCHANGED — `Jason.encode!/1` stringifies it at the JSON
  edge (identical bytes to the former `Atom.to_string/1`), while
  `mix grappa.gen_wire_types` emits a LITERAL string union
  (`"embedded" | "litterbox"`) that cic asserts against, instead of the
  `active_host: String.t()` widening that erased the closed set from
  codegen (review S15). Same `server_reply_source` precedent as
  `Grappa.Session.Wire`. The union mirrors `ServerSettings.upload_host/0`;
  a third host (`:s3`) is one edit there + here. Adding an upload
  subtree field is one edit in `upload_view/1`; no second wire-shape
  definition to keep in sync.
  """

  use Boundary, top_level?: true, deps: []

  @typedoc """
  Wire projection of the upload subtree — atoms-out. Shared between
  the WS broadcast (`server_settings_changed/1` below) and the REST
  surfaces (`GrappaWeb.ServerSettingsController`'s `GET /api/server-settings` +
  `GrappaWeb.Admin.SettingsController`'s `GET /admin/settings`). Adding a 4th
  `upload.*` field is one edit here, not three.
  """
  @type upload_view :: %{
          active_host: :embedded | :litterbox,
          image_per_file_cap_bytes: pos_integer(),
          video_per_file_cap_bytes: pos_integer(),
          document_per_file_cap_bytes: pos_integer(),
          audio_per_file_cap_bytes: pos_integer(),
          global_cap_bytes: pos_integer()
        }

  @typedoc """
  Wire shape pushed on the user-topic when admin updates server
  settings, OR observed at after-join (snapshot push).
  """
  @type changed_payload :: %{
          kind: String.t(),
          upload: upload_view()
        }

  @doc """
  Renders the `upload` subtree of `Grappa.ServerSettings.public_view/0`
  to its public wire shape. The `:embedded | :litterbox` host atom
  passes through unchanged (Jason stringifies at the JSON edge; S15).
  Shared by every wire-emitter to keep the field set single-source.
  """
  @spec upload_view(%{
          active_host: :embedded | :litterbox,
          image_per_file_cap_bytes: pos_integer(),
          video_per_file_cap_bytes: pos_integer(),
          document_per_file_cap_bytes: pos_integer(),
          audio_per_file_cap_bytes: pos_integer(),
          global_cap_bytes: pos_integer()
        }) :: upload_view()
  def upload_view(%{} = upload) do
    %{
      active_host: upload.active_host,
      image_per_file_cap_bytes: upload.image_per_file_cap_bytes,
      video_per_file_cap_bytes: upload.video_per_file_cap_bytes,
      document_per_file_cap_bytes: upload.document_per_file_cap_bytes,
      audio_per_file_cap_bytes: upload.audio_per_file_cap_bytes,
      global_cap_bytes: upload.global_cap_bytes
    }
  end

  @doc """
  Renders a `Grappa.ServerSettings.public_view/0` map to its public
  wire shape for the `server_settings_changed` event push. Delegates
  the `upload` subtree projection to `upload_view/1`.
  """
  @spec server_settings_changed(Grappa.ServerSettings.public_view()) :: changed_payload()
  def server_settings_changed(%{upload: %{} = upload}) do
    %{
      kind: "server_settings_changed",
      upload: upload_view(upload)
    }
  end
end
