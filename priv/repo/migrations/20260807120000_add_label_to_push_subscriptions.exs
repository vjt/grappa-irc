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

  ## Hot deploy

  COLD. `Grappa.Deploy.Preflight` classifies every `priv/repo/migrations/*`
  path as `:migration`, substrate-independent, no exceptions for additive
  nullable columns.
  """
  use Ecto.Migration

  def change do
    alter table(:push_subscriptions) do
      add :label, :string
    end
  end
end
