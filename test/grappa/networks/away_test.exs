defmodule Grappa.Networks.AwayTest do
  @moduledoc """
  GH #417 — tests for the persisted EXPLICIT away snapshot
  (`away_reason` / `away_since` on `network_credentials`) that survives a
  session crash / `:transient` respawn / upstream reconnect.

  Three surfaces under test (the end-to-end restore + re-send-upstream
  behaviour lives in `Grappa.Session.ServerTest`'s away describe block):

    1. `Credentials.update_away/4` — id-keyed write used by
       Session.Server's `away_persister` closure. Sets the pair, clears
       it on `(nil, nil)`, `{:error, :not_found}` for an unknown subject.
    2. `Credential.away_changeset/3` — the narrow changeset + its
       `safe_line_token` wire-hygiene guard on `away_reason`.
    3. `SessionPlan.resolve/1` — threads the DB snapshot into the plan as
       `restored_away` + injects the `away_persister` closure (user-only).

  Async-safe: each test provisions a unique user/network via fixtures, so
  Repo sandbox isolation holds.
  """
  use Grappa.DataCase, async: true

  import Grappa.AuthFixtures

  alias Grappa.Networks
  alias Grappa.Networks.{Credential, Credentials, SessionPlan}

  describe "Credentials.update_away/4" do
    test "writes reason + since and round-trips on read" do
      {_, _, cred} = user_with_credential(6667, %{})
      assert cred.away_reason == nil
      assert cred.away_since == nil

      since = DateTime.utc_now()
      assert :ok = Credentials.update_away(cred.user_id, cred.network_id, "lunch", since)

      reloaded = reload_credential(cred)
      assert reloaded.away_reason == "lunch"
      # usec precision preserved (:utc_datetime_usec) — verbatim round-trip
      # is load-bearing for the mentions-window honesty.
      assert reloaded.away_since == since
    end

    test "clears the pair on (nil, nil) — the /back path" do
      {_, _, cred} = user_with_credential(6667, %{})
      :ok = Credentials.update_away(cred.user_id, cred.network_id, "gone", DateTime.utc_now())
      assert reload_credential(cred).away_reason == "gone"

      assert :ok = Credentials.update_away(cred.user_id, cred.network_id, nil, nil)

      reloaded = reload_credential(cred)
      assert reloaded.away_reason == nil
      assert reloaded.away_since == nil
    end

    test "{:error, :not_found} for an unknown (user, network)" do
      assert {:error, :not_found} =
               Credentials.update_away(Ecto.UUID.generate(), 999_999, "x", DateTime.utc_now())
    end
  end

  describe "Credential.away_changeset/3 wire-hygiene guard" do
    # away_reason is re-interpolated into `AWAY :<reason>` on reconnect, so
    # a CR/LF/NUL byte would split or truncate the outbound frame. The
    # `Session.set_explicit_away/3` facade already guards user input; this
    # is the OTHER door (defense-in-depth).
    test "rejects a reason carrying CR/LF/NUL" do
      {_, _, cred} = user_with_credential(6667, %{})

      for bad <- ["ha\r\nQUIT", "a\nb", "nul\0byte"] do
        cs = Credential.away_changeset(cred, bad, DateTime.utc_now())
        refute cs.valid?, "expected #{inspect(bad)} to be rejected"
        assert cs.errors[:away_reason]
      end
    end

    test "accepts a rest-of-line reason with spaces" do
      {_, _, cred} = user_with_credential(6667, %{})
      cs = Credential.away_changeset(cred, "out for lunch, back at 2pm", DateTime.utc_now())
      assert cs.valid?
    end

    test "the clear changeset (nil, nil) is valid" do
      {_, _, cred} = user_with_credential(6667, %{})
      assert Credential.away_changeset(cred, nil, nil).valid?
    end
  end

  describe "SessionPlan.resolve/1 away restore threading" do
    test "resolved plan carries restored_away = {reason, since} when persisted" do
      {_, _, cred} = user_with_credential(6667, %{})
      since = DateTime.utc_now()
      :ok = Credentials.update_away(cred.user_id, cred.network_id, "brb", since)

      {:ok, plan} = SessionPlan.resolve(reload_credential(cred))

      assert plan.restored_away == {"brb", since}
      # Persister injected for the user subject (Boundary-clean closure).
      assert is_function(plan.away_persister, 2)
    end

    test "resolved plan restored_away is nil when not away" do
      {_, _, cred} = user_with_credential(6667, %{})

      {:ok, plan} = SessionPlan.resolve(reload_credential(cred))

      assert plan.restored_away == nil
    end
  end

  describe "away lifecycle across connection-state transitions (#417 park-clear)" do
    # Ruling (vjt): a DELIBERATE park clears the away; an AUTOMATIC one keeps
    # it. The two paths are structurally distinct — `Networks.disconnect/2`
    # (the manual /disconnect + /quit + operator-CLI path, its only two
    # callers) sets :parked, while automatic transient drops stay :connected
    # and hard failures go :failed via `mark_failed/2`. So the clear lives in
    # disconnect/2 alone; nothing else touches the away columns.
    test "manual disconnect (/disconnect, /quit) clears the persisted away" do
      {_, _, cred} = user_with_credential(6667, %{})
      :ok = Credentials.update_away(cred.user_id, cred.network_id, "lunch", DateTime.utc_now())

      assert {:ok, updated} = Networks.disconnect(cred, "user-disconnect")
      assert updated.connection_state == :parked

      # The away columns are the persisted source of truth (not the returned
      # struct, whose away fields may be stale relative to the fresh clear) —
      # assert the DB row.
      reloaded = reload_credential(cred)
      assert reloaded.connection_state == :parked
      assert reloaded.away_reason == nil
      assert reloaded.away_since == nil
    end

    test "automatic mark_failed (k-line / permanent error) PRESERVES the persisted away" do
      {_, _, cred} = user_with_credential(6667, %{})
      since = DateTime.utc_now()
      :ok = Credentials.update_away(cred.user_id, cred.network_id, "brb", since)

      assert {:ok, updated} = Networks.mark_failed(cred, "k-line: G:Lined")
      assert updated.connection_state == :failed

      # A hard upstream failure is not user intent — the away survives in the
      # DB so a later recovery (/connect → restore → re-send) resumes it.
      reloaded = reload_credential(cred)
      assert reloaded.away_reason == "brb"
      assert reloaded.away_since == since
    end

    test "manual disconnect on a VISITOR credential is a safe no-op for away" do
      # Visitor away is never persisted, so the clear must be a no-op. The
      # user_id guard on `clear_away_on_manual_park/1` is load-bearing: without
      # it, `update_away/4`'s `is_binary(user_id)` guard would crash the
      # visitor disconnect — a real path via the phase-6 self-service
      # `PATCH /networks/:id`. This locks that guard down.
      {visitor, network} = visitor_with_network(6667)
      {:ok, cred} = Credentials.get_visitor_credential(visitor.id, network.id)

      assert {:ok, updated} = Networks.disconnect(cred, "user-disconnect")
      assert updated.connection_state == :parked
    end
  end
end
