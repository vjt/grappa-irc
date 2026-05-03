defmodule Grappa.AdmissionTest do
  @moduledoc """
  Verb-level tests for Grappa.Admission.check_capacity/1. Covers
  each cap dimension and the bypass paths (Bootstrap flows skip
  client-cap because no client_id).
  """
  use Grappa.DataCase, async: false

  alias Grappa.Admission
  alias Grappa.Admission.NetworkCircuit

  setup do
    for {key, _, _, _, _} <- NetworkCircuit.entries(),
        do: :ets.delete(:admission_network_circuit_state, key)

    # network_with_server/1 requires :port (Keyword.fetch!) and returns
    # a {Network.t(), Server.t()} tuple — pin both at the test boundary.
    {network, _} = Grappa.AuthFixtures.network_with_server(port: 6_667)
    {:ok, network: network}
  end

  describe "check_capacity/1 — network circuit gate" do
    test "open circuit short-circuits with :network_circuit_open", %{network: net} do
      for _ <- 1..NetworkCircuit.threshold() do
        :ok = NetworkCircuit.record_failure(net.id)
      end

      _ = :sys.get_state(NetworkCircuit)

      input = %{
        subject_kind: :visitor,
        subject_id: nil,
        network_id: net.id,
        client_id: "device-a",
        flow: :login_fresh
      }

      assert {:error, :network_circuit_open} = Admission.check_capacity(input)
    end
  end

  describe "check_capacity/1 — network total cap" do
    test "nil cap = uncapped", %{network: net} do
      input = %{
        subject_kind: :visitor,
        subject_id: nil,
        network_id: net.id,
        client_id: "device-a",
        flow: :login_fresh
      }

      assert :ok = Admission.check_capacity(input)
    end

    test "exceeded → :network_cap_exceeded", %{network: net} do
      # Task 4 changeset rejects max_concurrent_sessions: 0 (validate_number
      # greater_than: 0). Use cap=1 + register one fake live-session entry
      # in SessionRegistry so Registry.count_select returns 1, tripping the
      # cap. The fake key MUST go through `Server.registry_key/2` so the
      # match-spec in `count_live_sessions/1` actually matches — registering
      # a hand-rolled tuple bypasses the production registrar and makes the
      # test pass while encoding the bug. Registry entry is auto-removed
      # when the test pid exits.
      {:ok, net} =
        net
        |> Grappa.Networks.Network.changeset(%{max_concurrent_sessions: 1})
        |> Grappa.Repo.update()

      {:ok, _} =
        Registry.register(
          Grappa.SessionRegistry,
          Grappa.Session.Server.registry_key({:visitor, "fake-vid"}, net.id),
          nil
        )

      input = %{
        subject_kind: :visitor,
        subject_id: nil,
        network_id: net.id,
        client_id: "device-a",
        flow: :login_fresh
      }

      assert {:error, :network_cap_exceeded} = Admission.check_capacity(input)
    end
  end

  describe "check_capacity/1 — Bootstrap paths skip client cap" do
    test ":bootstrap_user with nil client_id is :ok", %{network: net} do
      input = %{
        subject_kind: :user,
        subject_id: Ecto.UUID.generate(),
        network_id: net.id,
        client_id: nil,
        flow: :bootstrap_user
      }

      assert :ok = Admission.check_capacity(input)
    end

    test ":bootstrap_visitor with nil client_id is :ok", %{network: net} do
      input = %{
        subject_kind: :visitor,
        subject_id: Ecto.UUID.generate(),
        network_id: net.id,
        client_id: nil,
        flow: :bootstrap_visitor
      }

      assert :ok = Admission.check_capacity(input)
    end
  end

  describe "verify_captcha/2 — Disabled provider" do
    test "always returns :ok" do
      assert :ok = Admission.verify_captcha("any-token", "1.2.3.4")
      assert :ok = Admission.verify_captcha(nil, nil)
      assert :ok = Admission.verify_captcha("", "1.2.3.4")
    end
  end
end
