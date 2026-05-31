defmodule Grappa.Networks.Credentials.AdminWire do
  @moduledoc """
  Operator-facing JSON wire shape for `Grappa.Networks.Credential`
  rows (M-cluster M-6 `GET /admin/credentials`,
  `PATCH /admin/credentials/:user_id/:network_id`). Sibling to
  `Grappa.Networks.Wire`, which serves cic/auth-facing surfaces.

  ## Why two wire modules

  `Networks.Wire`'s `credential_json/1` exposes the per-credential
  shape every authenticated user sees about their OWN credential. The
  admin pane sees the same rows + the live `Session.Server` state
  attached per credential — and excludes nothing the public wire
  already excludes (`password_encrypted`, `password`).

  Splitting AdminWire from Wire keeps the public Wire's allowlist
  contract tight: future cic features that want the admin shape have
  to opt into this module explicitly, not stumble on it as a side
  effect of reusing `Wire`. Same pattern as
  `Grappa.Accounts.AdminWire` ↔ `Grappa.Accounts.Wire`.

  ## Defensive field exclusion (CRITICAL — read before adding fields)

  `Credential.password_encrypted` is a `Grappa.EncryptedBinary` Cloak
  column whose `:load` callback decrypts AES-GCM on read. After
  `Repo.one!`, the field IN MEMORY carries the **plaintext upstream
  IRC password** — the field name describes the on-disk
  representation, not the post-load value. The `redact: true` on the
  schema field protects `inspect/1` + Logger output, but NOT
  `Jason.encode!/1`, which walks struct fields directly.

  This module's per-key projection NEVER includes `:password_encrypted`
  or the virtual `:password` field. Adding a field = one edit here +
  explicit allowlist. Removing one = a breaking change visible at this
  single site. The same defense `Networks.Wire`'s moduledoc documents
  at length applies here verbatim.

  ## Live state nesting

  `live_state: SessionEntry | nil` mirrors `Visitors.AdminWire`'s
  shape exactly so cic shares one renderer across visitor + credential
  rows. `nil` IS the U-0 honesty signal: DB intent says
  `:connected` but BEAM has no pid registered → operator sees the
  divergence prominently.

  ## Preload contract

  Caller MUST preload `:network` on the credential — the wire shape
  carries `network_slug` (operator-meaningful) NOT just `network_id`
  (FK). Mirrors `Networks.Wire.credential_to_json/1`'s preload
  requirement; missing preload crashes loudly at render time, which
  is the right signal.
  """

  alias Grappa.LiveIntrospection.SessionEntry
  alias Grappa.Networks.{Credential, Network}

  @type live_state_json :: %{
          alive: boolean(),
          pid_inspect: String.t(),
          mailbox_len: non_neg_integer(),
          memory_bytes: non_neg_integer(),
          joined_channels: [String.t()] | nil,
          introspection_degraded: [SessionEntry.degraded_field()]
        }

  @type t :: %{
          user_id: Ecto.UUID.t(),
          network_id: integer(),
          network_slug: String.t(),
          nick: String.t(),
          realname: String.t() | nil,
          sasl_user: String.t() | nil,
          auth_method: Credential.auth_method(),
          auth_command_template: String.t() | nil,
          autojoin_channels: [String.t()],
          last_joined_channels: [String.t()],
          connection_state: Credential.connection_state(),
          connection_state_reason: String.t() | nil,
          connection_state_changed_at: DateTime.t() | nil,
          inserted_at: DateTime.t(),
          updated_at: DateTime.t(),
          live_state: live_state_json() | nil
        }

  @typedoc """
  Admin-panel bucket 3 — outcome of the PUT credential update against
  any running `Session.Server` for `{:user, user_id} × network_id`.

    * `:left_alone` — no live session, OR the change set didn't include
      `:password` / `:auth_method` (cosmetic-only fields like autojoin or
      realname). Operator sees no behavior change. Also covers the
      "auth-touching change against a parked / unbootstrapped credential"
      case: there's nothing to stop, so the wire is honest and uniform.
    * `:stopped` — change set included `:password` / `:auth_method`, AND
      a live session existed. `Session.stop_session/2` killed it; operator
      must `/connect` to bring it back under the new creds. Per plan A-2,
      we don't auto-respawn — the `POST /networks/:slug/connect` verb is
      the operator-facing path that re-runs admission + spawn.
  """
  @type session_action :: :left_alone | :stopped

  @doc """
  Render a Credential row + optional live SessionEntry to the admin
  JSON shape. `live` is `nil` when no `Session.Server` is registered
  for `{:user, user_id} × network_id` — the U-0 honesty signal.

  Crashes loudly when `:network` association isn't preloaded — the
  wire carries `network_slug`, not `network_id` alone.
  """
  @spec credential_to_admin_json(Credential.t(), SessionEntry.t() | nil) :: t()
  def credential_to_admin_json(%Credential{network: %Network{slug: slug}} = c, live) do
    %{
      user_id: c.user_id,
      network_id: c.network_id,
      network_slug: slug,
      nick: c.nick,
      realname: c.realname,
      sasl_user: c.sasl_user,
      auth_method: c.auth_method,
      auth_command_template: c.auth_command_template,
      autojoin_channels: c.autojoin_channels,
      last_joined_channels: c.last_joined_channels,
      connection_state: c.connection_state,
      connection_state_reason: c.connection_state_reason,
      connection_state_changed_at: c.connection_state_changed_at,
      inserted_at: c.inserted_at,
      updated_at: c.updated_at,
      live_state: live_state_to_json(live)
    }
  end

  defp live_state_to_json(nil), do: nil

  defp live_state_to_json(%SessionEntry{} = entry) do
    %{
      alive: entry.alive,
      pid_inspect: inspect(entry.pid),
      mailbox_len: entry.mailbox_len,
      memory_bytes: entry.memory_bytes,
      joined_channels: entry.joined_channels,
      introspection_degraded: entry.introspection_degraded
    }
  end

  @doc """
  Attaches a `session_action:` field to a credential JSON map (the
  bucket-3 PUT response shape). Defined here, not at the controller,
  so the wire-shape evolution stays in one place.
  """
  @spec with_session_action(t(), session_action()) :: map()
  def with_session_action(%{} = json, action)
      when action in [:left_alone, :stopped] do
    Map.put(json, :session_action, action)
  end
end
