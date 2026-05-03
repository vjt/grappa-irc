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

  test "sets both --max-sessions and --max-per-client", %{network: network} do
    output =
      capture_io(fn ->
        SetNetworkCaps.run([
          "--network",
          "azzurra",
          "--max-sessions",
          "3",
          "--max-per-client",
          "1"
        ])
      end)

    assert output =~ "set caps on azzurra: max_concurrent_sessions=3 max_per_client=1"

    refreshed = Networks.get_network_by_slug!(network.slug)
    assert refreshed.max_concurrent_sessions == 3
    assert refreshed.max_per_client == 1
  end

  test "updates only the cap flags supplied; preserves the rest" do
    {:ok, _} =
      Networks.update_network_caps(Networks.get_network_by_slug!("azzurra"), %{
        max_concurrent_sessions: 5,
        max_per_client: 2
      })

    capture_io(fn ->
      SetNetworkCaps.run(["--network", "azzurra", "--max-sessions", "10"])
    end)

    refreshed = Networks.get_network_by_slug!("azzurra")
    assert refreshed.max_concurrent_sessions == 10
    assert refreshed.max_per_client == 2
  end

  test "raises when the network slug is unknown" do
    assert_raise Ecto.NoResultsError, fn ->
      capture_io(fn ->
        SetNetworkCaps.run(["--network", "ghost", "--max-sessions", "3"])
      end)
    end
  end

  test "raises when --network is missing" do
    assert_raise KeyError, fn ->
      capture_io(fn ->
        SetNetworkCaps.run(["--max-sessions", "3"])
      end)
    end
  end

  test "raises when no cap flag is supplied" do
    assert_raise Mix.Error, fn ->
      capture_io(fn ->
        SetNetworkCaps.run(["--network", "azzurra"])
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
        "--max-sessions",
        "7",
        "--max-per-client",
        "2"
      ])
    end)

    assert %Network{max_concurrent_sessions: 7, max_per_client: 2} =
             Networks.get_network!(network.id)
  end
end
