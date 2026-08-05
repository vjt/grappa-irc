defmodule Grappa.LiveIntrospection.AdminWire do
  @moduledoc """
  Operator-facing JSON wire shape for `Grappa.LiveIntrospection.SessionEntry`
  (M-cluster M-4 `GET /admin/sessions`). One entry per live
  `Session.Server` registered in `Grappa.SessionRegistry`.

  ## Why not under `Grappa.Session`

  This Wire takes a `SessionEntry`, not a `Session.Server` state —
  it lives next to its input type. Putting it under `Session` would
  create a `Session ↔ LiveIntrospection` boundary cycle
  (LiveIntrospection already depends on Session for
  `list_channels/2`).

  ## pid_inspect contract

  `pid_inspect: "#PID<0.1234.0>"` is human-readable only. cic MUST
  NEVER parse it back to a pid (cic doesn't connect to the BEAM
  distribution). Operator console renders it for visual
  identification; mutations key on `(subject, network_id)`.

  ## subject_label + DB-row honesty signal

  `subject_label` is the human-readable display name (`user.name` /
  `visitor.nick`) resolved at the controller via batched DB lookup
  on the registry-scan result. `subject_label: nil` IS the "BEAM
  has a pid but DB has no row" honesty signal — the gemello of the
  U-0 signal that `Visitors.AdminWire` surfaces in the opposite
  direction (DB row but no pid). Both directions can drift:

    * Visitor row deleted via raw SQL while pid still running
    * `Visitors.delete/1` race vs `Session.Server` terminate
    * User account deleted while a session is alive

  Rendering `subject_label: nil` lets the operator see "orphan pid —
  delete-and-respawn this row" without paging through the BEAM
  process list directly.
  """

  alias Grappa.LiveIntrospection.SessionEntry

  @type live_state_json :: %{
          nick: String.t() | nil,
          alive: boolean(),
          pid_inspect: String.t(),
          mailbox_len: non_neg_integer(),
          memory_bytes: non_neg_integer(),
          joined_channels: [String.t()] | nil,
          peer_address: String.t() | nil,
          peer_port: :inet.port_number() | nil,
          peer_name: String.t() | nil,
          introspection_degraded: [SessionEntry.degraded_field()]
        }

  @type t :: %{
          subject_kind: :user | :visitor,
          subject_id: String.t(),
          subject_label: String.t() | nil,
          last_seen_at: String.t() | nil,
          network_id: pos_integer(),
          live_state: live_state_json()
        }

  @doc """
  Render one `SessionEntry` + its resolved `subject_label` +
  optional `last_seen_at` to the admin JSON shape.

  `subject_kind` is the `:user | :visitor` atom, passed through
  unchanged — Jason stringifies it to `"user"` / `"visitor"` at the
  JSON edge (a closed set stays a typed atom union, not an untyped
  `String.t()`, per CLAUDE.md; mirrors `Grappa.AdminEvents.Wire`'s
  `subject_kind`). `subject_id` is the inner UUID. `subject_label` is the
  human-readable display name (`user.name` / `visitor.nick`) or
  `nil` when the DB row was missing at composition time.

  `last_seen_at` is the MAX(`accounts_sessions.last_seen_at`)
  across all the subject's cookie sessions — rendered as ISO8601
  (`DateTime.to_iso8601/1`) — or `nil` when no cookie exists
  (Bootstrap-spawned bouncer with no browser login). Same U-0
  honesty rule as `subject_label`.

  The caller (the controller) owns the resolution of the
  `subject_label`, the `last_seen_at` lookup, AND the `peer_name`
  reverse-DNS (#550) because `LiveIntrospection`'s boundary
  explicitly excludes `Accounts` / `Visitors` / `Net.PtrCache` deps.
  Keeps the pure live-state module DB- and resolver-free.

  ## Live nick (#618)

  `live_state.nick` is who upstream is talking to RIGHT NOW. This wire
  has no configured-nick column to compare it against — `GET
  /admin/credentials` and `GET /admin/visitors` carry both halves side by
  side. Here it is the answer to "which of these pids is the one flying
  `vjt_`", which the operator previously could not ask at all.

  ## Upstream peer (#550)

  `live_state.peer_address` (string) + `peer_port` come straight off
  the `SessionEntry` — the destination the IRC socket landed on,
  captured live (netsplit triage). `peer_name` is the reverse-DNS the
  controller resolved out of band via `Grappa.Net.PtrCache` (never
  inline — a blocking PTR per row would hang the admin page). All three
  are `nil` when the session is not connected; `peer_name` is also `nil`
  on a cold cache or an address with no PTR, in which case cic falls
  back to the raw `peer_address`, which is authoritative on its own.
  The name is attacker-controlled for third-party networks — cic MUST
  render it as untrusted text next to (never instead of) the address.
  """
  @spec session_to_admin_json(
          SessionEntry.t(),
          String.t() | nil,
          DateTime.t() | nil,
          String.t() | nil
        ) :: t()
  def session_to_admin_json(%SessionEntry{subject: {kind, id}} = entry, label, last_seen_at, peer_name)
      when kind in [:user, :visitor] and
             (is_binary(label) or is_nil(label)) and
             (is_struct(last_seen_at, DateTime) or is_nil(last_seen_at)) and
             (is_binary(peer_name) or is_nil(peer_name)) do
    %{
      subject_kind: kind,
      subject_id: id,
      subject_label: label,
      last_seen_at: encode_last_seen(last_seen_at),
      network_id: entry.network_id,
      live_state: %{
        nick: entry.nick,
        alive: entry.alive,
        pid_inspect: inspect(entry.pid),
        mailbox_len: entry.mailbox_len,
        memory_bytes: entry.memory_bytes,
        joined_channels: entry.joined_channels,
        peer_address: entry.peer_address,
        peer_port: entry.peer_port,
        peer_name: peer_name,
        introspection_degraded: entry.introspection_degraded
      }
    }
  end

  defp encode_last_seen(nil), do: nil
  defp encode_last_seen(%DateTime{} = dt), do: DateTime.to_iso8601(dt)
end
