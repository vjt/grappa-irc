defmodule Grappa.Repo.Migrations.AddIdentToCredentialsAndIdentRealnameToVisitors do
  @moduledoc """
  GH #152 — make `ident` (and, for visitors, `realname`) user-settable,
  decoupled from `nick`/`userid`.

  ## What this adds

    * `network_credentials.ident :: string | null` — the per-(user,
      network) IRC ident (the `user` slot of `nick!user@host`). Nullable;
      `Grappa.Networks.Credential.effective_ident/1` falls back to the
      nick when unset, mirroring `effective_realname/1`. Users already
      have `realname` (added in the original `create_networks` migration),
      so ident is the only net-new user field.
    * `visitors.ident :: string | null` — same ident for visitor rows.
      Falls back to nick when unset (matches upstream behaviour today).
    * `visitors.realname :: string | null` — visitors previously
      hardcoded `"Grappa Visitor"` in `Grappa.Visitors.SessionPlan`; the
      column lets a visitor set it via login-Advanced / settings. Unset
      keeps the `"Grappa Visitor"` anon-branding default (vjt ruling E).

  ## Free-form attributes, NOT keys

  Per the #152 design note, ident is explicitly NON-unique — multiple
  users may share one ident. No unique index, no rfc1459/casemap fold,
  no conflict target. Same for the visitor realname. These are shape-
  validated free-form attrs (see `Grappa.IRC.Identifier.valid_ident?/1`
  + `sanitize_ident/1`), exactly like the existing `realname`/`sasl_user`
  columns on `network_credentials`.

  ## Cold deploy

  New columns — the hot deploy path skips `ecto.migrate`, so this MUST
  ship on a COLD deploy or the first query against the new schema field
  500s. Existing rows read `ident = NULL` / `realname = NULL` and inherit
  the effective-value fallbacks with no behaviour change.
  """
  use Ecto.Migration

  def change do
    alter table(:network_credentials) do
      add :ident, :string, null: true
    end

    alter table(:visitors) do
      add :ident, :string, null: true
      add :realname, :string, null: true
    end
  end
end
