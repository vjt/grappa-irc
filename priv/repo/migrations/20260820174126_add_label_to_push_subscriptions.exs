defmodule Grappa.Repo.Migrations.AddLabelToPushSubscriptions do
  @moduledoc """
  #964 — the one thing about a device only its owner knows: what to call it.

  `user_agent` collapses to `Browser on OS` in the settings drawer, so two
  instances of the same browser on the same OS render byte-identical rows.
  Every other disambiguator we can synthesise (the activity instant, an
  ordinal suffix, the PTR of the peer address) is derived from data the
  server already holds; the label is the only one that is genuinely NEW
  information, so it is the only one that earns a column.

  Nullable with no default: NULL means "no label", and the row falls back
  to the derived `Browser on OS [#n]` default. A `""` never reaches storage
  — `Subscription.label_changeset/2` folds blank to NULL so "cleared" has
  exactly one representation.

  Deliberately NOT stored: the ordinal. It is a function of how many
  subscriptions currently share a parsed name, so a stored copy goes stale
  the moment one of them is deleted — a lone `#2` with no `#1`.

  ## Hot deploy — HOT, and measured rather than assumed

  An earlier draft of this file asserted COLD "because `Preflight`
  classifies every `priv/repo/migrations/*` path as `:migration`". That
  stopped being true with GH #41: `GrappaWeb.AdminController.reload/2` now
  runs `Ecto.Migrator` in-process BEFORE the module reload, so only a
  CONTRACT migration still forces a restart, and `classify_migration/1`
  decides which is which from the `change/0` AST. `add :label, :string` on
  an existing table is an expand — nullable, literal type, no
  `@disable_ddl_transaction` — so it reads `:hot`, and the whole changed
  path set of #964 classifies `{:hot, []}` on `:jail`, `:docker` and
  `:linux` alike.

  This says nothing about the RELEASE bump that ships it: a `VERSION`
  change is its own cold trigger (`:version`, #1287) on the two substrates
  that boot a `mix release`, and it is not part of this diff.
  """
  use Ecto.Migration

  def change do
    alter table(:push_subscriptions) do
      add :label, :string
    end
  end
end
