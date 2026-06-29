defmodule Grappa.Visitors.Wire do
  @moduledoc """
  Single source of truth for the public JSON wire shape of
  `Grappa.Visitors.Visitor` rows.

  ## Why this module exists (CRITICAL — read before adding fields)

  `Visitor.password_encrypted` is a `Grappa.EncryptedBinary` Cloak
  column whose `:load` callback decrypts the AES-GCM ciphertext on
  read. After `Repo.get`, the field IN MEMORY carries the **plaintext
  upstream NickServ password** captured by `Grappa.Session.Server` on
  +r MODE observation (see `Grappa.Visitors.commit_password/2`). The
  field name describes the on-disk representation, not the post-load
  value. The `redact: true` on the schema field protects `inspect/1`
  and Logger output, but NOT `Jason.encode!/1`, which walks struct
  fields directly.

  Without an explicit allowlist serializer, the first naive
  `json(conn, visitor)` leaks the upstream NickServ password to the
  client. This module is the only sanctioned door from
  `Visitors.Visitor` rows to JSON. Adding a field to the wire = one
  edit here. Removing one = a breaking change visible at this single
  site.

  Sibling Wire modules with the same redact-protection rationale:
  `Grappa.Networks.Wire` (the canonical reference for this pattern;
  Networks.Credential has the same `password_encrypted` Cloak
  column), `Grappa.Accounts.Wire` (User.password_hash + virtual
  :password defense).

  ## Pre-extraction (CP16 B2)

  `MeJSON.show(%{visitor: ...})` and `AuthJSON.login(%{subject:
  {:visitor, _}})` both inlined the wire shape — `MeJSON` included
  `:expires_at`, `AuthJSON` didn't. The drift was undocumented; this
  module makes the divergence EXPLICIT through two functions:

    * `visitor_to_json/1` — full profile shape `{id, nick,
      network_slug, expires_at}`. Used by `MeJSON` so the SPA can
      render the visitor's session-end countdown.
    * `visitor_to_credential_json/1` — minimal credential-exchange
      shape `{id, nick, network_slug}`. Used by `AuthJSON` post-login
      where the SPA already has the bearer token TTL via
      `accounts_sessions.expires_at` on a separate door.

  Same {full, credential} pair pattern as `Grappa.Accounts.Wire`.
  """

  alias Grappa.Visitors.Visitor

  @type credential_json :: %{
          id: Ecto.UUID.t(),
          nick: String.t(),
          network_slug: String.t(),
          registered: boolean()
        }

  @type t :: %{
          id: Ecto.UUID.t(),
          nick: String.t(),
          network_slug: String.t(),
          expires_at: DateTime.t() | nil,
          registered: boolean()
        }

  @doc """
  Renders a `Visitors.Visitor` row to its credential-exchange JSON
  shape — `{id, nick, network_slug, registered}`. Used by
  `AuthJSON.login/1`.

  Excludes `:password_encrypted` (the post-Cloak-load plaintext
  upstream secret) explicitly. If you're tempted to add that field,
  stop and re-read the moduledoc. `:registered` exposes only the
  PRESENCE of the secret (see `registered?/1`), never the secret.
  """
  @spec visitor_to_credential_json(Visitor.t()) :: credential_json()
  def visitor_to_credential_json(%Visitor{} = v) do
    %{
      id: v.id,
      nick: v.nick,
      network_slug: v.network_slug,
      registered: registered?(v)
    }
  end

  @doc """
  Renders a `Visitors.Visitor` row to its full profile JSON shape —
  `{id, nick, network_slug, expires_at, registered}`. Used by
  `MeJSON.show/1` for the SPA's session-end countdown.

  Excludes `:password_encrypted` explicitly (same rationale as
  `visitor_to_credential_json/1`). Excludes `:ip` (operator-audit
  field, not for the wire) + `:inserted_at` + `:updated_at` (not
  part of the documented wire contract).
  """
  @spec visitor_to_json(Visitor.t()) :: t()
  def visitor_to_json(%Visitor{} = v) do
    %{
      id: v.id,
      nick: v.nick,
      network_slug: v.network_slug,
      expires_at: v.expires_at,
      registered: registered?(v)
    }
  end

  # #126 — a "registered" visitor is a NickServ-IDENTIFIED visitor: one
  # that committed a NickServ password (`password_encrypted` non-nil ⟺
  # permanent, `expires_at == nil`). This derived boolean is the cic gate
  # for the persistent-identity verbs (detach + disconnect/reconnect);
  # ephemeral/anon visitors (`password_encrypted == nil`) get only quit.
  # Exposes the PRESENCE of the secret, never the secret — the moduledoc
  # leak-defense invariant is unchanged.
  @spec registered?(Visitor.t()) :: boolean()
  defp registered?(%Visitor{password_encrypted: nil}), do: false
  defp registered?(%Visitor{password_encrypted: _}), do: true
end
