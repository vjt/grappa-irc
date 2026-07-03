defmodule Mix.Tasks.Grappa.SetNetworkCapsTest do
  # async: false — task starts the app + writes via Cloak.Vault-using
  # Repo. See add_server_test.exs for rationale.
  use Grappa.DataCase, async: false

  import ExUnit.CaptureIO

  alias Grappa.Networks
  alias Grappa.Networks.Network
  alias Mix.Tasks.Grappa.SetNetworkCaps

  setup do
    {:ok, network} = Networks.find_or_create_network(%{slug: "azzurra"})
    %{network: network}
  end

  test "sets all three caps (visitor + user + per_client)", %{network: network} do
    output =
      capture_io(fn ->
        SetNetworkCaps.run([
          "--network",
          "azzurra",
          "--max-visitor-sessions",
          "3",
          "--max-user-sessions",
          "5",
          "--max-per-ip",
          "1"
        ])
      end)

    assert output =~
             "set caps on azzurra: max_concurrent_visitor_sessions=3 max_concurrent_user_sessions=5 max_per_ip=1"

    refreshed = Networks.get_network_by_slug!(network.slug)
    assert refreshed.max_concurrent_visitor_sessions == 3
    assert refreshed.max_concurrent_user_sessions == 5
    assert refreshed.max_per_ip == 1
  end

  test "updates only the cap flags supplied; preserves the rest" do
    {:ok, _} =
      Networks.update_network_caps(Networks.get_network_by_slug!("azzurra"), %{
        max_concurrent_visitor_sessions: 5,
        max_per_ip: 2
      })

    capture_io(fn ->
      SetNetworkCaps.run(["--network", "azzurra", "--max-visitor-sessions", "10"])
    end)

    refreshed = Networks.get_network_by_slug!("azzurra")
    assert refreshed.max_concurrent_visitor_sessions == 10
    assert refreshed.max_per_ip == 2
    # NULL DEFAULT 3 on the schema (post-U-1) — operator unset =
    # schema default applies.
    assert refreshed.max_concurrent_user_sessions == 3
  end

  test "raises Mix.Error with friendly message when the network slug is unknown" do
    assert_raise Mix.Error, ~r/network "ghost" not found/, fn ->
      capture_io(fn ->
        SetNetworkCaps.run(["--network", "ghost", "--max-visitor-sessions", "3"])
      end)
    end
  end

  test "raises Mix.Error with friendly message when --network is missing" do
    assert_raise Mix.Error, ~r/--network <slug> is required/, fn ->
      capture_io(fn ->
        SetNetworkCaps.run(["--max-visitor-sessions", "3"])
      end)
    end
  end

  test "raises when no cap flag is supplied" do
    assert_raise Mix.Error, ~r/no changes specified/, fn ->
      capture_io(fn ->
        SetNetworkCaps.run(["--network", "azzurra"])
      end)
    end
  end

  test "--clear-max-visitor-sessions clears the cap", %{network: network} do
    {:ok, _} =
      Networks.update_network_caps(network, %{
        max_concurrent_visitor_sessions: 5,
        max_per_ip: 2
      })

    capture_io(fn ->
      SetNetworkCaps.run(["--network", "azzurra", "--clear-max-visitor-sessions"])
    end)

    refreshed = Networks.get_network_by_slug!("azzurra")
    assert is_nil(refreshed.max_concurrent_visitor_sessions)
    # symmetry: the unsupplied cap is preserved
    assert refreshed.max_per_ip == 2
  end

  test "--clear-max-user-sessions clears the cap", %{network: network} do
    {:ok, _} =
      Networks.update_network_caps(network, %{
        max_concurrent_user_sessions: 7,
        max_per_ip: 2
      })

    capture_io(fn ->
      SetNetworkCaps.run(["--network", "azzurra", "--clear-max-user-sessions"])
    end)

    refreshed = Networks.get_network_by_slug!("azzurra")
    assert is_nil(refreshed.max_concurrent_user_sessions)
    assert refreshed.max_per_ip == 2
  end

  test "--clear-max-per-ip clears the cap", %{network: network} do
    {:ok, _} =
      Networks.update_network_caps(network, %{
        max_concurrent_visitor_sessions: 5,
        max_per_ip: 2
      })

    capture_io(fn ->
      SetNetworkCaps.run(["--network", "azzurra", "--clear-max-per-ip"])
    end)

    refreshed = Networks.get_network_by_slug!("azzurra")
    assert is_nil(refreshed.max_per_ip)
    assert refreshed.max_concurrent_visitor_sessions == 5
  end

  test "--clear-max-visitor-sessions and --max-visitor-sessions are mutually exclusive" do
    assert_raise Mix.Error, ~r/mutually exclusive/, fn ->
      capture_io(fn ->
        SetNetworkCaps.run([
          "--network",
          "azzurra",
          "--max-visitor-sessions",
          "5",
          "--clear-max-visitor-sessions"
        ])
      end)
    end
  end

  test "--clear-max-user-sessions and --max-user-sessions are mutually exclusive" do
    assert_raise Mix.Error, ~r/mutually exclusive/, fn ->
      capture_io(fn ->
        SetNetworkCaps.run([
          "--network",
          "azzurra",
          "--max-user-sessions",
          "5",
          "--clear-max-user-sessions"
        ])
      end)
    end
  end

  test "--clear-max-per-ip and --max-per-ip are mutually exclusive" do
    assert_raise Mix.Error, ~r/mutually exclusive/, fn ->
      capture_io(fn ->
        SetNetworkCaps.run([
          "--network",
          "azzurra",
          "--max-per-ip",
          "5",
          "--clear-max-per-ip"
        ])
      end)
    end
  end

  test "ensures the row was actually persisted (round-trip via fresh Repo read)", %{
    network: network
  } do
    capture_io(fn ->
      SetNetworkCaps.run([
        "--network",
        "azzurra",
        "--max-visitor-sessions",
        "7",
        "--max-user-sessions",
        "11",
        "--max-per-ip",
        "2"
      ])
    end)

    assert %Network{
             max_concurrent_visitor_sessions: 7,
             max_concurrent_user_sessions: 11,
             max_per_ip: 2
           } = Networks.get_network!(network.id)
  end
end
