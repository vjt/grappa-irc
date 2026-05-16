defmodule GrappaWeb.Admin.CircuitControllerTest do
  @moduledoc """
  `POST /admin/circuit/:network_id/reset` — admin-gated circuit
  clear (M-cluster M-5). Behind `:admin_authn`; visitor + non-admin
  user collapse to 403 upstream.

  ## Why three-class parity matrix is N/A

  Operator-facing endpoint. Per
  `feedback_e2e_user_class_parity_matrix`: USER-FACING IRC
  functions need the cross-class parity spec; this verb is
  operator-only and gate behavior is M-2's surface.

  ## Test isolation

  `async: false` — singleton `Grappa.Admission.NetworkCircuit` ETS
  table. `AdmissionStateHelpers.reset_network_circuit/0` in setup
  so each test starts clean.
  """
  use GrappaWeb.ConnCase, async: false

  import Grappa.AuthFixtures

  alias Grappa.{Accounts, AdmissionStateHelpers, Networks}
  alias Grappa.Admission.NetworkCircuit

  setup do
    AdmissionStateHelpers.reset_network_circuit()
    :ok
  end

  defp admin_session do
    {user, session} = user_and_session()
    {:ok, _} = Accounts.update_admin_flags(user, %{is_admin: true})
    session
  end

  describe "POST /admin/circuit/:network_id/reset — auth gate" do
    test "no bearer returns 401", %{conn: conn} do
      conn = post(conn, "/admin/circuit/1/reset")
      assert json_response(conn, 401) == %{"error" => "unauthorized"}
    end

    test "visitor subject returns 403", %{conn: conn} do
      {_, session} = visitor_and_session()
      conn = conn |> put_bearer(session.id) |> post("/admin/circuit/1/reset")
      assert json_response(conn, 403) == %{"error" => "forbidden"}
    end

    test "non-admin user returns 403", %{conn: conn} do
      {_, session} = user_and_session()
      conn = conn |> put_bearer(session.id) |> post("/admin/circuit/1/reset")
      assert json_response(conn, 403) == %{"error" => "forbidden"}
    end
  end

  describe "POST /admin/circuit/:network_id/reset — admin user" do
    test "200 + circuit_state nil after clearing an open circuit", %{conn: conn} do
      slug = "c-reset-#{System.unique_integer([:positive])}"
      {:ok, net} = Networks.find_or_create_network(%{slug: slug})

      for _ <- 1..NetworkCircuit.threshold() do
        :ok = NetworkCircuit.record_failure(net.id)
      end

      _ = :sys.get_state(NetworkCircuit)
      assert {:error, :open, _} = NetworkCircuit.check(net.id)

      session = admin_session()

      conn = conn |> put_bearer(session.id) |> post("/admin/circuit/#{net.id}/reset")

      body = json_response(conn, 200)
      assert body["network_id"] == net.id
      assert body["circuit_state"] == nil
      assert NetworkCircuit.check(net.id) == :ok
    end

    test "404 on unknown network id", %{conn: conn} do
      session = admin_session()
      conn = conn |> put_bearer(session.id) |> post("/admin/circuit/999999999/reset")
      assert json_response(conn, 404) == %{"error" => "not_found"}
    end

    test "400 on non-integer network id", %{conn: conn} do
      session = admin_session()
      conn = conn |> put_bearer(session.id) |> post("/admin/circuit/abc/reset")
      assert json_response(conn, 400) == %{"error" => "bad_request"}
    end
  end
end
