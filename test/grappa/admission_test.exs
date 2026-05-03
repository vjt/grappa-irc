defmodule Grappa.AdmissionTest do
  @moduledoc """
  Verb-level tests for Grappa.Admission.check_capacity/1. Covers
  each cap dimension and the bypass paths (Bootstrap flows skip
  client-cap because no client_id).
  """
  use Grappa.DataCase, async: false

  alias Grappa.Admission
  alias Grappa.Admission.Captcha.{Disabled, HCaptcha, Turnstile}
  alias Grappa.Admission.{Config, NetworkCircuit}

  setup do
    for {key, _, _, _, _} <- NetworkCircuit.entries(),
        do: :ets.delete(:admission_network_circuit_state, key)

    # network_with_server/1 requires :port (Keyword.fetch!) and returns
    # a {Network.t(), Server.t()} tuple — pin both at the test boundary.
    {network, _} = Grappa.AuthFixtures.network_with_server(port: 6_667)
    {:ok, network: network}
  end

  describe "check_capacity/1 — network circuit gate" do
    test "open circuit short-circuits with {:network_circuit_open, retry_after}",
         %{network: net} do
      for _ <- 1..NetworkCircuit.threshold() do
        :ok = NetworkCircuit.record_failure(net.id)
      end

      _ = :sys.get_state(NetworkCircuit)

      input = %{
        subject_kind: :visitor,
        subject_id: nil,
        network_id: net.id,
        client_id: "44c2ab8a-cb38-4960-b92a-a7aefb190386",
        flow: :login_fresh
      }

      # Task 5: tuple shape carries retry_after seconds. Bare atom no
      # longer occurs at runtime — FallbackController emits Retry-After
      # header from the integer payload.
      assert {:error, {:network_circuit_open, retry_after}} =
               Admission.check_capacity(input)

      assert is_integer(retry_after) and retry_after >= 0
    end
  end

  describe "check_capacity/1 — network total cap" do
    test "nil cap = uncapped", %{network: net} do
      input = %{
        subject_kind: :visitor,
        subject_id: nil,
        network_id: net.id,
        client_id: "44c2ab8a-cb38-4960-b92a-a7aefb190386",
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
        client_id: "44c2ab8a-cb38-4960-b92a-a7aefb190386",
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

  # ---------------------------------------------------------------------------
  # captcha_provider_wire/0 — delegates to configured impl's wire_name/0
  # ---------------------------------------------------------------------------

  describe "captcha_provider_wire/0" do
    @pt_key {Config, :config}

    setup do
      original_pt = :persistent_term.get(@pt_key, :__unset__)
      original_env = Application.get_env(:grappa, :admission)

      on_exit(fn ->
        case original_pt do
          :__unset__ -> :persistent_term.erase(@pt_key)
          cfg -> :persistent_term.put(@pt_key, cfg)
        end

        if is_nil(original_env),
          do: Application.delete_env(:grappa, :admission),
          else: Application.put_env(:grappa, :admission, original_env)
      end)

      :ok
    end

    test "returns wire_name from configured impl module" do
      Config.put_test_config(%Config{
        captcha_provider: Turnstile,
        captcha_secret: "stub",
        captcha_site_key: "stub",
        turnstile_endpoint: "https://stub",
        hcaptcha_endpoint: "https://stub"
      })

      assert Admission.captcha_provider_wire() == "turnstile"

      Config.put_test_config(%Config{
        captcha_provider: HCaptcha,
        captcha_secret: "stub",
        captcha_site_key: "stub",
        turnstile_endpoint: "https://stub",
        hcaptcha_endpoint: "https://stub"
      })

      assert Admission.captcha_provider_wire() == "hcaptcha"

      Config.put_test_config(%Config{
        captcha_provider: Disabled,
        captcha_secret: nil,
        captcha_site_key: nil,
        turnstile_endpoint: "https://stub",
        hcaptcha_endpoint: "https://stub"
      })

      assert Admission.captcha_provider_wire() == "disabled"
    end
  end

  # ---------------------------------------------------------------------------
  # Telemetry — capacity_reject event
  # ---------------------------------------------------------------------------

  defp attach_reject_event do
    id = "admission-test-reject-#{System.unique_integer([:positive])}"
    test_pid = self()

    :ok =
      :telemetry.attach(
        id,
        [:grappa, :admission, :capacity, :reject],
        fn name, measurements, metadata, pid ->
          send(pid, {:telemetry, name, measurements, metadata})
        end,
        test_pid
      )

    on_exit(fn -> :telemetry.detach(id) end)
    id
  end

  describe "check_capacity/1 — telemetry capacity_reject events" do
    test "emits :capacity, :reject when circuit open", %{network: net} do
      attach_reject_event()

      for _ <- 1..NetworkCircuit.threshold() do
        :ok = NetworkCircuit.record_failure(net.id)
      end

      _ = :sys.get_state(NetworkCircuit)

      input = %{
        subject_kind: :visitor,
        subject_id: nil,
        network_id: net.id,
        client_id: "44c2ab8a-cb38-4960-b92a-a7aefb190386",
        flow: :login_fresh
      }

      assert {:error, {:network_circuit_open, _}} = Admission.check_capacity(input)

      net_id = net.id

      assert_receive {:telemetry, [:grappa, :admission, :capacity, :reject], %{},
                      %{
                        flow: :login_fresh,
                        error: {:network_circuit_open, _},
                        network_id: ^net_id,
                        client_id: "44c2ab8a-cb38-4960-b92a-a7aefb190386"
                      }},
                     500
    end

    test "emits :capacity, :reject when network cap exceeded", %{network: net} do
      attach_reject_event()

      {:ok, capped_net} =
        net
        |> Grappa.Networks.Network.changeset(%{max_concurrent_sessions: 1})
        |> Grappa.Repo.update()

      {:ok, _} =
        Registry.register(
          Grappa.SessionRegistry,
          Grappa.Session.Server.registry_key({:visitor, "fake-vid"}, capped_net.id),
          nil
        )

      input = %{
        subject_kind: :visitor,
        subject_id: nil,
        network_id: capped_net.id,
        client_id: "11111111-2222-4333-8444-555555555555",
        flow: :login_fresh
      }

      assert {:error, :network_cap_exceeded} = Admission.check_capacity(input)

      net_id = capped_net.id

      assert_receive {:telemetry, [:grappa, :admission, :capacity, :reject], %{},
                      %{
                        flow: :login_fresh,
                        error: :network_cap_exceeded,
                        network_id: ^net_id,
                        client_id: "11111111-2222-4333-8444-555555555555"
                      }},
                     500
    end

    test "does NOT emit :capacity, :reject on :ok", %{network: net} do
      attach_reject_event()

      input = %{
        subject_kind: :visitor,
        subject_id: nil,
        network_id: net.id,
        client_id: "99999999-aaaa-4bbb-8ccc-dddddddddddd",
        flow: :login_fresh
      }

      assert :ok = Admission.check_capacity(input)

      refute_receive {:telemetry, [:grappa, :admission, :capacity, :reject], _, _}, 100
    end
  end
end
