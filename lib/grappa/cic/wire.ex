defmodule Grappa.Cic.Wire do
  @moduledoc """
  Single source of truth for the public JSON wire shape of the cic
  bundle-refresh push.

  Two doors emit this contract:

    * `GrappaWeb.GrappaChannel` — after-join snapshot push of the
      current bundle hash so cic can compare against the hash baked
      into the page it loaded (CP23 S4 B4); see the
      `push_bundle_hash/1` private helper there.
    * `GrappaWeb.AdminController.cic_bundle_changed/2` — re-read
      after a `scripts/deploy-cic.sh` build, broadcast to every
      live user-topic so the refresh banner pops on every connected
      client (CP23 S4 B5).

  Pre-bucket-D both sites built `%{kind: "bundle_hash", hash: hash}`
  inline. CLAUDE.md "Wire conversion is per-context responsibility"
  + "implement once, reuse everywhere" → both sites now delegate
  here. Adding a field to the cic-bundle wire (e.g. build timestamp,
  asset digests) is one edit in `bundle_hash/2` instead of two.

  #292 added the `version` field — the human-readable semver of the
  deployed bundle (from `Grappa.Cic.Bundle.current_version/0`). It is
  OPTIONAL: a `nil` version (bundle predates the meta tag / parse miss)
  omits the key entirely rather than shipping `null`, so cic's narrower
  simply sees an absent field and falls back to the build-hash display.

  Sibling Wire modules (`Grappa.Scrollback.Wire`, `Grappa.Networks.Wire`,
  `Grappa.Accounts.Wire`, `Grappa.QueryWindows.Wire`,
  `Grappa.Session.Wire`, `Grappa.Visitors.Wire`) close the same gap
  for their respective contexts.
  """

  use Boundary, top_level?: true, deps: []

  @typedoc """
  Wire shape pushed on the user-topic when the cic bundle hash
  changes (deploy-cic broadcast) OR is observed at after-join
  (snapshot push). `version` is present only when the deployed bundle
  advertises a semver.
  """
  @type bundle_hash_payload :: %{
          required(:kind) => :bundle_hash,
          required(:hash) => String.t(),
          optional(:version) => String.t()
        }

  @doc """
  Renders the cic bundle hash + semver to its public wire shape. Caller
  is responsible for the `nil`-hash short-circuit (no bundle on disk →
  no broadcast); this fn requires a binary hash to keep the wire
  contract unambiguous. A `nil`/empty version omits the `version` key.
  """
  @spec bundle_hash(String.t(), String.t() | nil) :: bundle_hash_payload()
  def bundle_hash(hash, version) when is_binary(hash) do
    base = %{kind: :bundle_hash, hash: hash}

    case version do
      v when is_binary(v) and v != "" -> Map.put(base, :version, v)
      _ -> base
    end
  end
end
