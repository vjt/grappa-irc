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
          network_id: pos_integer(),
          live_state: live_state_json()
        }

  @doc """
  Render one `SessionEntry` to the admin JSON shape. `subject_kind`
  is the atom-as-string (`"user"` | `"visitor"`); `subject_id` is
  the inner UUID. Cic surfaces the pair as a single human-readable
  "who" label without re-deriving the tuple shape.
  """
  @spec session_to_admin_json(SessionEntry.t()) :: t()
  def session_to_admin_json(%SessionEntry{subject: {kind, id}} = entry) do
    %{
      subject_kind: Atom.to_string(kind),
      subject_id: id,
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
end
