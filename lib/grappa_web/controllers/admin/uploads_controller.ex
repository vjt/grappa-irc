defmodule GrappaWeb.Admin.UploadsController do
  @moduledoc """
  Admin verbs over the uploads registry. Behind `:admin_authn` —
  visitor + non-admin user collapse to 403 upstream.

  ## GET /admin/uploads

  Returns the full upload list — descending by insert time, INCLUDES
  soft-deleted rows so admins see the audit trail. Wire shape:

      %{
        uploads: [
          %{
            id, slug, mime, bytes, original_filename,
            subject_kind: "user" | "visitor", subject_id,
            expires_at, deleted_at, inserted_at
          },
          ...
        ],
        live_bytes_sum: non_neg_integer(),
        global_cap_bytes: pos_integer()
      }

  `live_bytes_sum + global_cap_bytes` give the admin the
  disk-budget at a glance.

  ## DELETE /admin/uploads/:id

  Synchronous: unlinks the on-disk file FIRST (same ordering as
  `Grappa.Uploads.Reaper.sweep/2`), then soft-deletes the row. 204
  on success; 404 on unknown id.
  """

  use GrappaWeb, :controller

  alias Grappa.{ServerSettings, Uploads}

  # `@sobelow_skip` is consumed by the Sobelow analyzer, not by the
  # Elixir compiler. Register it to suppress "module attribute set
  # but never used" warnings under `--warnings-as-errors`.
  Module.register_attribute(__MODULE__, :sobelow_skip, accumulate: true, persist: true)

  @doc false
  @spec index(Plug.Conn.t(), map()) :: Plug.Conn.t()
  def index(conn, _) do
    uploads = Enum.map(Uploads.list_all(), &row_to_json/1)

    json(conn, %{
      uploads: uploads,
      live_bytes_sum: Uploads.live_bytes_sum(),
      global_cap_bytes: ServerSettings.get_upload_global_cap_bytes()
    })
  end

  # `path` comes from `Uploads.storage_path/2` which validates the
  # row's slug against `^[a-z2-7]{26}$` — no traversal reachable.
  @sobelow_skip ["Traversal.FileModule"]
  @doc false
  @spec delete(Plug.Conn.t(), map()) :: Plug.Conn.t() | {:error, :not_found}
  def delete(conn, %{"id" => id}) when is_binary(id) do
    with {:ok, row} <- Uploads.get_by_id(id) do
      path = Uploads.storage_path(Uploads.storage_root(), row.slug)
      _ = File.rm(path)
      {:ok, _} = Uploads.soft_delete(row, DateTime.utc_now())
      send_resp(conn, :no_content, "")
    end
  end

  # ---- Internal ----------------------------------------------------

  defp row_to_json(%Grappa.Uploads.Upload{} = u) do
    %{
      id: u.id,
      slug: u.slug,
      mime: u.mime,
      bytes: u.bytes,
      original_filename: u.original_filename,
      subject_kind: subject_kind(u),
      subject_id: subject_id(u),
      expires_at: maybe_iso(u.expires_at),
      deleted_at: maybe_iso(u.deleted_at),
      inserted_at: maybe_iso(u.inserted_at)
    }
  end

  defp subject_kind(%{user_id: id}) when is_binary(id), do: "user"
  defp subject_kind(%{visitor_id: id}) when is_binary(id), do: "visitor"

  defp subject_id(%{user_id: id}) when is_binary(id), do: id
  defp subject_id(%{visitor_id: id}) when is_binary(id), do: id

  defp maybe_iso(nil), do: nil
  defp maybe_iso(%DateTime{} = dt), do: DateTime.to_iso8601(dt)
end
