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
          alive: boolean(),
          pid_inspect: String.t(),
          mailbox_len: non_neg_integer(),
          memory_bytes: non_neg_integer(),
          joined_channels: [String.t()] | nil,
          introspection_degraded: [SessionEntry.degraded_field()]
        }

  @type t :: %{
          subject_kind: String.t(),
          subject_id: String.t(),
          subject_label: String.t() | nil,
          last_seen_at: String.t() | nil,
          network_id: pos_integer(),
          live_state: live_state_json()
        }

  @doc """
  Render one `SessionEntry` + its resolved `subject_label` +
  optional `last_seen_at` to the admin JSON shape.

  `subject_kind` is the atom-as-string (`"user"` | `"visitor"`);
  `subject_id` is the inner UUID. `subject_label` is the
  human-readable display name (`user.name` / `visitor.nick`) or
  `nil` when the DB row was missing at composition time.

  `last_seen_at` is the MAX(`accounts_sessions.last_seen_at`)
  across all the subject's cookie sessions — rendered as ISO8601
  (`DateTime.to_iso8601/1`) — or `nil` when no cookie exists
  (Bootstrap-spawned bouncer with no browser login). Same U-0
  honesty rule as `subject_label`.

  The caller (the controller) owns the resolution of BOTH the
  label AND the last_seen lookup because `LiveIntrospection`'s
  boundary explicitly excludes `Accounts` / `Visitors` deps.
  Keeps the pure live-state module DB-free.
  """
  @spec session_to_admin_json(SessionEntry.t(), String.t() | nil, DateTime.t() | nil) :: t()
  def session_to_admin_json(%SessionEntry{subject: {kind, id}} = entry, label, last_seen_at)
      when (is_binary(label) or is_nil(label)) and
             (is_struct(last_seen_at, DateTime) or is_nil(last_seen_at)) do
    %{
      subject_kind: Atom.to_string(kind),
      subject_id: id,
      subject_label: label,
      last_seen_at: encode_last_seen(last_seen_at),
      network_id: entry.network_id,
      live_state: %{
        alive: entry.alive,
        pid_inspect: inspect(entry.pid),
        mailbox_len: entry.mailbox_len,
        memory_bytes: entry.memory_bytes,
        joined_channels: entry.joined_channels,
        introspection_degraded: entry.introspection_degraded
      }
    }
  end

  defp encode_last_seen(nil), do: nil
  defp encode_last_seen(%DateTime{} = dt), do: DateTime.to_iso8601(dt)
end
