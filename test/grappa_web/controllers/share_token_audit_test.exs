defmodule GrappaWeb.ShareTokenAuditTest do
  @moduledoc """
  #1306 — the audit-trail arm of `POST /me/share-token`.

  Split out of `GrappaWeb.ShareTokenControllerTest` (which stays
  `async: true`) because `Grappa.AdminEvents` is an application-wide
  ring-buffer singleton: asserting "nothing was recorded" requires
  emptying it first, and that is not something an async module may do
  to its neighbours. Small `async: false` module rather than turning
  the whole controller suite serial for two tests.

  What it pins, and why both halves matter:

    * a USER self-mint records `:user_share_token_minted` — else a
      password-identity session is made portable with no trace.
    * a VISITOR self-mint records NOTHING — the deliberate asymmetry.
      Without this half, "record every mint" would pass too, and the
      reasoning in `Grappa.AdminEvents.Wire`'s typedoc would silently
      stop being what the code does.
  """
  use GrappaWeb.ConnCase, async: false

  import Grappa.AuthFixtures

  alias Grappa.{AdminEvents, AdmissionStateHelpers}

  setup do
    AdmissionStateHelpers.reset_admin_events()
    :ok
  end

  describe "POST /me/share-token — admin register" do
    test "a user self-mint records :user_share_token_minted naming the user", %{conn: conn} do
      {user, session} = user_and_session()

      conn
      |> put_bearer(session.id)
      |> post("/me/share-token")
      |> json_response(200)

      assert [event] = AdminEvents.snapshot()
      assert event.kind == :user_share_token_minted
      assert event.user_id == user.id
      assert event.user_name == user.name
    end

    test "the recorded event carries no actor pair — it is a self-mint", %{conn: conn} do
      # Distinguishable at a glance from #982's admin-issued grant,
      # which names a third party. Uniformity here would erase the
      # distinction the register exists to make.
      {_, session} = user_and_session()

      conn |> put_bearer(session.id) |> post("/me/share-token") |> json_response(200)

      assert [event] = AdminEvents.snapshot()
      refute Map.has_key?(event, :actor_user_id)
      refute Map.has_key?(event, :actor_user_name)
    end

    test "an admin's self-mint is recorded like any other user's", %{conn: conn} do
      # The ruling admits admins with no exclusion, so the register must
      # not treat them specially either — no separate kind, no flag.
      {admin, session} = user_and_session(is_admin: true)

      conn |> put_bearer(session.id) |> post("/me/share-token") |> json_response(200)

      assert [event] = AdminEvents.snapshot()
      assert event.kind == :user_share_token_minted
      assert event.user_id == admin.id
    end

    test "a visitor self-mint records NOTHING", %{conn: conn} do
      # The asymmetry, asserted rather than assumed. A visitor share
      # hands out a visitor session — routine, and unattributed since
      # #392. Logging it too would spend the bounded ring on the routine
      # half.
      visitor = visitor_fixture()
      session = visitor_session_fixture(visitor)

      conn
      |> put_bearer(session.id)
      |> post("/me/share-token")
      |> json_response(200)

      assert AdminEvents.snapshot() == []
    end

    test "a refused incognito mint records nothing either", %{conn: conn} do
      # #363 — the 403 is not the whole story: a refusal that still left
      # an audit entry would read, in the console, as a grant that
      # happened.
      visitor = visitor_fixture(incognito: true)
      session = visitor_session_fixture(visitor)

      conn
      |> put_bearer(session.id)
      |> post("/me/share-token")
      |> json_response(403)

      assert AdminEvents.snapshot() == []
    end
  end
end
