defmodule Grappa.Accounts.SessionLogHygieneTest do
  @moduledoc """
  S9: the bearer token IS the `accounts_sessions` row id
  (`Grappa.Accounts.Session`), so it must never hit the log stream raw —
  log-read access is broader than DB access. `revoke_session/1` (and the
  private backward-clock `touch_session` warning) log a non-reversible
  SHA-256 handle instead of the token.

  `async: false` because it lowers the global Logger level to observe the
  :info revoke line (the test env runs at :warning) — same rationale as
  `Grappa.LogTest`, which is async: false precisely because it mutates
  process-global Logger state.
  """
  use Grappa.DataCase, async: false

  import ExUnit.CaptureLog

  alias Grappa.Accounts

  @password "correct horse battery staple"

  setup do
    original = Logger.level()
    Logger.configure(level: :info)
    on_exit(fn -> Logger.configure(level: original) end)
    :ok
  end

  test "revoke_session/1 logs a non-reversible handle, never the raw bearer token" do
    {:ok, user} =
      Accounts.create_user(%{
        name: "s9-#{System.unique_integer([:positive])}",
        password: @password
      })

    {:ok, session} = Accounts.create_session({:user, user.id}, nil, nil, [])
    token = session.id

    log = capture_log(fn -> assert :ok = Accounts.revoke_session(token) end)

    # The session-id IS the bearer token — it must NEVER appear raw.
    refute log =~ token
    # A stable, non-reversible SHA-256 handle rides instead (12 hex chars).
    assert log =~ ~r/session_ref=[0-9a-f]{12}\b/
  end
end
