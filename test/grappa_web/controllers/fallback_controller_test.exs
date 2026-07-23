defmodule GrappaWeb.FallbackControllerTest do
  @moduledoc """
  Direct-dispatch tests for `GrappaWeb.FallbackController.call/2` covering
  the T31 admission error mappings. We exercise the fallback at the
  controller-module level (no router, no AuthController) so a single
  `{:error, atom}` input maps deterministically to status + body
  regardless of which action surfaced it.

  Why direct-dispatch: the captcha error atoms (`:captcha_required`,
  `:captcha_failed`, `:captcha_provider_unavailable`) cannot be reached
  from the test config (`Captcha.Disabled` provider always returns `:ok`).
  Direct-dispatch isolates the wire-shape contract from Login plumbing
  and keeps the test from depending on which production code path emits
  each atom.
  """
  # async: false — the captcha_required test mutates the shared
  # `:persistent_term` slot for `Grappa.Admission.Config.config/0` to
  # exercise the Turnstile wire shape (B1.3 migration).
  use GrappaWeb.ConnCase, async: false

  alias GrappaWeb.FallbackController

  defp build_conn_for_call do
    Phoenix.ConnTest.build_conn()
  end

  describe "T31 admission capacity errors" do
    # #171: ip_cap_exceeded is resource exhaustion, not rate limit. The
    # actor isn't spamming — their source IP is at its per-network session
    # limit. 503 is the right surface (cf. visitor/user cap below); the
    # envelope stays `too_many_sessions` so cic's copy stays distinct from
    # the network-wide `network_busy` arm. 429 was the original T31
    # mapping; U-3 corrected it to 503, #171 kept the envelope.
    test "{:error, :ip_cap_exceeded} → 503 too_many_sessions" do
      conn = FallbackController.call(build_conn_for_call(), {:error, :ip_cap_exceeded})

      assert conn.status == 503
      assert Jason.decode!(conn.resp_body) == %{"error" => "too_many_sessions"}
    end

    test "{:error, :visitor_cap_exceeded} → 503 network_busy" do
      conn = FallbackController.call(build_conn_for_call(), {:error, :visitor_cap_exceeded})

      assert conn.status == 503
      assert Jason.decode!(conn.resp_body) == %{"error" => "network_busy"}
    end

    test "{:error, :user_cap_exceeded} → 503 network_busy" do
      conn = FallbackController.call(build_conn_for_call(), {:error, :user_cap_exceeded})

      assert conn.status == 503
      assert Jason.decode!(conn.resp_body) == %{"error" => "network_busy"}
    end

    test "{:error, :connect_timeout} → 503 connect_timeout + Retry-After 30" do
      conn = FallbackController.call(build_conn_for_call(), {:error, :connect_timeout})

      assert conn.status == 503
      assert Jason.decode!(conn.resp_body) == %{"error" => "connect_timeout"}
      assert Plug.Conn.get_resp_header(conn, "retry-after") == ["30"]
    end

    test "{:error, :welcome_timeout} → 503 welcome_timeout + Retry-After 60" do
      conn = FallbackController.call(build_conn_for_call(), {:error, :welcome_timeout})

      assert conn.status == 503
      assert Jason.decode!(conn.resp_body) == %{"error" => "welcome_timeout"}
      assert Plug.Conn.get_resp_header(conn, "retry-after") == ["60"]
    end

    test "{:error, :probe_timeout} → 500 probe_timeout (programmer assertion)" do
      conn = FallbackController.call(build_conn_for_call(), {:error, :probe_timeout})

      assert conn.status == 500
      assert Jason.decode!(conn.resp_body) == %{"error" => "probe_timeout"}
    end

    test "{:error, {:network_circuit_open, retry_after}} → 503 network_unreachable + Retry-After" do
      conn =
        FallbackController.call(
          build_conn_for_call(),
          {:error, {:network_circuit_open, 42}}
        )

      assert conn.status == 503
      assert Jason.decode!(conn.resp_body) == %{"error" => "network_unreachable"}
      assert Plug.Conn.get_resp_header(conn, "retry-after") == ["42"]
    end

    # U-3 (UD3): exhaustive enumeration over `Grappa.Admission.error()`.
    # The list literal below is the WIRE CONTRACT — every member of the
    # typed union MUST appear here with its expected status + envelope.
    # When admission grows a new error atom, dialyzer surfaces the gap
    # at `@spec` on `FallbackController.call/2` AND this test fails
    # loud if the new atom has no FC clause (FunctionClauseError).
    #
    # The captcha sub-arms have their own describe block above (they
    # require :persistent_term + provider wiring to exercise the
    # captcha_required site_key/provider envelope), so this matrix
    # covers the capacity_error() half only.
    #
    # U-3 fix-up (web M2): we cross-check the matrix length against
    # `Grappa.Admission.capacity_error_atoms/0` so adding an atom to
    # the canary list without a matrix entry fails loud. The two
    # canaries (the canon list + this matrix) MUST move in lockstep
    # with the `@type capacity_error/0` definition — otherwise the
    # "fails loud" promise rots.
    test "every Admission.capacity_error() atom has an FC clause + asserted shape" do
      cases = [
        {:ip_cap_exceeded, 503, %{"error" => "too_many_sessions"}, []},
        {:visitor_cap_exceeded, 503, %{"error" => "network_busy"}, []},
        {:user_cap_exceeded, 503, %{"error" => "network_busy"}, []},
        {{:network_circuit_open, 7}, 503, %{"error" => "network_unreachable"}, [{"retry-after", "7"}]}
      ]

      # Canary cross-check: the matrix's atom set must equal the canon
      # `capacity_error_atoms/0` list. Adding a tag in one place without
      # the other = silent drop (the new atom either has no test or no
      # production clause, depending on which canary stayed in sync).
      canon = Enum.sort(Grappa.Admission.capacity_error_atoms())

      matrix_atoms =
        cases
        |> Enum.map(fn
          {atom, _, _, _} when is_atom(atom) -> atom
          {{atom, _}, _, _, _} -> atom
        end)
        |> Enum.sort()

      assert matrix_atoms == canon,
             "matrix atoms #{inspect(matrix_atoms)} drift from " <>
               "Admission.capacity_error_atoms() #{inspect(canon)} — " <>
               "add/remove a matrix entry to match the canon"

      for {error, status, body, headers} <- cases do
        conn = FallbackController.call(build_conn_for_call(), {:error, error})

        assert conn.status == status,
               "expected #{inspect(error)} → #{status}, got #{conn.status}"

        assert Jason.decode!(conn.resp_body) == body,
               "expected #{inspect(error)} → body #{inspect(body)}, got #{conn.resp_body}"

        for {header, expected} <- headers do
          assert Plug.Conn.get_resp_header(conn, header) == [expected],
                 "expected #{inspect(error)} → header #{header}=#{expected}"
        end
      end
    end
  end

  describe "T31 captcha errors" do
    test "{:error, :captcha_required} → 400 captcha_required + site_key + provider" do
      pt_key = {Grappa.Admission.Config, :config}
      original_pt = :persistent_term.get(pt_key, :__unset__)

      Grappa.Admission.Config.put_test_config(%Grappa.Admission.Config{
        captcha_provider: Grappa.Admission.Captcha.Turnstile,
        captcha_secret: "test-secret",
        captcha_site_key: "test-site-key-123",
        turnstile_endpoint: "unused",
        hcaptcha_endpoint: "unused"
      })

      on_exit(fn ->
        case original_pt do
          :__unset__ -> :persistent_term.erase(pt_key)
          cfg -> :persistent_term.put(pt_key, cfg)
        end
      end)

      conn = FallbackController.call(build_conn_for_call(), {:error, :captcha_required})
      body = json_response(conn, 400)
      assert body["error"] == "captcha_required"
      assert body["site_key"] == "test-site-key-123"
      assert body["provider"] == "turnstile"
    end

    test "{:error, :captcha_failed} → 400 captcha_failed" do
      conn = FallbackController.call(build_conn_for_call(), {:error, :captcha_failed})

      assert conn.status == 400
      assert Jason.decode!(conn.resp_body) == %{"error" => "captcha_failed"}
    end

    test "{:error, :captcha_provider_unavailable} → 503 service_degraded" do
      conn =
        FallbackController.call(build_conn_for_call(), {:error, :captcha_provider_unavailable})

      assert conn.status == 503
      assert Jason.decode!(conn.resp_body) == %{"error" => "service_degraded"}
    end
  end

  # L-web-1: AuthController error envelopes that previously bypassed
  # the FallbackController via inline `send_error/3`. Routed here to
  # keep the wire-shape contract in one module.
  describe "AuthController error envelopes (L-web-1)" do
    test "{:error, :malformed_nick} → 400 malformed_nick" do
      conn = FallbackController.call(build_conn_for_call(), {:error, :malformed_nick})

      assert conn.status == 400
      assert Jason.decode!(conn.resp_body) == %{"error" => "malformed_nick"}
    end

    test "{:error, :password_required} → 401 password_required" do
      conn = FallbackController.call(build_conn_for_call(), {:error, :password_required})

      assert conn.status == 401
      assert Jason.decode!(conn.resp_body) == %{"error" => "password_required"}
    end

    test "{:error, :password_mismatch} → 401 password_mismatch" do
      conn = FallbackController.call(build_conn_for_call(), {:error, :password_mismatch})

      assert conn.status == 401
      assert Jason.decode!(conn.resp_body) == %{"error" => "password_mismatch"}
    end

    test "{:error, :upstream_unreachable} → 502 upstream_unreachable" do
      conn = FallbackController.call(build_conn_for_call(), {:error, :upstream_unreachable})

      assert conn.status == 502
      assert Jason.decode!(conn.resp_body) == %{"error" => "upstream_unreachable"}
    end

    test "{:error, :internal} → 500 internal" do
      conn = FallbackController.call(build_conn_for_call(), {:error, :internal})

      assert conn.status == 500
      assert Jason.decode!(conn.resp_body) == %{"error" => "internal"}
    end

    test "{:error, {:anon_collision, retry_after}} → 409 anon_collision + Retry-After" do
      conn =
        FallbackController.call(build_conn_for_call(), {:error, {:anon_collision, 1234}})

      assert conn.status == 409
      assert Jason.decode!(conn.resp_body) == %{"error" => "anon_collision"}
      assert Plug.Conn.get_resp_header(conn, "retry-after") == ["1234"]
    end
  end

  # Bucket G H2+U4 (codebase-review-2026-05-12): unified
  # `{error, field_errors}` envelope for 422 changeset failures.
  #
  # Pre-bucket-G: 422 emitted `%{errors: %{field => [msg]}}` — no
  # `error` discriminator, so cic's `readError` fell through to
  # `body.errors.detail` (Phoenix default-error shape, NOT Ecto
  # changeset shape) and from there to `res.statusText`. Every 422
  # collapsed to "Unprocessable Entity" client-side, losing
  # field-level error info to the operator.
  #
  # Post-fix: 422 emits `%{error: "validation_failed", field_errors:
  # %{field => [msg]}}`. The discriminator follows the snake_case
  # convention of every other arm (line 9 moduledoc); the
  # field-level errors live as a top-level `field_errors` key
  # alongside the existing `site_key`/`provider`/`retry_after`
  # convention (cic's `ApiError.info` already reads body's top-level
  # keys directly — see `Login.tsx`'s `err.info.provider` access).
  # web S1 (codebase-review 2026-07-19): the moduledoc mandates "add a
  # clause here and update the spec in lockstep," but the `@spec call/2`
  # error union had drifted six tags behind its clause heads
  # (`:body_too_large`, `:too_many_attempts`, `:list_full`, `:timeout`,
  # `:resolve_failed`, `{:start_failed, _}`). Dialyzer can't catch a
  # CALLER passing a narrowed-away tag, so the lockstep rule silently
  # rotted. This canary walks every `def call(conn, {:error, TAG})`
  # clause head parsed from source AND the atom set of the `@spec`
  # error union, and fails loud on any drift in either direction —
  # closing the drift class the way the capacity_error matrix above
  # closes the admission class.
  describe "@spec ↔ clause lockstep drift gate (web S1)" do
    test "call/2 @spec error union stays in lockstep with the clause heads" do
      clause_tags = MapSet.new(clause_error_tags())
      spec_tags = MapSet.new(spec_error_tags())
      admission = MapSet.new(admission_error_atoms())

      # Every clause head must be declared: directly in the spec, or via
      # the `Grappa.Admission.error()` remote type. (The `%Ecto.Changeset{}`
      # clause carries no atom tag, so it never appears in clause_tags.)
      missing_from_spec =
        MapSet.difference(clause_tags, MapSet.union(spec_tags, admission))

      assert MapSet.equal?(missing_from_spec, MapSet.new()),
             "call/2 clauses missing from @spec union (add them to the spec): " <>
               inspect(Enum.sort(MapSet.to_list(missing_from_spec)))

      # No phantom spec entries: every directly-declared atom/tuple tag
      # must have a real clause head.
      phantom = MapSet.difference(spec_tags, clause_tags)

      assert MapSet.equal?(phantom, MapSet.new()),
             "@spec tags with no call/2 clause (remove them from the spec): " <>
               inspect(Enum.sort(MapSet.to_list(phantom)))
    end
  end

  # --- web S1 drift-gate helpers ------------------------------------------

  # Parse the tag atom out of every `def call(conn, {:error, TAG})` clause
  # head in the source file. TAG is either a bare atom (`:bad_request`) or
  # a tuple whose first element is the discriminator atom
  # (`{:file_too_large, _}` → `:file_too_large`). The changeset binding
  # clause (`{:error, %Ecto.Changeset{} = cs}`) yields no atom tag.
  defp clause_error_tags do
    {:ok, ast} =
      "lib/grappa_web/controllers/fallback_controller.ex"
      |> File.read!()
      |> Code.string_to_quoted()

    {_, tags} =
      Macro.prewalk(ast, [], fn
        {:def, _, [head | _]} = node, acc ->
          case call_error_pattern(head) do
            {:ok, tag} -> {node, [clause_tag(tag) | acc]}
            :error -> {node, acc}
          end

        node, acc ->
          {node, acc}
      end)

    tags |> Enum.reject(&is_nil/1) |> Enum.uniq()
  end

  defp call_error_pattern({:when, _, [inner | _]}), do: call_error_pattern(inner)
  defp call_error_pattern({:call, _, [_conn, {:error, tag}]}), do: {:ok, tag}
  defp call_error_pattern(_), do: :error

  defp clause_tag(tag) when is_atom(tag), do: tag
  defp clause_tag({first, _}) when is_atom(first), do: first
  defp clause_tag(_), do: nil

  # Collect the atom + tuple-discriminator tags directly declared in the
  # `@spec call/2` error union. Remote types (`Grappa.Admission.error()`,
  # `Ecto.Changeset.t()`) are intentionally skipped — the admission atoms
  # are expanded separately via the production canon.
  defp spec_error_tags do
    {:ok, specs} = Code.Typespec.fetch_specs(FallbackController)

    {_, [spec_ast]} =
      Enum.find(specs, fn {{name, arity}, _} -> name == :call and arity == 2 end)

    {:type, _, :fun, [{:type, _, :product, [_conn, err_tuple]}, _ret]} = spec_ast
    {:type, _, :tuple, [{:atom, _, :error}, union]} = err_tuple

    collect_spec_tags(union)
  end

  defp collect_spec_tags({:type, _, :union, members}),
    do: Enum.flat_map(members, &collect_spec_tags/1)

  defp collect_spec_tags({:atom, _, atom}) when is_atom(atom), do: [atom]
  defp collect_spec_tags({:type, _, :tuple, [{:atom, _, tag} | _]}), do: [tag]
  defp collect_spec_tags(_), do: []

  # `Grappa.Admission.error() = capacity_error() | Captcha.error()`.
  # capacity_error atoms come from the production canon the matrix above
  # already pins; the captcha atoms are read from the Captcha type so the
  # gate tracks the source rather than a hand-copy.
  defp admission_error_atoms do
    Grappa.Admission.capacity_error_atoms() ++ captcha_error_atoms()
  end

  defp captcha_error_atoms do
    {:ok, types} = Code.Typespec.fetch_types(Grappa.Admission.Captcha)
    {_, {_, ast, _}} = Enum.find(types, fn {_, {name, _, _}} -> name == :error end)
    collect_spec_tags(ast)
  end

  describe "validation errors (H2+U4 unified envelope)" do
    test "{:error, %Ecto.Changeset{}} → 422 validation_failed + field_errors" do
      changeset =
        {%{}, %{nick: :string, body: :string}}
        |> Ecto.Changeset.cast(%{}, [:nick, :body])
        |> Ecto.Changeset.validate_required([:nick, :body])

      conn = FallbackController.call(build_conn_for_call(), {:error, changeset})

      body = json_response(conn, 422)
      assert body["error"] == "validation_failed"
      assert body["field_errors"]["nick"] == ["can't be blank"]
      assert body["field_errors"]["body"] == ["can't be blank"]
    end

    test "field_errors traverses substitution opts (e.g. {%{count}})" do
      changeset =
        {%{}, %{nick: :string}}
        |> Ecto.Changeset.cast(%{nick: "x"}, [:nick])
        |> Ecto.Changeset.validate_length(:nick, min: 3)

      conn = FallbackController.call(build_conn_for_call(), {:error, changeset})

      body = json_response(conn, 422)
      assert body["error"] == "validation_failed"
      [msg] = body["field_errors"]["nick"]
      assert msg =~ "should be at least 3"
    end
  end
end
