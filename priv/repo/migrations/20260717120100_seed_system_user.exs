defmodule Grappa.Repo.Migrations.SeedSystemUser do
  @moduledoc """
  #75 — seed the reserved "system" user that owns the built-in theme gallery.

  Built-in themes need an author. Rather than a nullable `owner_id` + a
  `built_in` flag (two sources of truth that can drift), built-ins are owned by
  ONE reserved user named `"system"`, and "is this a built-in?" is derived from
  `owner_id == system_user.id`. The read-only-for-non-admins property then falls
  out of the ownership authz check for free.

  The system user gets a RANDOM, unusable `password_hash` (64 hex chars from 32
  random bytes). It is not a bcrypt/argon2 verifier, so no password ever
  matches — the system user can never authenticate. It exists solely to own
  rows. `is_admin` takes its DB default (`false`).

  Idempotent: `INSERT OR IGNORE` trips the `users_name_index` unique constraint
  on re-run, so migrating twice (or after a manual create) leaves exactly one
  `system` row. `down/0` removes it.

  SQL-injection safe BY CONSTRUCTION: every interpolated value is generated
  server-side — `Ecto.UUID.generate/0` is canonical hex/dash, `Base.encode16`
  is `[0-9a-f]` only, `DateTime.to_iso8601/1` is digits/`:-.TZ` — none can
  contain a quote. The literal name is a constant. Do NOT interpolate any
  external/user input here without switching to a parameterized insert.
  """
  use Ecto.Migration

  def up do
    id = Ecto.UUID.generate()
    hash = 32 |> :crypto.strong_rand_bytes() |> Base.encode16(case: :lower)
    now = DateTime.utc_now() |> DateTime.to_iso8601()

    execute("""
    INSERT OR IGNORE INTO users (id, name, password_hash, is_admin, inserted_at, updated_at)
    VALUES ('#{id}', 'system', '#{hash}', 0, '#{now}', '#{now}')
    """)
  end

  def down do
    execute("DELETE FROM users WHERE name = 'system'")
  end
end
