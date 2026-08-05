defmodule Grappa.Repo.Migrations.AddOldNickToSessionLogEvents do
  @moduledoc """
  #618 — the `:nick_changed` session-lifecycle event's one extra column.

  `nick` already records who the session answers to; without the nick it
  moved FROM, an operator has to eyeball the surrounding rows to learn
  whether a session is still on the nick it connected under, and cannot
  query for it at all. Nullable and event-specific, exactly like
  `reason`/`clean`/`duration_ms` (disconnect) and `delay_ms`/`attempt`
  (backoff) — the schema's stated posture is typed columns, not a blob.

  ## Hot deploy

  Additive nullable column on an existing table, and the feature adds no
  supervised child and no Logger metadata allowlist entry (`:old_nick` was
  already allowlisted for #373). HOT.
  """
  use Ecto.Migration

  def change do
    alter table(:session_log_events) do
      add :old_nick, :string
    end
  end
end
