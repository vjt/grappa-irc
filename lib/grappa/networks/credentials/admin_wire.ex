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

  #618 extends the same two-sources posture to the identity itself: the
  row's top-level `nick` is what the operator CONFIGURED, `live_state.nick`
  is who upstream is actually talking to. A failed ghost recovery leaves
  the session on `<nick>_` for its whole life, and before this the wire
  had no way to say so. The two are rendered side by side and never
  reconciled — computing one from the other is exactly the tidying-up
  CLAUDE.md forbids.

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
          nick: String.t() | nil,
          alive: boolean(),
          pid_inspect: String.t(),
          mailbox_len: non_neg_integer(),
          memory_bytes: non_neg_integer(),
          joined_channels: [String.t()] | nil,
          introspection_degraded: [SessionEntry.degraded_field()]
        }

  @type t :: %{
          user_id: Ecto.UUID.t(),
          user_name: String.t() | nil,
          network_id: integer(),
          network_slug: String.t(),
          nick: String.t(),
          ident: String.t() | nil,
          realname: String.t() | nil,
          sasl_user: String.t() | nil,
          auth_method: Credential.auth_method(),
          auth_command_template: String.t() | nil,
          autojoin_channels: [String.t()],
          last_joined_channels: [String.t()],
          connection_state: Credential.connection_state(),
          connection_state_reason: String.t() | nil,
          connection_state_changed_at: DateTime.t() | nil,
          detached_at: DateTime.t() | nil,
          inserted_at: DateTime.t(),
          updated_at: DateTime.t(),
          last_seen_at: DateTime.t() | nil,
          session_ip: String.t() | nil,
          live_state: live_state_json() | nil
        }

  @type index_payload :: %{credentials: [t()]}

  @typedoc """
  What the admin verb did to the session for
  `{:user, user_id} × network_id`. ONE wire key, `session_action`, so ONE
  union — the codegen publishes it to cic as a single string-literal set,
  and splitting the values across two types would have shipped cic a
  union that omits half the values the field can carry.

  PATCH (admin-panel bucket 3 — the credential update against any running
  session; `Grappa.Operator.update_credential/3`):

    * `:left_alone` — no live session, OR the change set didn't include
      `:password` / `:auth_method` (cosmetic-only fields like autojoin or
      realname). Operator sees no behavior change. Also covers the
      "auth-touching change against a parked / unbootstrapped credential"
      case: there's nothing to restart, so the wire is honest and uniform.
    * `:spawned` — change set included `:password` / `:auth_method`, AND a
      live session existed: it was restarted (#2474) and its successor is
      running under the new credential. `session_error` is `nil`.
    * `:stopped` — the same restart, refused: the session is gone, the row
      is `:parked`, and `session_error` names the refusal. Before #2474
      this was the only outcome of an auth-touching edit, with no respawn
      and the row left reading `:connected`.

  POST (#1163 — the bind that dials):

    * `:spawned` — a `Session.Server` is running and the row was committed
      `:connected`. `session_error` is `nil`.
    * `:not_spawned` — the row was created and left `:parked`;
      `session_error` names the refusal.

  `:spawned` means the same thing from either verb: a session is running
  that read this row. `:stopped` (PATCH) and `:not_spawned` (POST) stay
  apart because the first says a running session was taken down.
  """
  @type session_action :: :left_alone | :stopped | :spawned | :not_spawned

  @doc """
  Render a Credential row + optional live SessionEntry to the admin
  JSON shape. `live` is `nil` when no `Session.Server` is registered
  for `{:user, user_id} × network_id` — the U-0 honesty signal.

  `last_seen_at` and `session_ip` are the OWNING USER's newest browser
  session (`Grappa.Accounts.newest_touch_by_subject_ids/2`). They are
  properties of the subject, not of this network, so a user bound to
  three networks reports the same values on all three rows — the same
  subject-wide grain `GET /admin/sessions` already publishes. `nil` =
  no `accounts_sessions` row on record.

  #1157 — see the twin note on `Grappa.Visitors.AdminWire`: the admin's
  unified session list is ROW-backed, so a parked credential (no pid, no
  registry entry, absent from `GET /admin/sessions`) still owes the
  operator a truthful last-seen instead of a `—` that reads "never
  used".

  #1315 — `user_name` is the ACCOUNT behind the row (`users.name`), and
  like the two above it is resolved by the caller rather than read off the
  credential: `GrappaWeb.Admin.SubjectLabels` already batches that lookup
  for every admin listing, and an association read here would put an N+1
  on the one page that enumerates the whole table. `nil` means the caller
  resolved no name — missing is missing, and the console still has
  `user_id`. It is an ADDITIONAL identity fact, never a substitute for
  `nick`: the ruling (vjt, on #1315) is that the row shows the credential
  nick where one is available, and the account name beside it, with
  neither computed from the other.

  #1308 — `session_ip` is the address that session logged in from, and
  it is the FIRST source address a user row has ever carried: before
  this the console could show one only for a visitor, out of the
  identity-wide `visitors.ip`, and there is no such column on the user
  side to fall back to. Never to be confused with
  `live_state.peer_address`, which is the upstream IRC endpoint the
  bouncer's own socket landed on.

  Crashes loudly when `:network` association isn't preloaded — the
  wire carries `network_slug`, not `network_id` alone.
  """
  @spec credential_to_admin_json(
          Credential.t(),
          SessionEntry.t() | nil,
          DateTime.t() | nil,
          String.t() | nil,
          String.t() | nil
        ) :: t()
  def credential_to_admin_json(
        %Credential{network: %Network{slug: slug}} = c,
        live,
        last_seen_at,
        session_ip,
        user_name
      ) do
    %{
      last_seen_at: last_seen_at,
      session_ip: session_ip,
      user_id: c.user_id,
      user_name: user_name,
      network_id: c.network_id,
      network_slug: slug,
      nick: c.nick,
      ident: c.ident,
      realname: c.realname,
      sasl_user: c.sasl_user,
      auth_method: c.auth_method,
      auth_command_template: c.auth_command_template,
      autojoin_channels: c.autojoin_channels,
      last_joined_channels: c.last_joined_channels,
      connection_state: c.connection_state,
      connection_state_reason: c.connection_state_reason,
      connection_state_changed_at: c.connection_state_changed_at,
      # issue 2219 — the attachment axis, READ-ONLY on this surface and
      # separate from `connection_state` above. Without it the operator
      # console shows a credential that answers no REST call and spawns at
      # no boot, with nothing on the row saying why: the CLAUDE.md rule
      # that an admin listing must carry BOTH truths rather than the
      # tidier one. Not writable here — the subject owns this axis, and
      # the operator's verb for a row they want gone is the unbind that is
      # already on this controller.
      detached_at: c.detached_at,
      inserted_at: c.inserted_at,
      updated_at: c.updated_at,
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

  @typedoc """
  #1163 — the `session_error` value space: why a bind did not dial, or
  (#2474) why an edit's restart did not come back. `nil` when it did.

  These are `Grappa.Operator.spawn_error/0` with the
  payloads dropped (a `{:network_circuit_open, retry_after}` renders as
  `:network_circuit_open`) — spelled out rather than aliased because
  `Grappa.Networks` must not depend on `Grappa.Admission`. Runtime tag
  extraction is generic, so a tag added to
  `Admission.capacity_error_atoms/0` still renders correctly; only this
  type would go stale.
  """
  @type spawn_error ::
          :resolve_failed
          | :not_found
          | :ip_cap_exceeded
          | :visitor_cap_exceeded
          | :user_cap_exceeded
          | :network_circuit_open
          | :start_failed

  @doc """
  Attaches `session_action:` + `session_error:` to the reply of an admin
  verb that can move the session: the PATCH (`:left_alone`, `:spawned` or
  `{:stopped, reason}`) and, since #1163, the POST bind (`:spawned` or
  `{:not_spawned, reason}`). One renderer for both, so the key pair keeps
  one shape.

  `session_error` is `nil` unless the action is a refusal, so the operator
  reads one field to tell "the session is running" from "and here is why
  it is not": the alternative, a 2xx that says nothing, is the
  silent-swallow both endpoints shipped before (#1163, #2474).

  The outcome argument is spelled INLINE, deliberately: a named public
  type in a `*Wire` module is a wire CONTRACT — `mix grappa.gen_wire_types`
  publishes every one of them to `cicchetto/src/lib/wireTypes.ts`. This
  tuple is an internal Elixir hand-off between the controller and this
  renderer; naming it shipped cic a `["not_spawned", …]` array type for a
  payload the wire never carries.
  """
  @spec with_session_outcome(
          t(),
          :left_alone
          | :spawned
          | {:stopped | :not_spawned, spawn_error() | {spawn_error(), term()}}
        ) :: map()
  def with_session_outcome(%{} = json, action) when action in [:left_alone, :spawned] do
    Map.merge(json, %{session_action: action, session_error: nil})
  end

  def with_session_outcome(%{} = json, {action, reason}) when action in [:stopped, :not_spawned] do
    Map.merge(json, %{session_action: action, session_error: error_tag(reason)})
  end

  @doc "Wraps the rendered rows as the `GET /admin/credentials` envelope."
  @spec index_payload([t()]) :: index_payload()
  def index_payload(rows) when is_list(rows), do: %{credentials: rows}

  @spec error_tag(spawn_error() | {spawn_error(), term()}) :: spawn_error()
  defp error_tag({tag, _}) when is_atom(tag), do: tag
  defp error_tag(tag) when is_atom(tag), do: tag
end
