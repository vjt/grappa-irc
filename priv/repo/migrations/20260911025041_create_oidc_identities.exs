defmodule Grappa.Repo.Migrations.CreateOidcIdentities do
  use Ecto.Migration

  # #1911 — account linking for OIDC login: `(issuer, subject)` →
  # `users.id`. `subject` is the verified `sub` claim and the ONLY match
  # key (see `Grappa.Auth.Oidc.Identity`); `label` is display-only and
  # never read back by any decision. `issuer` is carried per row even
  # though one provider is configured — it is half the uniqueness key
  # and keeps a future second provider from colliding with this one's
  # subjects. Unlinking is manual in the settings page; nothing here
  # cascades anywhere else, and dropping the user drops the link.
  def change do
    create table(:oidc_identities, primary_key: false) do
      add :id, :binary_id, primary_key: true
      add :user_id, references(:users, type: :binary_id, on_delete: :delete_all), null: false
      add :issuer, :string, null: false
      add :subject, :string, null: false
      add :label, :string

      timestamps(type: :utc_datetime_usec)
    end

    # One local account per remote identity — the reverse (one account
    # holding several identities) stays legal.
    create unique_index(:oidc_identities, [:issuer, :subject])
    # The settings-page read ("which provider account is linked to me").
    create index(:oidc_identities, [:user_id])
  end
end
