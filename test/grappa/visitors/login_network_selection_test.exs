defmodule Grappa.Visitors.LoginNetworkSelectionTest do
  @moduledoc """
  #211 phase 3 — runtime visitor allowlist + multi-network entry in
  `Grappa.Visitors.Login`. Replaces the compile-time `:visitor_network`
  pin. These tests cover the network-RESOLUTION branch only (allowlist
  gate + default-to-sole-enabled + ambiguity), stopping before the spawn
  (no IRC server) so they assert the resolver's error surface directly.
  """
  use Grappa.DataCase, async: false

  import Grappa.AuthFixtures

  alias Grappa.{AdmissionStateHelpers, Networks}
  alias Grappa.Visitors.Login

  setup do
    AdmissionStateHelpers.reset_network_circuit()
    :ok
  end

  defp login_input(overrides \\ %{}) do
    Map.merge(
      %{
        nick: "vjt",
        password: nil,
        ident: nil,
        realname: nil,
        ip: "1.2.3.4",
        user_agent: "ua",
        token: nil,
        captcha_token: nil,
        client_id: nil,
        network: nil
      },
      overrides
    )
  end

  describe "runtime visitor_enabled allowlist gate" do
    test "no visitor_enabled network at all → :network_unconfigured" do
      _ = network_fixture(slug: "disabled")
      assert {:error, :network_unconfigured} = Login.login(login_input(), [])
    end

    test "explicit slug that exists but is NOT visitor_enabled → :network_not_visitor_enabled" do
      _ = network_fixture(slug: "members-only")

      assert {:error, :network_not_visitor_enabled} =
               Login.login(login_input(%{network: "members-only"}), [])
    end

    test "explicit slug that does not exist → :network_unconfigured" do
      {:ok, _} = Networks.create_network(%{slug: "azzurra", visitor_enabled: true})

      assert {:error, :network_unconfigured} =
               Login.login(login_input(%{network: "ghost"}), [])
    end
  end

  describe "default-to-anchor (no network param — today's cic, #211 phase 6)" do
    test "more than one visitor_enabled network, NONE autoconnect, no slug → :network_ambiguous" do
      # Neither is flagged autoconnect → no anchor to pick → the
      # pre-phase-6 sole-enabled fallback fires → ambiguous.
      {:ok, _} = Networks.create_network(%{slug: "aaa", visitor_enabled: true})
      {:ok, _} = Networks.create_network(%{slug: "bbb", visitor_enabled: true})

      assert {:error, :network_ambiguous} = Login.login(login_input(), [])
    end

    test "#211 phase 6 — multiple visitor_enabled with an autoconnect anchor resolves (no ambiguity)" do
      # The anchor is picked from the visitor_autoconnect set (first by
      # slug), so multiple enabled networks no longer 400 without a slug —
      # login proceeds to the anchor (:no_server proves it resolved).
      {:ok, _} = Networks.create_network(%{slug: "zzz", visitor_enabled: true})

      {:ok, _} =
        Networks.create_network(%{slug: "anchor", visitor_enabled: true, visitor_autoconnect: true})

      assert {:error, :no_server} = Login.login(login_input(), [])
    end

    test "sole visitor_enabled network with no slug resolves it (reaches :no_server, no IRC fake)" do
      # visitor_enabled but no server → the allowlist admits it and the
      # flow proceeds to SessionPlan.resolve, which fails :no_server. That
      # the error is :no_server (not a network-resolution error) proves the
      # sole-enabled default resolved the network.
      {:ok, _} = Networks.create_network(%{slug: "azzurra", visitor_enabled: true})

      assert {:error, :no_server} = Login.login(login_input(), [])
    end

    test "explicit slug for a visitor_enabled network resolves it even when others exist" do
      {:ok, _} = Networks.create_network(%{slug: "aaa", visitor_enabled: true})
      {:ok, _} = Networks.create_network(%{slug: "target", visitor_enabled: true})

      # Ambiguity is avoided by naming the network; it has no server so we
      # land on :no_server (proving the named network resolved).
      assert {:error, :no_server} = Login.login(login_input(%{network: "target"}), [])
    end
  end
end
