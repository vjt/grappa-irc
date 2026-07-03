defmodule Grappa.AdmissionTest do
  @moduledoc """
  Verb-level tests for Grappa.Admission.check_capacity/1. Covers each
  cap dimension (circuit, per-network total, per-source-IP) and the
  bypass path (Bootstrap flows carry `source_ip: nil`, so the per-IP cap
  skips).
  """
  use Grappa.DataCase, async: false

  alias Grappa.{Admission, AdmissionStateHelpers, Repo, SessionRegistry}
  alias Grappa.Admission.Captcha.{Disabled, HCaptcha, Turnstile}
  alias Grappa.Admission.{Config, NetworkCircuit}
  alias Grappa.Networks.Network
  alias Grappa.Session.Server, as: SessionServer

  setup do
    AdmissionStateHelpers.reset_network_circuit()

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
        network_id: net.id,
        source_ip: nil,
        flow: :login_fresh,
        requesting_subject: nil
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
        network_id: net.id,
        source_ip: nil,
        flow: :login_fresh,
        requesting_subject: nil
      }

      assert :ok = Admission.check_capacity(input)
    end

    test "visitor cap exceeded by visitor session → :visitor_cap_exceeded",
         %{network: net} do
      # U-2: subject-aware split. Visitor flow consults
      # max_concurrent_visitor_sessions; the registry counts live
      # visitor sessions only. Hand-registered key MUST go through
      # `Server.registry_key/2` + correct subject shape so the
      # production match-spec actually matches.
      {:ok, net} =
        net
        |> Network.changeset(%{max_concurrent_visitor_sessions: 1})
        |> Repo.update()

      register_for_test({:visitor, "fake-vid"}, net.id)

      input = %{
        network_id: net.id,
        source_ip: nil,
        flow: :login_fresh,
        requesting_subject: nil
      }

      assert {:error, :visitor_cap_exceeded} = Admission.check_capacity(input)
    end

    test "user cap exceeded by user session → :user_cap_exceeded",
         %{network: net} do
      # U-2: user flow consults max_concurrent_user_sessions; only
      # `{:user, _}` registry entries count toward it.
      {:ok, net} =
        net
        |> Network.changeset(%{max_concurrent_user_sessions: 1})
        |> Repo.update()

      register_for_test({:user, "fake-uid"}, net.id)

      input = %{
        network_id: net.id,
        source_ip: nil,
        flow: :patch_network_connect,
        requesting_subject: nil
      }

      assert {:error, :user_cap_exceeded} = Admission.check_capacity(input)
    end

    test "visitor cap full does NOT block user flow", %{network: net} do
      # U-2: caps are independent per subject_kind. A visitor cap
      # exhausted by visitor sessions must not reject a user-flow
      # admission check.
      {:ok, net} =
        net
        |> Network.changeset(%{
          max_concurrent_visitor_sessions: 1,
          max_concurrent_user_sessions: 5
        })
        |> Repo.update()

      register_for_test({:visitor, "fake-vid"}, net.id)

      input = %{
        network_id: net.id,
        source_ip: nil,
        flow: :patch_network_connect,
        requesting_subject: nil
      }

      assert :ok = Admission.check_capacity(input)
    end

    test "user cap full does NOT block visitor flow", %{network: net} do
      # U-2: mirror — user cap exhausted does not reject a visitor.
      {:ok, net} =
        net
        |> Network.changeset(%{
          max_concurrent_visitor_sessions: 5,
          max_concurrent_user_sessions: 1
        })
        |> Repo.update()

      register_for_test({:user, "fake-uid"}, net.id)

      input = %{
        network_id: net.id,
        source_ip: nil,
        flow: :login_fresh,
        requesting_subject: nil
      }

      assert :ok = Admission.check_capacity(input)
    end

    test "user cap nil = uncapped (matches visitor nil semantics)",
         %{network: net} do
      {:ok, net} =
        net
        |> Network.changeset(%{max_concurrent_user_sessions: nil})
        |> Repo.update()

      input = %{
        network_id: net.id,
        source_ip: nil,
        flow: :patch_network_connect,
        requesting_subject: nil
      }

      assert :ok = Admission.check_capacity(input)
    end
  end

  describe "check_capacity/1 — Bootstrap paths skip the per-IP cap (nil source_ip)" do
    test ":bootstrap_user with nil source_ip is :ok", %{network: net} do
      input = %{
        network_id: net.id,
        source_ip: nil,
        flow: :bootstrap_user,
        requesting_subject: nil
      }

      assert :ok = Admission.check_capacity(input)
    end

    test ":bootstrap_visitor with nil source_ip is :ok", %{network: net} do
      input = %{
        network_id: net.id,
        source_ip: nil,
        flow: :bootstrap_visitor,
        requesting_subject: nil
      }

      assert :ok = Admission.check_capacity(input)
    end
  end

  describe "check_capacity/1 — per-source-IP clone cap (#171)" do
    # #171: the ONLY per-actor cap. Visitor / unauthenticated flows have
    # no stable client identity, so the source IP is the durable per-actor
    # handle; a single IP could otherwise open arbitrary concurrent
    # sessions (7 observed live). Keyed on the persisted
    # `accounts_sessions.ip` against `max_per_ip`, applied to ALL flows:
    # DISTINCT subjects, network-bound, non-revoked, self-excluding the
    # requesting subject, subject-kind disjoint (visitor JOINs visitors,
    # user JOINs credentials).
    @ip171 "203.0.113.7"

    test "2nd DISTINCT visitor subject from the same ip past cap → :ip_cap_exceeded",
         %{network: net} do
      {:ok, net} =
        net
        |> Network.changeset(%{max_per_ip: 1})
        |> Repo.update()

      {:ok, visitor} =
        Grappa.Visitors.find_or_provision_anon("ip171-first", net.slug, @ip171)

      {:ok, _} =
        Grappa.Accounts.create_session({:visitor, visitor.id}, @ip171, "ua", [])

      # A DIFFERENT (fresh anon) subject logging in from the same ip:
      # count of existing distinct visitor subjects on @ip171 = 1 >= cap 1.
      input = %{
        network_id: net.id,
        source_ip: @ip171,
        flow: :login_fresh,
        requesting_subject: nil
      }

      assert {:error, :ip_cap_exceeded} = Admission.check_capacity(input)
    end

    test "an anon visitor with NO client-id is capped purely by ip",
         %{network: net} do
      # The core #171 scenario: an anon login carries no X-Grappa-Client-Id
      # (the old per-client cap short-circuited to :ok and admitted an
      # unbounded clone flood). The source-IP cap catches it regardless of
      # client identity.
      {:ok, net} =
        net
        |> Network.changeset(%{max_per_ip: 1})
        |> Repo.update()

      {:ok, visitor} =
        Grappa.Visitors.find_or_provision_anon("ip171-nilclient", net.slug, @ip171)

      # Existing session carries NO client_id — the source IP is the only
      # handle the cap has.
      {:ok, _} =
        Grappa.Accounts.create_session({:visitor, visitor.id}, @ip171, "ua", [])

      input = %{
        network_id: net.id,
        source_ip: @ip171,
        flow: :login_fresh,
        requesting_subject: nil
      }

      assert {:error, :ip_cap_exceeded} = Admission.check_capacity(input)
    end

    test "nil source_ip → ip cap skipped (mirrors nil-client skip)", %{network: net} do
      {:ok, net} =
        net
        |> Network.changeset(%{max_per_ip: 1})
        |> Repo.update()

      {:ok, visitor} =
        Grappa.Visitors.find_or_provision_anon("ip171-nilip", net.slug, @ip171)

      {:ok, _} =
        Grappa.Accounts.create_session({:visitor, visitor.id}, @ip171, "ua", [])

      # nil client AND nil source_ip → both device-scoped caps skip.
      input = %{
        network_id: net.id,
        source_ip: nil,
        flow: :login_fresh,
        requesting_subject: nil
      }

      assert :ok = Admission.check_capacity(input)
    end

    test "requesting subject's own ip session does NOT count toward its own cap (self-exclusion)",
         %{network: net} do
      # UX-5 bucket BC mirror on the ip dimension: a visitor re-spawning
      # from the same ip must not be blocked by its own pre-existing
      # accounts_session row.
      {:ok, net} =
        net
        |> Network.changeset(%{max_per_ip: 1})
        |> Repo.update()

      {:ok, visitor} =
        Grappa.Visitors.find_or_provision_anon("ip171-self", net.slug, @ip171)

      {:ok, _} =
        Grappa.Accounts.create_session({:visitor, visitor.id}, @ip171, "ua", [])

      input = %{
        network_id: net.id,
        source_ip: @ip171,
        flow: :login_existing,
        requesting_subject: {:visitor, visitor.id}
      }

      assert :ok = Admission.check_capacity(input)
    end

    test "revoked session on the ip does NOT count toward cap", %{network: net} do
      {:ok, net} =
        net
        |> Network.changeset(%{max_per_ip: 1})
        |> Repo.update()

      {:ok, visitor} =
        Grappa.Visitors.find_or_provision_anon("ip171-revoked", net.slug, @ip171)

      {:ok, vsession} =
        Grappa.Accounts.create_session({:visitor, visitor.id}, @ip171, "ua", [])

      :ok = Grappa.Accounts.revoke_session(vsession.id)

      input = %{
        network_id: net.id,
        source_ip: @ip171,
        flow: :login_fresh,
        requesting_subject: nil
      }

      assert :ok = Admission.check_capacity(input)
    end

    test "a user ip-row does NOT cap a visitor flow (cross-clause disjointness)",
         %{network: net} do
      # The visitor clause JOINs visitors; a user session on the same ip
      # is invisible to it. A user flooding user-sessions must not spend a
      # visitor's ip budget and vice versa — same disjointness the client
      # cap guarantees.
      {:ok, net} =
        net
        |> Network.changeset(%{max_per_ip: 1})
        |> Repo.update()

      user = Grappa.AuthFixtures.user_fixture(name: "ip171-user-#{System.unique_integer([:positive])}")
      _ = Grappa.AuthFixtures.credential_fixture(user, net)

      {:ok, _} =
        Grappa.Accounts.create_session({:user, user.id}, @ip171, "ua", [])

      input = %{
        network_id: net.id,
        source_ip: @ip171,
        flow: :login_fresh,
        requesting_subject: nil
      }

      assert :ok = Admission.check_capacity(input)
    end

    test "a visitor ip-row does NOT cap a user flow (cross-clause disjointness mirror)",
         %{network: net} do
      {:ok, net} =
        net
        |> Network.changeset(%{max_per_ip: 1})
        |> Repo.update()

      {:ok, visitor} =
        Grappa.Visitors.find_or_provision_anon("ip171-xvis", net.slug, @ip171)

      {:ok, _} =
        Grappa.Accounts.create_session({:visitor, visitor.id}, @ip171, "ua", [])

      user = Grappa.AuthFixtures.user_fixture(name: "ip171-xuser-#{System.unique_integer([:positive])}")
      _ = Grappa.AuthFixtures.credential_fixture(user, net)

      input = %{
        network_id: net.id,
        source_ip: @ip171,
        flow: :patch_network_connect,
        requesting_subject: {:user, user.id}
      }

      assert :ok = Admission.check_capacity(input)
    end

    test "visitor on a DIFFERENT network's slug does NOT count toward this network's ip cap",
         %{network: net} do
      # Mirror of the client-cap MED-2 guard: the visitor clause filters
      # `v.network_slug == ^slug`, so a same-ip visitor pinned to another
      # network must not consume this network's ip budget.
      {:ok, net} =
        net
        |> Network.changeset(%{max_per_ip: 1})
        |> Repo.update()

      {other_net, _} =
        Grappa.AuthFixtures.network_with_server(
          port: 6_669,
          slug: "ip171-other-#{System.unique_integer([:positive])}"
        )

      {:ok, other_visitor} =
        Grappa.Visitors.find_or_provision_anon("ip171-other", other_net.slug, @ip171)

      {:ok, _} =
        Grappa.Accounts.create_session({:visitor, other_visitor.id}, @ip171, "ua", [])

      input = %{
        network_id: net.id,
        source_ip: @ip171,
        flow: :login_fresh,
        requesting_subject: nil
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
        network_id: net.id,
        source_ip: "203.0.113.9",
        flow: :login_fresh,
        requesting_subject: nil
      }

      assert {:error, {:network_circuit_open, _}} = Admission.check_capacity(input)

      net_id = net.id

      assert_receive {:telemetry, [:grappa, :admission, :capacity, :reject], %{},
                      %{
                        flow: :login_fresh,
                        error: {:network_circuit_open, _},
                        network_id: ^net_id,
                        source_ip: "203.0.113.9"
                      }},
                     500
    end

    test "emits :capacity, :reject when network cap exceeded", %{network: net} do
      attach_reject_event()

      {:ok, capped_net} =
        net
        |> Network.changeset(%{max_concurrent_visitor_sessions: 1})
        |> Repo.update()

      register_for_test({:visitor, "fake-vid"}, capped_net.id)

      input = %{
        network_id: capped_net.id,
        source_ip: "203.0.113.10",
        flow: :login_fresh,
        requesting_subject: nil
      }

      assert {:error, :visitor_cap_exceeded} = Admission.check_capacity(input)

      net_id = capped_net.id

      assert_receive {:telemetry, [:grappa, :admission, :capacity, :reject], %{},
                      %{
                        flow: :login_fresh,
                        error: :visitor_cap_exceeded,
                        network_id: ^net_id,
                        source_ip: "203.0.113.10"
                      }},
                     500
    end

    test "does NOT emit :capacity, :reject on :ok", %{network: net} do
      attach_reject_event()

      input = %{
        network_id: net.id,
        source_ip: nil,
        flow: :login_fresh,
        requesting_subject: nil
      }

      assert :ok = Admission.check_capacity(input)

      refute_receive {:telemetry, [:grappa, :admission, :capacity, :reject], _, _}, 100
    end
  end

  describe "live_counts_for_network/1 — U-3 admin wire projection" do
    # U-3 (Web M3): SessionRegistry is process-global and async tests
    # in other modules can register `{:session, {subject, network_id}, ...}`
    # entries against the same auto-increment id sqlite hands back
    # inside their own sandbox connection (sqlite reuses id=1 for the
    # first row in every per-test sandbox). Reading via the `net.id`
    # from the shared fixture would observe cross-test residue. Use
    # synthetic high integers per test that no factory would ever
    # produce — `live_counts_for_network/1` accepts any integer
    # (no DB lookup required).
    #
    # Test pid registrations auto-clean on pid exit, but the link-based
    # cleanup propagates asynchronously, which can leave `SessionRegistry`
    # non-empty briefly between tests and trip the 15s
    # `reset_session_supervisor` poll in sibling test suites (see
    # `project_network_circuit_ets_leak`). Every test that hand-
    # registers entries here uses `register_for_test/2` so the
    # `on_exit` synchronously unregisters before the next test runs.
    test "returns zeros for a network with no live sessions" do
      synthetic_network_id = unique_synthetic_network_id()
      assert Admission.live_counts_for_network(synthetic_network_id) == %{visitors: 0, users: 0}
    end

    test "counts visitor + user sessions independently" do
      synthetic_network_id = unique_synthetic_network_id()
      register_for_test({:visitor, "vid-a"}, synthetic_network_id)
      register_for_test({:visitor, "vid-b"}, synthetic_network_id)
      register_for_test({:user, "uid-c"}, synthetic_network_id)

      assert Admission.live_counts_for_network(synthetic_network_id) ==
               %{visitors: 2, users: 1}
    end

    test "ignores sessions on other networks" do
      this_network = unique_synthetic_network_id()
      other_network = unique_synthetic_network_id()
      register_for_test({:visitor, "vid-x"}, other_network)

      assert Admission.live_counts_for_network(this_network) == %{visitors: 0, users: 0}
    end
  end

  describe "live_counts_by_network/0 — U-3 bulk admin index projection" do
    # Web M3 (reviewer): the admin index path uses ONE Registry scan
    # for all networks instead of 2N scans. These tests pin (a)
    # round-trip parity with `live_counts_for_network/1`, (b) the
    # "no entry = caller defaults to zeros" contract, (c) correct
    # subject_kind tagging at the bulk-fan-out level.
    #
    # SessionRegistry is process-global; async tests elsewhere can
    # populate entries against autoincrement ids that overlap with our
    # fixture. Always scope assertions via `Map.get/3` against a
    # synthetic-unique id no factory uses + drain registrations
    # synchronously on `on_exit`.
    test "bulk projection has no entry for a freshly-minted network with no sessions" do
      synthetic_network_id = unique_synthetic_network_id()
      assert Map.get(Admission.live_counts_by_network(), synthetic_network_id) == nil
    end

    test "keys by network_id with subject-kind counts" do
      net_a = unique_synthetic_network_id()
      net_b = unique_synthetic_network_id()

      register_for_test({:visitor, "v1"}, net_a)
      register_for_test({:visitor, "v2"}, net_a)
      register_for_test({:user, "u1"}, net_a)
      register_for_test({:user, "u2"}, net_b)

      bulk = Admission.live_counts_by_network()

      assert Map.get(bulk, net_a) == %{visitors: 2, users: 1}
      assert Map.get(bulk, net_b) == %{visitors: 0, users: 1}
    end

    test "bulk projection agrees with per-row projection" do
      synthetic_network_id = unique_synthetic_network_id()
      register_for_test({:visitor, "v-row-a"}, synthetic_network_id)
      register_for_test({:user, "u-row-b"}, synthetic_network_id)

      per_row = Admission.live_counts_for_network(synthetic_network_id)
      bulk_row = Map.get(Admission.live_counts_by_network(), synthetic_network_id)

      assert per_row == bulk_row
    end
  end

  # 10_000_000 + unique offset → guaranteed beyond any factory's
  # sqlite autoincrement range within the suite. The atom-based key
  # construction in `Session.Server.registry_key/2` doesn't require
  # the id to map to an existing Network row.
  defp unique_synthetic_network_id, do: 10_000_000 + System.unique_integer([:positive])

  # Register a fake-session key under the current test pid AND queue
  # a synchronous `Registry.unregister/2` for it via `on_exit`. The
  # synchronous unregister beats the link-based async cleanup so
  # sibling test suites' `reset_session_supervisor` polls observe a
  # clean registry without the 15s `project_network_circuit_ets_leak`
  # timeout.
  defp register_for_test(subject_tag, network_id) do
    key = SessionServer.registry_key(subject_tag, network_id)
    {:ok, _} = Registry.register(SessionRegistry, key, nil)
    on_exit(fn -> _ = Registry.unregister(SessionRegistry, key) end)
  end
end
