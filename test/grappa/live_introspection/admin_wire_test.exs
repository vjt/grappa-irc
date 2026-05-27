defmodule Grappa.LiveIntrospection.AdminWireTest do
  @moduledoc """
  Wire-shape contract for the operator-facing `GET /admin/sessions`
  endpoint (M-cluster M-4). Converts a `Grappa.LiveIntrospection.SessionEntry`
  + a resolved subject_label + an optional last_seen_at to a
  JSON-encodable map.
  """
  use ExUnit.Case, async: true

  alias Grappa.LiveIntrospection.{AdminWire, SessionEntry}

  test "session_to_admin_json/3 stringifies subject_kind + projects live_state subfields + subject_label" do
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

    json = AdminWire.session_to_admin_json(entry, "M\\Grappa", nil)

    assert json.subject_kind == "visitor"
    assert json.subject_id == uuid
    assert json.subject_label == "M\\Grappa"
    assert json.network_id == 42
    assert is_map(json.live_state)
    assert json.live_state.alive == true
    assert json.live_state.mailbox_len == 3
    assert json.live_state.memory_bytes == 99_999
    assert json.live_state.joined_channels == ["#one", "#two"]
    assert json.live_state.introspection_degraded == []
    assert is_binary(json.live_state.pid_inspect)
  end

  test "session_to_admin_json/3 user-subject shape" do
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

    json = AdminWire.session_to_admin_json(entry, "vjt", nil)

    assert json.subject_kind == "user"
    assert json.subject_id == uuid
    assert json.subject_label == "vjt"
    assert json.live_state.joined_channels == nil
    assert json.live_state.introspection_degraded == [:joined_channels]
  end

  test "subject_label: nil surfaces the orphan-pid honesty signal" do
    # DB row gone (visitor reaped / user deleted), pid still
    # registered. The controller passes `nil` when the batched
    # lookup didn't find the id; the wire faithfully carries it so
    # the operator console can render "no DB row" instead of an
    # opaque UUID.
    uuid = Ecto.UUID.generate()

    entry = %SessionEntry{
      subject: {:visitor, uuid},
      network_id: 1,
      pid: self(),
      alive: true,
      mailbox_len: 0,
      memory_bytes: 512,
      joined_channels: [],
      introspection_degraded: []
    }

    json = AdminWire.session_to_admin_json(entry, nil, nil)

    assert json.subject_label == nil
    assert json.subject_id == uuid
  end

  test "session_to_admin_json/3 rejects non-string non-nil labels at the guard" do
    entry = %SessionEntry{
      subject: {:user, Ecto.UUID.generate()},
      network_id: 1,
      pid: self(),
      alive: true,
      mailbox_len: 0,
      memory_bytes: 0,
      joined_channels: [],
      introspection_degraded: []
    }

    # Guard `is_binary(label) or is_nil(label)` — anything else is a
    # contract violation that surfaces as FunctionClauseError.
    assert_raise FunctionClauseError, fn ->
      AdminWire.session_to_admin_json(entry, :atom_label, nil)
    end
  end

  test "last_seen_at: DateTime → ISO8601 string on the wire" do
    # The controller looks up MAX(accounts_sessions.last_seen_at) per
    # subject id and passes the DateTime (or nil) as the third arg.
    # Wire renders it via `DateTime.to_iso8601/1` so the cic admin
    # console can `new Date(...)` it directly.
    uuid = Ecto.UUID.generate()
    {:ok, dt, _} = DateTime.from_iso8601("2026-05-27T18:30:00.123456Z")

    entry = %SessionEntry{
      subject: {:user, uuid},
      network_id: 1,
      pid: self(),
      alive: true,
      mailbox_len: 0,
      memory_bytes: 0,
      joined_channels: [],
      introspection_degraded: []
    }

    json = AdminWire.session_to_admin_json(entry, "vjt", dt)

    assert json.last_seen_at == "2026-05-27T18:30:00.123456Z"
  end

  test "last_seen_at: nil surfaces the no-cookie-session honesty signal" do
    # Bootstrap-spawned session for a user credential whose browser
    # never logged in (operator boot path) has no cookie session —
    # nil signals "we have a live bouncer but no recent browser
    # touch", distinct from "browser logged in N seconds ago".
    uuid = Ecto.UUID.generate()

    entry = %SessionEntry{
      subject: {:user, uuid},
      network_id: 1,
      pid: self(),
      alive: true,
      mailbox_len: 0,
      memory_bytes: 0,
      joined_channels: [],
      introspection_degraded: []
    }

    json = AdminWire.session_to_admin_json(entry, "vjt", nil)

    assert json.last_seen_at == nil
  end

  test "session_to_admin_json/3 rejects non-DateTime non-nil last_seen_at at the guard" do
    entry = %SessionEntry{
      subject: {:user, Ecto.UUID.generate()},
      network_id: 1,
      pid: self(),
      alive: true,
      mailbox_len: 0,
      memory_bytes: 0,
      joined_channels: [],
      introspection_degraded: []
    }

    assert_raise FunctionClauseError, fn ->
      AdminWire.session_to_admin_json(entry, "vjt", "2026-01-01T00:00:00Z")
    end
  end
end
