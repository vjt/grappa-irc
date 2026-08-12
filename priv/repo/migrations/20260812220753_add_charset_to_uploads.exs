defmodule Grappa.Repo.Migrations.AddCharsetToUploads do
  use Ecto.Migration

  # #1256 — the encoding the UPLOADER declared, stored beside the MIME so
  # `GET /uploads/:slug` can re-emit it instead of leaving the browser to
  # guess (and paint UTF-8 text as windows-1252 mojibake).
  #
  # Nullable, no backfill, no default: NULL means unlabelled, which is
  # exactly what every existing row is — we know what those clients
  # declared, and it was nothing. Guessing UTF-8 for them would break the
  # mirror-image case, a genuinely Latin-1 .txt that renders correctly
  # today precisely because nothing is declared.
  #
  # The column is not free-text: `Grappa.Uploads.Upload` maps it through an
  # `Ecto.Enum` fed by `Grappa.Uploads.ContentType`, so the only values
  # that can land here are ones the header builder can spell canonically.
  def change do
    alter table(:uploads) do
      add :charset, :string, null: true
    end
  end
end
