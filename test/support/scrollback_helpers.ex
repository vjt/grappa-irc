defmodule Grappa.ScrollbackHelpers do
  @moduledoc """
  Test-only helper for inserting `Grappa.Scrollback.Message` rows of
  arbitrary kinds.

  The production `Grappa.Scrollback` API exposes ONLY kind-specific
  writers (`persist_event/1`) — the moduledoc invariant is "callers
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
  use Boundary,
    top_level?: true,
    deps: [Grappa.Repo, Grappa.Scrollback]

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

  @doc """
  issue 2419 — inserts one `:privmsg` row per value in `server_times`, each
  carrying `attrs` (subject, network, channel, sender) and the body
  `"filler <server_time>"`, which names no nick a test watches for.

  `Repo.insert_all/2` in chunks: the away-bundle cap needs tens of thousands
  of rows, and a changeset round-trip each would dominate the suite. That
  bypasses `Message.changeset/2`, so `attrs` must already be what the
  changeset would store (a folded channel, a real sender).
  """
  @spec insert_filler(map(), Enumerable.t()) :: :ok
  def insert_filler(attrs, server_times) do
    now = DateTime.utc_now()

    server_times
    |> Enum.map(fn t ->
      Map.merge(attrs, %{server_time: t, kind: :privmsg, body: "filler #{t}", meta: %{}, inserted_at: now})
    end)
    |> Enum.chunk_every(2_000)
    |> Enum.each(&Repo.insert_all(Message, &1))
  end
end
