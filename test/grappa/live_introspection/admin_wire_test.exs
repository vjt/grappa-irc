defmodule Grappa.LiveIntrospection.AdminWireTest do
  @moduledoc """
  Wire-shape contract for the operator-facing `GET /admin/sessions`
  endpoint (M-cluster M-4). Converts a `Grappa.LiveIntrospection.SessionEntry`
  + a resolved subject_label + an optional last_seen_at + the resolved
  upstream peer name (#550) to a JSON-encodable map.
  """
  use ExUnit.Case, async: true

  alias Grappa.LiveIntrospection.{AdminWire, SessionEntry}

  # #550 — SessionEntry now enforces peer_address/peer_port. A connected
  # entry carries them; a not-connected one is nil + the :peer_address
  # degraded marker. Helper keeps the literals honest without repeating the
  # full 10-field struct per test.
  defp entry(overrides) do
    base = %{
      subject: {:user, Ecto.UUID.generate()},
      network_id: 1,
      pid: self(),
      nick: "vjt",
      alive: true,
      mailbox_len: 0,
      memory_bytes: 512,
      joined_channels: [],
      peer_address: nil,
      peer_port: nil,
      introspection_degraded: []
    }

    struct!(SessionEntry, Map.merge(base, Map.new(overrides)))
  end

  test "session_to_admin_json/4 passes subject_kind atom through + projects live_state subfields + subject_label" do
    uuid = Ecto.UUID.generate()

    entry =
      entry(
        subject: {:visitor, uuid},
        network_id: 42,
        mailbox_len: 3,
        memory_bytes: 99_999,
        joined_channels: ["#one", "#two"],
        peer_address: "2a01:4f8:201:2281:11::22",
        peer_port: 6697
      )

    json = AdminWire.session_to_admin_json(entry, "M\\Grappa", nil, "allnight6.azzurra.chat")

    # subject_kind is the `:user | :visitor` ATOM in the term — the closed
    # set is typed as an atom union, and Jason stringifies at the JSON edge
    # (identical wire bytes to the former Atom.to_string/1).
    assert json.subject_kind == :visitor
    assert Jason.decode!(Jason.encode!(json))["subject_kind"] == "visitor"
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

  test "session_to_admin_json/4 projects the upstream peer address + port + resolved name" do
    # #550 netsplit triage — the operator sees the destination each session
    # landed on. peer_address/peer_port come off the SessionEntry (live
    # capture); peer_name is the reverse-DNS the controller resolved out of
    # band via Grappa.Net.PtrCache and passes in.
    entry = entry(peer_address: "2a01:4f8:201:2281:11::22", peer_port: 6697)

    json = AdminWire.session_to_admin_json(entry, "vjt", nil, "allnight6.azzurra.chat")

    assert json.live_state.peer_address == "2a01:4f8:201:2281:11::22"
    assert json.live_state.peer_port == 6697
    assert json.live_state.peer_name == "allnight6.azzurra.chat"

    decoded = Jason.decode!(Jason.encode!(json))
    assert decoded["live_state"]["peer_address"] == "2a01:4f8:201:2281:11::22"
    assert decoded["live_state"]["peer_port"] == 6697
    assert decoded["live_state"]["peer_name"] == "allnight6.azzurra.chat"
  end

  test "session_to_admin_json/4 renders nil peer + nil name for a not-connected session" do
    # Not connected (pre-connect / mid-reconnect / socket closed): nil
    # address + nil port + the :peer_address degraded marker, and the
    # controller passes nil for the name (nothing to resolve). Never a
    # fabricated or stale address.
    entry = entry(peer_address: nil, peer_port: nil, introspection_degraded: [:peer_address])

    json = AdminWire.session_to_admin_json(entry, "vjt", nil, nil)

    assert json.live_state.peer_address == nil
    assert json.live_state.peer_port == nil
    assert json.live_state.peer_name == nil
    assert json.live_state.introspection_degraded == [:peer_address]
  end

  # #618 — the live nick is the answer to "which of these pids is flying
  # `vjt_`". `subject_label` is the DB display name and is NOT it: the two
  # are asserted to differ here so a future refactor cannot quietly render
  # the label into `live_state.nick` and still pass.
  test "session_to_admin_json/4 projects the live nick, distinct from subject_label" do
    entry = entry(nick: "vjt_")

    json = AdminWire.session_to_admin_json(entry, "vjt", nil, nil)

    assert json.live_state.nick == "vjt_"
    assert json.subject_label == "vjt"
  end

  test "session_to_admin_json/4 renders a nil live nick rather than inventing one" do
    # The pid deregistered between the registry scan and the nick read.
    # nil is the honest answer; a fallback to the configured nick would
    # destroy the one comparison this field exists to enable.
    json = AdminWire.session_to_admin_json(entry(nick: nil), "vjt", nil, nil)

    assert json.live_state.nick == nil
  end

  test "peer_name nil while peer_address present is the cold-cache / no-PTR shape" do
    # #252 PtrCache is lazy: a cold or no-PTR address resolves to nil name;
    # cic falls back to the raw address, which is always useful on its own.
    entry = entry(peer_address: "192.0.2.7", peer_port: 6667)

    json = AdminWire.session_to_admin_json(entry, "vjt", nil, nil)

    assert json.live_state.peer_address == "192.0.2.7"
    assert json.live_state.peer_port == 6667
    assert json.live_state.peer_name == nil
  end

  test "session_to_admin_json/4 user-subject shape" do
    uuid = Ecto.UUID.generate()

    entry =
      entry(
        subject: {:user, uuid},
        network_id: 7,
        memory_bytes: 1024,
        joined_channels: nil,
        introspection_degraded: [:joined_channels]
      )

    json = AdminWire.session_to_admin_json(entry, "vjt", nil, nil)

    assert json.subject_kind == :user
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

    entry = entry(subject: {:visitor, uuid})

    json = AdminWire.session_to_admin_json(entry, nil, nil, nil)

    assert json.subject_label == nil
    assert json.subject_id == uuid
  end

  test "session_to_admin_json/4 rejects non-string non-nil labels at the guard" do
    entry = entry([])

    # Guard `is_binary(label) or is_nil(label)` — anything else is a
    # contract violation that surfaces as FunctionClauseError.
    assert_raise FunctionClauseError, fn ->
      AdminWire.session_to_admin_json(entry, :atom_label, nil, nil)
    end
  end

  test "session_to_admin_json/4 rejects non-string non-nil peer_name at the guard" do
    entry = entry([])

    assert_raise FunctionClauseError, fn ->
      AdminWire.session_to_admin_json(entry, "vjt", nil, :atom_name)
    end
  end

  test "last_seen_at: DateTime → ISO8601 string on the wire" do
    # The controller looks up MAX(accounts_sessions.last_seen_at) per
    # subject id and passes the DateTime (or nil) as the third arg.
    # Wire renders it via `DateTime.to_iso8601/1` so the cic admin
    # console can `new Date(...)` it directly.
    {:ok, dt, _} = DateTime.from_iso8601("2026-05-27T18:30:00.123456Z")

    entry = entry([])

    json = AdminWire.session_to_admin_json(entry, "vjt", dt, nil)

    assert json.last_seen_at == "2026-05-27T18:30:00.123456Z"
  end

  test "last_seen_at: nil surfaces the no-cookie-session honesty signal" do
    # Bootstrap-spawned session for a user credential whose browser
    # never logged in (operator boot path) has no cookie session —
    # nil signals "we have a live bouncer but no recent browser
    # touch", distinct from "browser logged in N seconds ago".
    entry = entry([])

    json = AdminWire.session_to_admin_json(entry, "vjt", nil, nil)

    assert json.last_seen_at == nil
  end

  test "session_to_admin_json/4 rejects non-DateTime non-nil last_seen_at at the guard" do
    entry = entry([])

    assert_raise FunctionClauseError, fn ->
      AdminWire.session_to_admin_json(entry, "vjt", "2026-01-01T00:00:00Z", nil)
    end
  end
end
