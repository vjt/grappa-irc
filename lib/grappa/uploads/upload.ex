defmodule Grappa.Uploads.Upload do
  @moduledoc """
  Schema for the `uploads` table — one row per file uploaded via
  `POST /api/uploads`.

  ## Identity

  - `id` — internal UUID PK (admin REST + Reaper key).
  - `slug` — URL path component AND on-disk filename under
    `runtime/uploads/<slug>`. 26 chars of base32 (16 random bytes),
    URL-safe, 128 bits of entropy. Anyone with the slug can read
    the bytes via the unauthenticated `GET /uploads/:slug`.

  ## Subject XOR

  Exactly one of `user_id` / `visitor_id` is non-null. Mirrors
  `Grappa.Scrollback.Message` + `Grappa.UserSettings.Settings` +
  `Grappa.ReadCursor.Cursor`. Visitor reaping CASCADEs uploads.

  ## Lifecycle markers

  - `expires_at` — when the Reaper should sweep this row. NULL =
    never expires (admin-pinned uploads, not exposed in v1 but the
    column supports it).
  - `deleted_at` — soft-delete marker. Reaper unlinks the file
    FIRST, then sets `deleted_at`. A `GET /uploads/:slug` that
    races the Reaper between unlink + soft-delete sees the row
    live + ENOENT on disk and returns 404.

  ## Why `mime` + `bytes` + `original_filename` are stored

  - `mime` — served back as `Content-Type` on download.
  - `bytes` — summed for the global-cap check on POST.
  - `original_filename` — best-effort, populates
    `Content-Disposition: inline; filename="..."` if present.
    Stripped of path separators at the changeset boundary.
  """

  use Ecto.Schema
  import Ecto.Changeset

  alias Grappa.Accounts.User
  alias Grappa.Visitors.Visitor

  @type t :: %__MODULE__{
          id: Ecto.UUID.t() | nil,
          slug: String.t() | nil,
          user_id: Ecto.UUID.t() | nil,
          user: User.t() | Ecto.Association.NotLoaded.t() | nil,
          visitor_id: Ecto.UUID.t() | nil,
          visitor: Visitor.t() | Ecto.Association.NotLoaded.t() | nil,
          mime: String.t() | nil,
          bytes: non_neg_integer() | nil,
          original_filename: String.t() | nil,
          expires_at: DateTime.t() | nil,
          deleted_at: DateTime.t() | nil,
          inserted_at: DateTime.t() | nil,
          updated_at: DateTime.t() | nil
        }

  @primary_key {:id, :binary_id, autogenerate: true}
  @foreign_key_type :binary_id

  schema "uploads" do
    field :slug, :string

    belongs_to :user, User
    belongs_to :visitor, Visitor

    field :mime, :string
    field :bytes, :integer
    field :original_filename, :string

    field :expires_at, :utc_datetime_usec
    field :deleted_at, :utc_datetime_usec

    timestamps(type: :utc_datetime_usec)
  end

  @doc """
  Insert-time changeset. Subject XOR + slug + mime + bytes required.
  Soft-delete + filename-sanitization use distinct changesets.
  """
  @spec insert_changeset(t(), map()) :: Ecto.Changeset.t()
  def insert_changeset(upload, attrs) do
    upload
    |> cast(attrs, [
      :slug,
      :user_id,
      :visitor_id,
      :mime,
      :bytes,
      :original_filename,
      :expires_at
    ])
    |> validate_required([:slug, :mime, :bytes])
    |> validate_number(:bytes, greater_than: 0)
    |> sanitize_original_filename()
    |> validate_subject_xor()
    |> assoc_constraint(:user)
    |> assoc_constraint(:visitor)
    |> unique_constraint(:slug)
    |> check_constraint(:subject,
      name: :uploads_subject_xor,
      message: "user_id and visitor_id are mutually exclusive"
    )
  end

  @doc """
  Soft-delete changeset — sets `deleted_at` to the supplied
  timestamp. File unlink happens OUTSIDE Ecto (it's a side-effect
  on the host fs); the caller MUST unlink before flipping the row
  to keep the race-window short.
  """
  @spec soft_delete_changeset(t(), DateTime.t()) :: Ecto.Changeset.t()
  def soft_delete_changeset(upload, %DateTime{} = now) do
    change(upload, deleted_at: now)
  end

  # Mirrors `Grappa.ReadCursor.Cursor.validate_subject_xor/1` —
  # error attaches to the synthetic `:subject` key so the wire shape
  # matches every other XOR-FK context.
  defp validate_subject_xor(changeset) do
    user_id = get_field(changeset, :user_id)
    visitor_id = get_field(changeset, :visitor_id)

    case {user_id, visitor_id} do
      {nil, nil} -> add_error(changeset, :subject, "one of user_id or visitor_id is required")
      {_, nil} -> changeset
      {nil, _} -> changeset
      {_, _} -> add_error(changeset, :subject, "user_id and visitor_id are mutually exclusive")
    end
  end

  # Strip directory separators + leading dots from
  # `original_filename` so the value can be safely echoed into the
  # download `Content-Disposition` header without enabling path-
  # injection on credulous clients that interpret the filename.
  defp sanitize_original_filename(changeset) do
    case get_change(changeset, :original_filename) do
      nil ->
        changeset

      "" ->
        put_change(changeset, :original_filename, nil)

      raw when is_binary(raw) ->
        cleaned =
          raw
          |> String.replace(~r{[/\\]}, "_")
          |> String.trim_leading(".")
          |> String.slice(0, 255)

        if cleaned == "" do
          put_change(changeset, :original_filename, nil)
        else
          put_change(changeset, :original_filename, cleaned)
        end
    end
  end
end
