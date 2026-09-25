defmodule GrappaWeb.IgnoresJSON do
  @moduledoc """
  Phoenix view layer for `GrappaWeb.IgnoresController` — the `/ignore` list
  (#162, extended by issue 2294 with an optional message-text pattern).

  ## Why the rendering moved OUT of the controller (issue 2294)

  The payload used to be an inline `json(conn, %{masks: …})`. Measured while
  adding `entries` to it: a brand new field in that map left
  `mix grappa.wire_pin --check` GREEN at rc 0 (`wire shape and protocol 30
  agree.`), while the same gate on the same tree went RED with a moved digest
  for one word changed in a `GrappaWeb.*JSON` view's `@spec`. The #1393d pin
  digests the two generated artefacts plus **the `@spec`s the hand-written
  `GrappaWeb.*JSON` views export**, discovered from the build output — so a
  controller that renders inline is invisible to it, and a view is not.

  That is the whole reason this module exists. The shapes below are the
  thing the gate now reads, and the module set is derived from the beams, so
  this is fail-CLOSED: it cannot be forgotten off a list.

  ## Additive, and where the seam is

  `masks` is the #162 field and it stays EXACTLY what it was — a list of
  `nick!user@host` strings, same order as `entries`. `entries` is the new,
  richer projection of the SAME list. A client predating issue 2294 reads
  `masks` and is unaffected; one that wants the text patterns reads
  `entries`. The list was never turned into a list of objects, because
  repurposing an existing field is the one thing the wire contract forbids
  outright (CLAUDE.md, #447).

  Two entries may share a `mask` and differ in `text_pattern` — that is the
  bridged-author case the issue is about — so `masks` can legitimately carry
  the same string twice. A client keying a map on `mask` alone will collapse
  them; the key is the PAIR.
  """

  alias Grappa.IRC.Ignore
  alias Grappa.UserSettings

  @typedoc """
  One entry as the wire carries it. `text_pattern` is always PRESENT, `null`
  when the entry has none — a key the server omitted and a key meaning "no
  pattern" would be indistinguishable, and only one of those is a fact.
  """
  @type entry :: %{mask: String.t(), text_pattern: String.t() | nil}

  @typedoc "Wire shape for `GET /networks/:network_id/ignores`."
  @type index_response :: %{masks: [String.t()], entries: [entry()]}

  @typedoc """
  Wire shape for the two mutations. `mask` + `text_pattern` echo the
  NORMALISED entry the verb acted on (`/unignore spambot` reports
  `spambot!*@*`), and `outcome` says what it did.
  """
  @type mutation_response :: %{
          masks: [String.t()],
          entries: [entry()],
          mask: String.t(),
          text_pattern: String.t() | nil,
          outcome: UserSettings.ignore_outcome()
        }

  @doc "Renders `index` — the whole list, both projections."
  @spec index(%{entries: [Ignore.t()]}) :: index_response()
  def index(%{entries: entries}), do: list_payload(entries)

  @doc "Renders `create` (201) and `remove` (200) — the list plus what changed."
  @spec mutation(%{
          entries: [Ignore.t()],
          entry: Ignore.t(),
          outcome: UserSettings.ignore_outcome()
        }) :: mutation_response()
  def mutation(%{entries: entries, entry: entry, outcome: outcome}) do
    entries
    |> list_payload()
    |> Map.merge(%{mask: entry.mask, text_pattern: entry.text_pattern, outcome: outcome})
  end

  @spec list_payload([Ignore.t()]) :: index_response()
  defp list_payload(entries) do
    %{masks: Enum.map(entries, & &1.mask), entries: Enum.map(entries, &entry/1)}
  end

  @spec entry(Ignore.t()) :: entry()
  defp entry(%Ignore{mask: mask, text_pattern: text}), do: %{mask: mask, text_pattern: text}
end
