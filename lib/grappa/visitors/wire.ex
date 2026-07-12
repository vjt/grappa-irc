defmodule Grappa.Visitors.Wire do
  @moduledoc """
  Single source of truth for the public JSON wire shape of
  `Grappa.Visitors.Visitor` rows.

  ## #211 phase 7 — the visitor row is a pure identity/TTL row

  A visitor is MULTI-network now, and its per-network identity
  (nick/ident/realname/password) lives on the `network_credentials` rows,
  NOT on the visitor row. So the visitor SUBJECT wire carries only the
  identity-wide fields the row still owns: `{id, expires_at, registered}`.
  Per-network nick + connection state live on the `GET /networks` rows
  (`Grappa.Networks.Wire.visitor_network_to_json/3`); cic resolves "my nick
  on network X" from there (`ownNickForNetwork`), never from the subject.

  `registered` is DERIVED from the credentials (≥1 credential holding a
  committed NickServ secret), NOT a stored `visitors.expires_at`-nil flag
  (which would drift the moment a credential is unbound). Because the
  derivation needs a DB read, the caller passes the boolean in — the two
  renderers take `(visitor, registered)` rather than computing it from the
  struct. Identifying on any network makes the identity registered;
  unbinding the last registered credential makes it anon again,
  automatically. This exposes only the FACT of registration, never any
  secret.

  This module is the only sanctioned door from `Visitors.Visitor` rows to
  JSON. Adding a field = one edit here.

  ## Two shapes (pre-extraction CP16 B2)

    * `visitor_to_json/2` — full profile `{id, expires_at, registered}`.
      Used by `MeJSON` so the SPA can render the session-end countdown.
    * `visitor_to_credential_json/2` — minimal `{id, registered}`. Used by
      `AuthJSON` post-login where the SPA already has the bearer token TTL
      via `accounts_sessions.expires_at` on a separate door.

  Same {full, credential} pair pattern as `Grappa.Accounts.Wire`.
  """

  alias Grappa.Visitors.Visitor

  @type credential_json :: %{
          id: Ecto.UUID.t(),
          registered: boolean()
        }

  @type t :: %{
          id: Ecto.UUID.t(),
          expires_at: DateTime.t() | nil,
          registered: boolean()
        }

  @doc """
  Renders a `Visitors.Visitor` row to its credential-exchange JSON
  shape — `{id, registered}`. Used by `AuthJSON.login/1`. `registered` is
  the DERIVED permanence flag (see moduledoc) — the caller resolves it via
  `Grappa.Networks.Credentials.visitor_registered?/1` and passes it in.
  """
  @spec visitor_to_credential_json(Visitor.t(), boolean()) :: credential_json()
  def visitor_to_credential_json(%Visitor{} = v, registered) when is_boolean(registered) do
    %{
      id: v.id,
      registered: registered
    }
  end

  @doc """
  Renders a `Visitors.Visitor` row to its full profile JSON shape —
  `{id, expires_at, registered}`. Used by `MeJSON.show/1` for the SPA's
  session-end countdown. `registered` is the DERIVED permanence flag (see
  moduledoc), passed in by the caller.
  """
  @spec visitor_to_json(Visitor.t(), boolean()) :: t()
  def visitor_to_json(%Visitor{} = v, registered) when is_boolean(registered) do
    %{
      id: v.id,
      expires_at: v.expires_at,
      registered: registered
    }
  end
end
