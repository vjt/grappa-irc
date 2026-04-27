defmodule Grappa.ScrollbackHelpers do
  @moduledoc """
  Test-only helper for inserting `Grappa.Scrollback.Message` rows of
  arbitrary kinds.

  The production `Grappa.Scrollback` API exposes ONLY kind-specific
  writers (`persist_privmsg/5`) — the moduledoc invariant is "callers
  never `Repo.insert/2` directly." Tests need to seed rows of every
  kind (`:join`, `:part`, `:nick_change`, etc.) to exercise
  `fetch/5` + `Scrollback.Wire`; routing those test-only inserts
  through a public `Scrollback.insert/1` widened the production
  surface to make tests easier (CLAUDE.md: "Never weaken production
  code to make tests pass").

  This module calls `Message.changeset/2 |> Repo.insert()` directly
  so the test surface lives entirely under `test/support/` and
  cannot leak into a production code path. C6 / S7.
  """
  alias Grappa.Repo
  alias Grappa.Scrollback.Message

  @doc """
  Inserts a Scrollback row from raw attrs. Same shape as the (now
  removed) `Scrollback.insert/1` returned: `{:ok, message}` or
  `{:error, changeset}`. Used only by tests that need to seed rows
  of kinds the production API doesn't yet expose.
  """
  @spec insert(map()) :: {:ok, Message.t()} | {:error, Ecto.Changeset.t()}
  def insert(attrs) do
    %Message{}
    |> Message.changeset(attrs)
    |> Repo.insert()
  end
end
