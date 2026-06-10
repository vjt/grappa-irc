defmodule Grappa.Repo.Migrations.RenamePerFileCapSettingToImage do
  use Ecto.Migration

  # DML-only (no DDL) — hot-ELIGIBLE once #41's in-reload migrate
  # lands; today Deploy.Preflight Class 5 forces any new migration
  # file COLD, which is correct here: skipping this rename (forced
  # hot) silently reverts a tuned image cap to the 10MiB default.
  # Renames the single per-file cap key to the image-specific key;
  # video + document keys are born from code defaults, no rows needed.
  def up do
    execute("""
    UPDATE server_settings
    SET key = 'upload.image_per_file_cap_bytes'
    WHERE key = 'upload.per_file_cap_bytes'
      AND NOT EXISTS (
        SELECT 1 FROM server_settings WHERE key = 'upload.image_per_file_cap_bytes'
      )
    """)

    execute("DELETE FROM server_settings WHERE key = 'upload.per_file_cap_bytes'")
  end

  def down do
    execute("""
    UPDATE server_settings
    SET key = 'upload.per_file_cap_bytes'
    WHERE key = 'upload.image_per_file_cap_bytes'
    """)
  end
end
