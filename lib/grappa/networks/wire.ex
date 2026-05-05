defmodule Grappa.Networks.Wire do
  @moduledoc """
  Single source of truth for the public JSON wire shape of
  `Grappa.Networks.Credential` and `Grappa.Networks.Network` rows.

  ## Why this module exists (CRITICAL — read before adding fields)

  `Credential.password_encrypted` is a `Grappa.EncryptedBinary` Cloak
  column whose `:load` callback decrypts the AES-GCM ciphertext on
  read. After `Repo.one!`, the field IN MEMORY carries the **plaintext
  upstream IRC password** — the field name describes the on-disk
  representation, not the post-load value. The `redact: true` on the
  schema field protects `inspect/1` and Logger output, but NOT
  `Jason.encode!/1`, which walks struct fields directly.

  Without an explicit allowlist serializer, the first naive Phase 3
  controller that does `json(conn, credential)` leaks the upstream
  NickServ password to the world. This module is the only sanctioned
  door from `Networks.Credential` / `Networks.Network` rows to JSON.
  Adding a field to the wire = one edit here. Removing one = a
  breaking change visible at this single site.

  See `Grappa.Scrollback.Wire` for the analogous shape on the
  scrollback side; the two share the convention of crashing loudly
  when a required association isn't preloaded.
  """

  alias Grappa.Networks.{Credential, Network}

  @type credential_json :: %{
          network: String.t(),
          nick: String.t(),
          realname: String.t() | nil,
          sasl_user: String.t() | nil,
          auth_method: Credential.auth_method(),
          auth_command_template: String.t() | nil,
          autojoin_channels: [String.t()],
          connection_state: Credential.connection_state(),
          connection_state_reason: String.t() | nil,
          connection_state_changed_at: DateTime.t() | nil,
          inserted_at: DateTime.t(),
          updated_at: DateTime.t()
        }

  @type network_json :: %{
          id: integer(),
          slug: String.t(),
          inserted_at: DateTime.t(),
          updated_at: DateTime.t()
        }

  @typedoc """
  Wire shape for `GET /networks` when the caller has a `Credential` row —
  extends `network_json` with `:nick` (the per-network configured IRC nick).

  Cicchetto uses `:nick` to identify the own-nick topic (`channel:<nick>`)
  for DM subscription and for the own-nick skip in the query-windows loop.
  Without per-network nick in the wire, cicchetto falls back to `user.name`,
  which coincides with query-window targetNick when the operator's account
  name matches a conversation partner's IRC nick — causing the DM handler
  to subscribe to the wrong topic and re-key messages incorrectly.
  """
  @type network_with_nick_json :: %{
          id: integer(),
          slug: String.t(),
          nick: String.t(),
          inserted_at: DateTime.t(),
          updated_at: DateTime.t()
        }

  @typedoc """
  Per-channel wire shape returned by `GET /networks/:net/channels`. Object
  envelope (not a bare string) per architecture review A5 close: every
  channel entry advertises both `:joined` (currently-in-session) and
  `:source` (`:autojoin` if declared in the credential's autojoin list,
  `:joined` if dynamically joined via REST/IRC after boot). When a
  channel is in BOTH sources, `:autojoin` wins (operator intent durable).

  Q3 of P4-1 cluster pinned the merge order; P4-1 is the cluster that
  landed it.
  """
  @type channel_json :: %{
          name: String.t(),
          joined: boolean(),
          source: :autojoin | :joined
        }

  @doc """
  Renders a `Networks.Credential` row to its public JSON shape. The
  `:network` association MUST be preloaded — pattern match fails
  loudly otherwise (same convention as `Scrollback.Wire.to_json/1`).

  Excludes `:password_encrypted` (the post-Cloak-load plaintext
  upstream secret) and the virtual `:password` field — both must
  NEVER appear on the wire. If you're tempted to add either, stop
  and re-read the moduledoc.

  Includes T32 connection-state fields (`connection_state`,
  `connection_state_reason`, `connection_state_changed_at`) so the
  REST surface for `PATCH /networks/:id` can return the updated
  credential state without a separate endpoint.
  """
  @spec credential_to_json(Credential.t()) :: credential_json()
  def credential_to_json(%Credential{network: %Network{slug: slug}} = c) do
    %{
      network: slug,
      nick: c.nick,
      realname: c.realname,
      sasl_user: c.sasl_user,
      auth_method: c.auth_method,
      auth_command_template: c.auth_command_template,
      autojoin_channels: c.autojoin_channels,
      connection_state: c.connection_state,
      connection_state_reason: c.connection_state_reason,
      connection_state_changed_at: c.connection_state_changed_at,
      inserted_at: c.inserted_at,
      updated_at: c.updated_at
    }
  end

  @doc """
  Renders a `Networks.Network` row to its public JSON shape. The
  `:servers` and `:credentials` associations are intentionally
  excluded — separate endpoints surface those (and the credentials
  list would otherwise risk per-row password leakage even though
  this module's other function refuses to render it).
  """
  @spec network_to_json(Network.t()) :: network_json()
  def network_to_json(%Network{} = n) do
    %{
      id: n.id,
      slug: n.slug,
      inserted_at: n.inserted_at,
      updated_at: n.updated_at
    }
  end

  @doc """
  Renders a `Networks.Network` + its credential nick to the extended
  `network_with_nick_json` shape used by `GET /networks` for user subjects.

  The caller — `GrappaWeb.NetworksController.index` — already has the
  `Credential` row (from `Credentials.list_credentials_for_user/1`) and
  passes the network + nick pair. Accepting `nick` explicitly (rather than
  a `Credential.t()`) keeps this function ignorant of credential shape and
  avoids another pre-load requirement.
  """
  @spec network_with_nick_to_json(Network.t(), String.t()) :: network_with_nick_json()
  def network_with_nick_to_json(%Network{} = n, nick) when is_binary(nick) and nick != "" do
    %{
      id: n.id,
      slug: n.slug,
      nick: nick,
      inserted_at: n.inserted_at,
      updated_at: n.updated_at
    }
  end

  @doc """
  Renders a single channel entry to its public JSON shape, given the
  channel `name`, the live `joined` state, and the `source` of the
  list entry. Caller is responsible for the source-merge logic
  (private `merge_channel_sources/2` in `GrappaWeb.ChannelsController`).
  """
  @spec channel_to_json(String.t(), boolean(), :autojoin | :joined) :: channel_json()
  def channel_to_json(name, joined, source)
      when is_binary(name) and is_boolean(joined) and source in [:autojoin, :joined] do
    %{name: name, joined: joined, source: source}
  end
end
