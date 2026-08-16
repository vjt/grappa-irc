defmodule Grappa.Visitors.AdminWire do
  @moduledoc """
  Operator-facing JSON wire shape for `Grappa.Visitors.Visitor` rows
  (M-cluster M-4 `GET /admin/visitors`). Sibling to
  `Grappa.Visitors.Wire`, which serves cic/auth-facing surfaces.

  ## Why two wire modules

  `Visitors.Wire` is the redact-protected door for the public profile
  + credential-exchange shapes. It deliberately excludes operator-only
  fields (`:ip`, `:inserted_at`) per its moduledoc. The admin console
  needs those fields PLUS the live BEAM state join — they don't
  belong on the public wire.

  ## #211 phase 7 — multi-network shape

  A visitor is multi-network now, and its per-network identity (nick) lives
  on the `network_credentials` rows, not the visitor row. So the admin
  shape is an identity-wide envelope (`id`, `expires_at`, `identified`,
  `ip`, `inserted_at`) with a `:networks` list — one entry per credential
  carrying that network's `slug`, `nick`, `connection_state`, and the live
  BEAM `live_state` join (`nil` = the U-0 honesty signal: DB intent exists,
  BEAM doesn't). A visitor with no credentials yields `networks: []`.

  #618 — each network entry carries BOTH nicks: the credential's `nick`
  (configured) and `live_state.nick` (who upstream answers to now). They
  diverge on a 433 fallback or a failed ghost recovery, and the pair is
  the only way an operator can see it. Never reconciled into one field.

  ## Defensive field exclusion (CRITICAL)

  No credential secret (`:password_encrypted`) or `:auth_method` is ever in
  the rendered map — only the per-network `nick`/`connection_state` the
  operator needs. Adding fields = edit one site (this module) with
  explicit per-field projection.
  """

  alias Grappa.LiveIntrospection.SessionEntry
  alias Grappa.Networks.{Credential, Network}
  alias Grappa.Visitors.Visitor

  @type live_state_json :: %{
          nick: String.t() | nil,
          alive: boolean(),
          pid_inspect: String.t(),
          mailbox_len: non_neg_integer(),
          memory_bytes: non_neg_integer(),
          joined_channels: [String.t()] | nil,
          introspection_degraded: [SessionEntry.degraded_field()]
        }

  @type network_json :: %{
          network_slug: String.t(),
          # #269 — the raw integer FK. cic builds the composite session id
          # `visitor:<id>:<network_id>` from it to drive the per-network
          # Disconnect/Reconnect toggle through the `/admin/sessions/:id/*`
          # verbs (which key on that composite, NOT the slug).
          network_id: pos_integer(),
          nick: String.t(),
          connection_state: Credential.connection_state(),
          live_state: live_state_json() | nil
        }

  @type t :: %{
          id: Ecto.UUID.t(),
          expires_at: DateTime.t() | nil,
          identified: boolean(),
          ip: String.t() | nil,
          session_ip: String.t() | nil,
          inserted_at: DateTime.t(),
          last_seen_at: DateTime.t() | nil,
          networks: [network_json()]
        }

  @type index_payload :: %{visitors: [t()]}

  @doc """
  Render a visitor row + its per-network credentials-with-live-state to
  the admin JSON shape. `per_network` is the `[{credential, live}]` list
  from `Grappa.Visitors.list_all_with_live_state/0`; each `live` is `nil`
  when no `Session.Server` is registered for `{:visitor, v.id} ×
  credential.network_id` — the U-0 honesty signal.

  `last_seen_at` and `session_ip` both come from the visitor's newest
  browser session (`Grappa.Accounts.newest_touch_by_subject_ids/2`),
  identity-wide like `expires_at` — properties of the subject, not of
  one network. `nil` on either means no `accounts_sessions` row has
  ever been seen for it.

  #1157 — the fields are here because the admin's unified session list
  is ROW-backed: it must show a last-seen for a parked or expired
  visitor, which by construction has no registry entry and so never
  appears in `GET /admin/sessions`, where this value used to live alone.
  A column reading `—` for every inactive row would say "never used",
  which is not what the server observed — it is what the server never
  asked.

  #1308 — `session_ip` is the address the newest session logged in
  from. `ip` beside it is a DIFFERENT fact and stays: `visitors.ip` is
  written once on the identity row, so it answers "where was this
  visitor first seen", not "where is this session coming from". The
  admin console renders the per-session one (vjt, 2026-08-14); the
  identity-wide one keeps its place on the wire because the contract is
  additive-only and other readers exist.
  """
  @spec visitor_to_admin_json(
          Visitor.t(),
          [{Credential.t(), SessionEntry.t() | nil}],
          DateTime.t() | nil,
          String.t() | nil
        ) :: t()
  def visitor_to_admin_json(%Visitor{} = v, per_network, last_seen_at, session_ip)
      when is_list(per_network) do
    %{
      id: v.id,
      expires_at: v.expires_at,
      last_seen_at: last_seen_at,
      session_ip: session_ip,
      # #211 phase 7 — "identified/registered" is DERIVED from the
      # credentials (any network holds a committed NickServ secret), not a
      # `visitors.expires_at`-nil flag. The per_network list is already
      # loaded, so derive it in-memory here — no extra query.
      identified: Enum.any?(per_network, fn {cred, _} -> cred.password_encrypted != nil end),
      ip: v.ip,
      inserted_at: v.inserted_at,
      networks: Enum.map(per_network, &network_entry/1)
    }
  end

  @spec network_entry({Credential.t(), SessionEntry.t() | nil}) :: network_json()
  defp network_entry({%Credential{network: %Network{slug: slug}} = cred, live}) do
    %{
      network_slug: slug,
      network_id: cred.network_id,
      nick: cred.nick,
      connection_state: cred.connection_state,
      live_state: live_state_to_json(live)
    }
  end

  defp live_state_to_json(nil), do: nil

  defp live_state_to_json(%SessionEntry{} = entry) do
    %{
      nick: entry.nick,
      alive: entry.alive,
      pid_inspect: inspect(entry.pid),
      mailbox_len: entry.mailbox_len,
      memory_bytes: entry.memory_bytes,
      joined_channels: entry.joined_channels,
      introspection_degraded: entry.introspection_degraded
    }
  end

  @doc "Wraps the rendered rows as the `GET /admin/visitors` envelope."
  @spec index_payload([t()]) :: index_payload()
  def index_payload(rows) when is_list(rows), do: %{visitors: rows}
end
