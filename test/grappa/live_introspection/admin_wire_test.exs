defmodule Grappa.LiveIntrospection.AdminWireTest do
  @moduledoc """
  Wire-shape contract for the operator-facing `GET /admin/sessions`
  endpoint (M-cluster M-4). Converts a `Grappa.LiveIntrospection.SessionEntry`
  to a JSON-encodable map.
  """
  use ExUnit.Case, async: true

  alias Grappa.LiveIntrospection.{AdminWire, SessionEntry}

  test "session_to_admin_json/1 stringifies subject_kind + projects live_state subfields" do
    uuid = Ecto.UUID.generate()

    entry = %SessionEntry{
      subject: {:visitor, uuid},
      network_id: 42,
      pid: self(),
      alive: true,
      mailbox_len: 3,
      memory_bytes: 99_999,
      joined_channels: ["#one", "#two"],
      introspection_degraded: []
    }

    json = AdminWire.session_to_admin_json(entry)

    assert json.subject_kind == "visitor"
    assert json.subject_id == uuid
    assert json.network_id == 42
    assert is_map(json.live_state)
    assert json.live_state.alive == true
    assert json.live_state.mailbox_len == 3
    assert json.live_state.memory_bytes == 99_999
    assert json.live_state.joined_channels == ["#one", "#two"]
    assert json.live_state.introspection_degraded == []
    assert is_binary(json.live_state.pid_inspect)
  end

  test "session_to_admin_json/1 user-subject shape" do
    uuid = Ecto.UUID.generate()

    entry = %SessionEntry{
      subject: {:user, uuid},
      network_id: 7,
      pid: self(),
      alive: true,
      mailbox_len: 0,
      memory_bytes: 1024,
      joined_channels: nil,
      introspection_degraded: [:joined_channels]
    }

    json = AdminWire.session_to_admin_json(entry)

    assert json.subject_kind == "user"
    assert json.subject_id == uuid
    assert json.live_state.joined_channels == nil
    assert json.live_state.introspection_degraded == [:joined_channels]
  end
end
