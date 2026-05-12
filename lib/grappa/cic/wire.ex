defmodule Grappa.Cic.Wire do
  @moduledoc """
  Single source of truth for the public JSON wire shape of the cic
  bundle-refresh push.

  Two doors emit this contract:

    * `GrappaWeb.GrappaChannel.push_bundle_hash/1` — after-join
      snapshot push of the current bundle hash so cic can compare
      against the hash baked into the page it loaded (CP23 S4 B4).
    * `GrappaWeb.AdminController.cic_bundle_changed/2` — re-read
      after a `scripts/deploy-cic.sh` build, broadcast to every
      live user-topic so the refresh banner pops on every connected
      client (CP23 S4 B5).

  Pre-bucket-D both sites built `%{kind: "bundle_hash", hash: hash}`
  inline. CLAUDE.md "Wire conversion is per-context responsibility"
  + "implement once, reuse everywhere" → both sites now delegate
  here. Adding a field to the cic-bundle wire (e.g. build timestamp,
  asset digests) is one edit in `bundle_hash/1` instead of two.

  Sibling Wire modules (`Grappa.Scrollback.Wire`, `Grappa.Networks.Wire`,
  `Grappa.Accounts.Wire`, `Grappa.QueryWindows.Wire`,
  `Grappa.Session.Wire`, `Grappa.Visitors.Wire`) close the same gap
  for their respective contexts.
  """

  use Boundary, top_level?: true, deps: []

  @typedoc """
  Wire shape pushed on the user-topic when the cic bundle hash
  changes (deploy-cic broadcast) OR is observed at after-join
  (snapshot push).
  """
  @type bundle_hash_payload :: %{kind: String.t(), hash: String.t()}

  @doc """
  Renders the cic bundle hash to its public wire shape. Caller is
  responsible for the `nil` short-circuit (no bundle on disk → no
  broadcast); this fn requires a binary to keep the wire contract
  unambiguous.
  """
  @spec bundle_hash(String.t()) :: bundle_hash_payload()
  def bundle_hash(hash) when is_binary(hash) do
    %{kind: "bundle_hash", hash: hash}
  end
end
