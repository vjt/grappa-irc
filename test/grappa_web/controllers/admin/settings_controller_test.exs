defmodule GrappaWeb.Admin.SettingsControllerTest do
  use GrappaWeb.ConnCase, async: false

  import Grappa.AuthFixtures
  import Mox

  alias Grappa.Net.{SourceAliasManager, SourceAliasMock}
  alias Grappa.PubSub.Topic
  alias Grappa.{ServerSettings, WSPresence}

  describe "GET /admin/settings — gate" do
    test "401 without bearer", %{conn: conn} do
      conn = get(conn, "/admin/settings")
      assert json_response(conn, 401) == %{"error" => "unauthorized"}
    end

    test "403 for non-admin user", %{conn: conn} do
      {_, session} = user_and_session([])

      conn =
        conn
        |> put_bearer(session.id)
        |> get("/admin/settings")

      assert json_response(conn, 403) == %{"error" => "forbidden"}
    end

    test "403 for visitor", %{conn: conn} do
      {_, session} = visitor_and_session([])

      conn =
        conn
        |> put_bearer(session.id)
        |> get("/admin/settings")

      assert json_response(conn, 403) == %{"error" => "forbidden"}
    end
  end

  describe "GET /admin/settings — happy" do
    setup do
      {admin, session} = user_and_session(is_admin: true)
      %{admin: admin, session: session}
    end

    test "returns current settings", %{conn: conn, session: session} do
      conn = conn |> put_bearer(session.id) |> get("/admin/settings")
      assert %{"settings" => %{"upload" => upload}} = json_response(conn, 200)
      assert upload["active_host"] == "embedded"
      assert upload["image_per_file_cap_bytes"] == 10 * 1024 * 1024
      assert upload["video_per_file_cap_bytes"] == 50 * 1024 * 1024
      assert upload["document_per_file_cap_bytes"] == 10 * 1024 * 1024
      assert upload["audio_per_file_cap_bytes"] == 25 * 1024 * 1024
      assert upload["global_cap_bytes"] == 10 * 1024 * 1024 * 1024
      assert upload["per_user_cap_bytes"] == 1024 * 1024 * 1024
      assert upload["per_visitor_cap_bytes"] == 100 * 1024 * 1024
      assert upload["video_max_duration_seconds"] == 120
    end
  end

  describe "PUT /admin/settings — happy" do
    setup do
      {admin, session} = user_and_session(is_admin: true)
      %{admin: admin, session: session}
    end

    test "updates upload.active_host", %{conn: conn, session: session} do
      conn =
        conn
        |> put_bearer(session.id)
        |> put("/admin/settings", %{"upload" => %{"active_host" => "litterbox"}})

      assert %{"settings" => %{"upload" => %{"active_host" => "litterbox"}}} =
               json_response(conn, 200)

      assert ServerSettings.get_upload_active_host() == :litterbox
    end

    test "updates image_per_file_cap_bytes", %{conn: conn, session: session} do
      conn =
        conn
        |> put_bearer(session.id)
        |> put("/admin/settings", %{"upload" => %{"image_per_file_cap_bytes" => 5_000_000}})

      assert %{"settings" => %{"upload" => %{"image_per_file_cap_bytes" => 5_000_000}}} =
               json_response(conn, 200)

      assert ServerSettings.get_upload_per_file_cap_bytes(:image) == 5_000_000
    end

    test "updates video_per_file_cap_bytes", %{conn: conn, session: session} do
      conn =
        conn
        |> put_bearer(session.id)
        |> put("/admin/settings", %{"upload" => %{"video_per_file_cap_bytes" => 25_000_000}})

      assert %{"settings" => %{"upload" => %{"video_per_file_cap_bytes" => 25_000_000}}} =
               json_response(conn, 200)

      assert ServerSettings.get_upload_per_file_cap_bytes(:video) == 25_000_000
    end

    test "updates video_max_duration_seconds (#201)", %{conn: conn, session: session} do
      conn =
        conn
        |> put_bearer(session.id)
        |> put("/admin/settings", %{"upload" => %{"video_max_duration_seconds" => 45}})

      assert %{"settings" => %{"upload" => %{"video_max_duration_seconds" => 45}}} =
               json_response(conn, 200)

      assert ServerSettings.get_upload_video_max_duration_seconds() == 45
    end

    test "updates document_per_file_cap_bytes", %{conn: conn, session: session} do
      conn =
        conn
        |> put_bearer(session.id)
        |> put("/admin/settings", %{"upload" => %{"document_per_file_cap_bytes" => 7_000_000}})

      assert %{"settings" => %{"upload" => %{"document_per_file_cap_bytes" => 7_000_000}}} =
               json_response(conn, 200)

      assert ServerSettings.get_upload_per_file_cap_bytes(:document) == 7_000_000
    end

    test "updates audio_per_file_cap_bytes", %{conn: conn, session: session} do
      conn =
        conn
        |> put_bearer(session.id)
        |> put("/admin/settings", %{"upload" => %{"audio_per_file_cap_bytes" => 30_000_000}})

      assert %{"settings" => %{"upload" => %{"audio_per_file_cap_bytes" => 30_000_000}}} =
               json_response(conn, 200)

      assert ServerSettings.get_upload_per_file_cap_bytes(:audio) == 30_000_000
    end

    test "updates global_cap_bytes", %{conn: conn, session: session} do
      conn =
        conn
        |> put_bearer(session.id)
        |> put("/admin/settings", %{"upload" => %{"global_cap_bytes" => 999_999}})

      assert %{"settings" => %{"upload" => %{"global_cap_bytes" => 999_999}}} =
               json_response(conn, 200)
    end

    test "updates per_user_cap_bytes", %{conn: conn, session: session} do
      conn =
        conn
        |> put_bearer(session.id)
        |> put("/admin/settings", %{"upload" => %{"per_user_cap_bytes" => 2 * 1024 * 1024 * 1024}})

      assert %{"settings" => %{"upload" => %{"per_user_cap_bytes" => 2_147_483_648}}} =
               json_response(conn, 200)

      assert ServerSettings.get_upload_per_user_cap_bytes() == 2 * 1024 * 1024 * 1024
    end

    test "updates per_visitor_cap_bytes", %{conn: conn, session: session} do
      conn =
        conn
        |> put_bearer(session.id)
        |> put("/admin/settings", %{"upload" => %{"per_visitor_cap_bytes" => 500 * 1024 * 1024}})

      assert %{"settings" => %{"upload" => %{"per_visitor_cap_bytes" => 524_288_000}}} =
               json_response(conn, 200)

      assert ServerSettings.get_upload_per_visitor_cap_bytes() == 500 * 1024 * 1024
    end

    test "the two per-subject caps move INDEPENDENTLY", %{conn: conn, session: session} do
      # vjt's ruling is two ceilings, not one shared number. Writing the
      # user key must leave the visitor key where it was — this is the
      # assert that fails if both clauses are ever pointed at one setting.
      conn
      |> put_bearer(session.id)
      |> put("/admin/settings", %{"upload" => %{"per_user_cap_bytes" => 12_345}})
      |> json_response(200)

      assert ServerSettings.get_upload_per_user_cap_bytes() == 12_345
      assert ServerSettings.get_upload_per_visitor_cap_bytes() == 100 * 1024 * 1024
    end

    test "ignores empty body", %{conn: conn, session: session} do
      conn = conn |> put_bearer(session.id) |> put("/admin/settings", %{})
      assert %{"settings" => _} = json_response(conn, 200)
    end

    # W-S3 (#1407) — an unknown key is a typo, not a no-op. It names the
    # offending dotted key in the SAME 422 shape a bad VALUE gets, because
    # that is the shape `AdminSettingsTab` already highlights inline.
    test "422 invalid_setting names an unknown upload key", %{conn: conn, session: session} do
      conn =
        conn
        |> put_bearer(session.id)
        |> put("/admin/settings", %{"upload" => %{"image_per_file_cap" => 1_048_576}})

      assert %{
               "error" => "invalid_setting",
               "field" => "upload.image_per_file_cap"
             } = json_response(conn, 422)
    end

    # The key check runs BEFORE the per-key applier, so a body that mixes a
    # good key with a typo writes NOTHING — the sibling admin controllers'
    # all-or-nothing posture, not a half-applied save.
    test "an unknown upload key rejects the whole body, valid siblings included", %{
      conn: conn,
      session: session
    } do
      before = ServerSettings.public_view().upload.image_per_file_cap_bytes

      conn =
        conn
        |> put_bearer(session.id)
        |> put("/admin/settings", %{
          "upload" => %{"image_per_file_cap_bytes" => before + 4096, "globalcap_bytes" => 1}
        })

      assert %{"error" => "invalid_setting"} = json_response(conn, 422)
      assert ServerSettings.public_view().upload.image_per_file_cap_bytes == before
    end
  end

  describe "PUT /admin/settings — validation" do
    setup do
      {_, session} = user_and_session(is_admin: true)
      %{session: session}
    end

    test "422 invalid_setting for unknown active_host", %{conn: conn, session: session} do
      conn =
        conn
        |> put_bearer(session.id)
        |> put("/admin/settings", %{"upload" => %{"active_host" => "imgbb"}})

      assert json_response(conn, 422) == %{
               "error" => "invalid_setting",
               "field" => "upload.active_host"
             }
    end

    test "422 invalid_setting for non-positive image_per_file_cap_bytes", %{
      conn: conn,
      session: session
    } do
      conn =
        conn
        |> put_bearer(session.id)
        |> put("/admin/settings", %{"upload" => %{"image_per_file_cap_bytes" => 0}})

      assert json_response(conn, 422) == %{
               "error" => "invalid_setting",
               "field" => "upload.image_per_file_cap_bytes"
             }
    end

    test "422 invalid_setting for non-positive per_user_cap_bytes", %{
      conn: conn,
      session: session
    } do
      conn =
        conn
        |> put_bearer(session.id)
        |> put("/admin/settings", %{"upload" => %{"per_user_cap_bytes" => 0}})

      assert json_response(conn, 422) == %{
               "error" => "invalid_setting",
               "field" => "upload.per_user_cap_bytes"
             }
    end

    test "422 invalid_setting for a non-integer per_visitor_cap_bytes", %{
      conn: conn,
      session: session
    } do
      conn =
        conn
        |> put_bearer(session.id)
        |> put("/admin/settings", %{"upload" => %{"per_visitor_cap_bytes" => "100MB"}})

      assert json_response(conn, 422) == %{
               "error" => "invalid_setting",
               "field" => "upload.per_visitor_cap_bytes"
             }
    end

    test "422 invalid_setting for negative video_per_file_cap_bytes", %{
      conn: conn,
      session: session
    } do
      conn =
        conn
        |> put_bearer(session.id)
        |> put("/admin/settings", %{"upload" => %{"video_per_file_cap_bytes" => -1}})

      assert json_response(conn, 422) == %{
               "error" => "invalid_setting",
               "field" => "upload.video_per_file_cap_bytes"
             }
    end

    test "422 invalid_setting for zero video_max_duration_seconds (#201)", %{
      conn: conn,
      session: session
    } do
      conn =
        conn
        |> put_bearer(session.id)
        |> put("/admin/settings", %{"upload" => %{"video_max_duration_seconds" => 0}})

      assert json_response(conn, 422) == %{
               "error" => "invalid_setting",
               "field" => "upload.video_max_duration_seconds"
             }
    end

    test "422 invalid_setting for string document_per_file_cap_bytes", %{
      conn: conn,
      session: session
    } do
      conn =
        conn
        |> put_bearer(session.id)
        |> put("/admin/settings", %{"upload" => %{"document_per_file_cap_bytes" => "5000000"}})

      assert json_response(conn, 422) == %{
               "error" => "invalid_setting",
               "field" => "upload.document_per_file_cap_bytes"
             }
    end

    test "422 invalid_setting for zero audio_per_file_cap_bytes", %{
      conn: conn,
      session: session
    } do
      conn =
        conn
        |> put_bearer(session.id)
        |> put("/admin/settings", %{"upload" => %{"audio_per_file_cap_bytes" => 0}})

      assert json_response(conn, 422) == %{
               "error" => "invalid_setting",
               "field" => "upload.audio_per_file_cap_bytes"
             }
    end
  end

  describe "GET /admin/settings — dcc subtree (issue 2185)" do
    setup do
      {_, session} = user_and_session(is_admin: true)
      %{session: session}
    end

    # Admin-only, like `addressing` and for the same reason: these are NOT
    # in `public_view/0`, so the view has to read the accessors directly.
    # Without this subtree the operator cannot read back what they wrote.
    test "returns the two DCC ceilings at their defaults", %{conn: conn, session: session} do
      conn = conn |> put_bearer(session.id) |> get("/admin/settings")
      assert %{"settings" => %{"dcc" => dcc}} = json_response(conn, 200)
      assert dcc["max_transfer_bytes"] == 100 * 1024 * 1024
      assert dcc["global_cap_bytes"] == 10 * 1024 * 1024 * 1024
    end

    test "reflects configured values", %{conn: conn, session: session} do
      :ok = ServerSettings.put_dcc_max_transfer_bytes(256 * 1024 * 1024)
      :ok = ServerSettings.put_dcc_global_cap_bytes(64 * 1024 * 1024 * 1024)

      conn = conn |> put_bearer(session.id) |> get("/admin/settings")
      assert %{"settings" => %{"dcc" => dcc}} = json_response(conn, 200)
      assert dcc["max_transfer_bytes"] == 256 * 1024 * 1024
      assert dcc["global_cap_bytes"] == 64 * 1024 * 1024 * 1024
    end
  end

  describe "PUT /admin/settings — dcc subtree (issue 2185)" do
    setup do
      {_, session} = user_and_session(is_admin: true)
      %{session: session}
    end

    test "updates dcc.max_transfer_bytes", %{conn: conn, session: session} do
      conn =
        conn
        |> put_bearer(session.id)
        |> put("/admin/settings", %{"dcc" => %{"max_transfer_bytes" => 178 * 1024 * 1024}})

      assert %{"settings" => %{"dcc" => %{"max_transfer_bytes" => value}}} =
               json_response(conn, 200)

      assert value == 178 * 1024 * 1024
    end

    test "updates dcc.global_cap_bytes", %{conn: conn, session: session} do
      conn =
        conn
        |> put_bearer(session.id)
        |> put("/admin/settings", %{"dcc" => %{"global_cap_bytes" => 20 * 1024 * 1024 * 1024}})

      assert %{"settings" => %{"dcc" => %{"global_cap_bytes" => value}}} =
               json_response(conn, 200)

      assert value == 20 * 1024 * 1024 * 1024
    end

    test "422 invalid_setting names an unknown dcc key — nothing is persisted", %{
      conn: conn,
      session: session
    } do
      before = ServerSettings.get_dcc_max_transfer_bytes()

      conn =
        conn
        |> put_bearer(session.id)
        |> put("/admin/settings", %{
          "dcc" => %{"max_transfer_bytes" => before + 4096, "max_transfer" => 1}
        })

      assert %{"error" => "invalid_setting", "field" => "dcc.max_transfer"} =
               json_response(conn, 422)

      assert ServerSettings.get_dcc_max_transfer_bytes() == before
    end

    test "422 invalid_setting for a non-positive dcc.max_transfer_bytes", %{
      conn: conn,
      session: session
    } do
      conn =
        conn
        |> put_bearer(session.id)
        |> put("/admin/settings", %{"dcc" => %{"max_transfer_bytes" => 0}})

      assert %{"error" => "invalid_setting", "field" => "dcc.max_transfer_bytes"} =
               json_response(conn, 422)
    end

    test "422 invalid_setting for a string dcc.global_cap_bytes", %{conn: conn, session: session} do
      conn =
        conn
        |> put_bearer(session.id)
        |> put("/admin/settings", %{"dcc" => %{"global_cap_bytes" => "10GB"}})

      assert %{"error" => "invalid_setting", "field" => "dcc.global_cap_bytes"} =
               json_response(conn, 422)
    end

    test "400 for a malformed (non-map) dcc subtree — no silent swallow", %{
      conn: conn,
      session: session
    } do
      conn = conn |> put_bearer(session.id) |> put("/admin/settings", %{"dcc" => "100MB"})

      assert json_response(conn, 400)
    end

    # Paletto 4 (vjt, issue 2185) at the HTTP door: a per-transfer ceiling
    # above the spool budget is a LEGAL end state. Rejecting it would make
    # the order of the two writes significant, and `AdminSettingsTab` saves
    # one field at a time.
    test "accepts a per-transfer ceiling ABOVE the spool budget — no cross-validation", %{
      conn: conn,
      session: session
    } do
      conn =
        conn
        |> put_bearer(session.id)
        |> put("/admin/settings", %{
          "dcc" => %{"max_transfer_bytes" => 8 * 1024 * 1024 * 1024, "global_cap_bytes" => 1024 * 1024}
        })

      assert %{"settings" => %{"dcc" => dcc}} = json_response(conn, 200)
      assert dcc["max_transfer_bytes"] > dcc["global_cap_bytes"]
    end

    test "applies the dcc subtree alongside upload in one request", %{conn: conn, session: session} do
      conn =
        conn
        |> put_bearer(session.id)
        |> put("/admin/settings", %{
          "upload" => %{"global_cap_bytes" => 777_777},
          "dcc" => %{"max_transfer_bytes" => 42 * 1024 * 1024}
        })

      assert %{"settings" => %{"upload" => upload, "dcc" => dcc}} = json_response(conn, 200)
      assert upload["global_cap_bytes"] == 777_777
      assert dcc["max_transfer_bytes"] == 42 * 1024 * 1024
    end

    # The DCC keys live in their OWN closed set. A DCC key posted under
    # `upload` must be refused as a typo, not quietly applied to the wrong
    # family — that is the whole point of the sets being closed.
    test "a dcc key posted under the upload subtree is refused as unknown", %{
      conn: conn,
      session: session
    } do
      before = ServerSettings.get_dcc_max_transfer_bytes()

      conn =
        conn
        |> put_bearer(session.id)
        |> put("/admin/settings", %{"upload" => %{"max_transfer_bytes" => 1024 * 1024}})

      assert %{"error" => "invalid_setting", "field" => "upload.max_transfer_bytes"} =
               json_response(conn, 422)

      assert ServerSettings.get_dcc_max_transfer_bytes() == before
    end
  end

  describe "GET /admin/settings — addressing subtree (#543)" do
    setup do
      {_, session} = user_and_session(is_admin: true)
      %{session: session}
    end

    test "returns addressing mode + prefix (defaults)", %{conn: conn, session: session} do
      conn = conn |> put_bearer(session.id) |> get("/admin/settings")
      assert %{"settings" => %{"addressing" => addressing}} = json_response(conn, 200)
      assert addressing["mode"] == "pool_with_reservations"
      assert addressing["static_mapping_prefix"] == nil
    end

    test "reflects a configured mode + prefix", %{conn: conn, session: session} do
      :ok = ServerSettings.put_addressing_mode(:static_mapping_with_reservations)
      :ok = ServerSettings.put_static_mapping_prefix("2a03:4000:20:2d3:cb::/80")

      conn = conn |> put_bearer(session.id) |> get("/admin/settings")
      assert %{"settings" => %{"addressing" => addressing}} = json_response(conn, 200)
      assert addressing["mode"] == "static_mapping_with_reservations"
      assert addressing["static_mapping_prefix"] == "2a03:4000:20:2d3:cb::/80"
    end
  end

  describe "PUT /admin/settings — addressing (#543/#609)" do
    setup :set_mox_global
    setup :verify_on_exit!

    setup do
      {_, session} = user_and_session(is_admin: true)

      # The #609 set-time capability probe calls SourceAliasManager.arm/1, so a
      # manager must be running. It is wired to the Mox adapter (no real
      # ifconfig); a nil boot prefix skips the boot arm_check, and list_aliases
      # is stubbed for the boot reconcile. Per-test arm_check expectations model
      # the substrate's probe verdict.
      stub(SourceAliasMock, :list_aliases, fn _ -> {:ok, []} end)
      start_supervised!({SourceAliasManager, adapter: SourceAliasMock, prefix: nil})

      %{session: session}
    end

    test "sets mode + prefix after the probe arms", %{conn: conn, session: session} do
      expect(SourceAliasMock, :arm_check, fn "2a03:4000:20:2d3:cb::/80" -> :ok end)

      conn =
        conn
        |> put_bearer(session.id)
        |> put("/admin/settings", %{
          "addressing" => %{
            "mode" => "static_mapping_with_reservations",
            "static_mapping_prefix" => "2a03:4000:20:2d3:cb::/80"
          }
        })

      assert %{"settings" => %{"addressing" => addressing}} = json_response(conn, 200)
      assert addressing["mode"] == "static_mapping_with_reservations"
      assert addressing["static_mapping_prefix"] == "2a03:4000:20:2d3:cb::/80"
      assert ServerSettings.addressing_mode() == :static_mapping_with_reservations
      assert ServerSettings.static_mapping_prefix() == "2a03:4000:20:2d3:cb::/80"
      # a successful set adopts the new prefix + arms without a reboot (B1).
      assert SourceAliasManager.armed?() == true
    end

    test "422 addressing_unusable when the probe refuses — nothing is persisted",
         %{conn: conn, session: session} do
      expect(SourceAliasMock, :arm_check, fn _ -> {:error, :alias_not_permitted} end)

      conn =
        conn
        |> put_bearer(session.id)
        |> put("/admin/settings", %{
          "addressing" => %{
            "mode" => "static_mapping_with_reservations",
            "static_mapping_prefix" => "2a03:4000:20:2d3:cb::/80"
          }
        })

      assert json_response(conn, 422) == %{
               "error" => "addressing_unusable",
               "reason" => "alias_not_permitted"
             }

      # a mode that cannot arm never reaches the DB.
      assert ServerSettings.addressing_mode() == :pool_with_reservations
      assert ServerSettings.static_mapping_prefix() == nil
    end

    test "422 addressing_unusable :no_static_prefix when enabling mode 2 with no prefix",
         %{conn: conn, session: session} do
      # arm_check is never reached — a nil prefix cannot arm (no Mox expect set).
      conn =
        conn
        |> put_bearer(session.id)
        |> put("/admin/settings", %{
          "addressing" => %{"mode" => "static_mapping_with_reservations"}
        })

      assert json_response(conn, 422) == %{
               "error" => "addressing_unusable",
               "reason" => "no_static_prefix"
             }

      assert ServerSettings.addressing_mode() == :pool_with_reservations
    end

    test "changing the prefix while mode 2 is active re-probes the NEW prefix",
         %{conn: conn, session: session} do
      :ok = ServerSettings.put_addressing_mode(:static_mapping_with_reservations)
      :ok = ServerSettings.put_static_mapping_prefix("2a03:4000:20:2d3:cb::/80")

      expect(SourceAliasMock, :arm_check, fn "2a03:4000:20:2d3:ca::/80" -> :ok end)

      conn =
        conn
        |> put_bearer(session.id)
        |> put("/admin/settings", %{
          "addressing" => %{"static_mapping_prefix" => "2a03:4000:20:2d3:ca::/80"}
        })

      assert json_response(conn, 200)
      assert ServerSettings.static_mapping_prefix() == "2a03:4000:20:2d3:ca::/80"
    end

    test "422 invalid_setting for an unknown mode", %{conn: conn, session: session} do
      conn =
        conn
        |> put_bearer(session.id)
        |> put("/admin/settings", %{"addressing" => %{"mode" => "chaos"}})

      assert json_response(conn, 422) == %{
               "error" => "invalid_setting",
               "field" => "addressing.mode"
             }
    end

    test "422 invalid_setting for a prefix OperServ cannot express", %{conn: conn, session: session} do
      conn =
        conn
        |> put_bearer(session.id)
        |> put("/admin/settings", %{
          "addressing" => %{"static_mapping_prefix" => "2a03:4000:20:2d3:cb::/72"}
        })

      assert json_response(conn, 422) == %{
               "error" => "invalid_setting",
               "field" => "addressing.static_mapping_prefix"
             }
    end

    # W-S3 (#1407) — the addressing subtree used to log the typo and apply the
    # rest; the probe never even ran for a body that named nothing it knows.
    test "422 invalid_setting names an unknown addressing key — nothing is persisted",
         %{conn: conn, session: session} do
      conn =
        conn
        |> put_bearer(session.id)
        |> put("/admin/settings", %{
          "addressing" => %{"static_prefix" => "2a03:4000:20:2d3:cb::/80"}
        })

      assert json_response(conn, 422) == %{
               "error" => "invalid_setting",
               "field" => "addressing.static_prefix"
             }

      assert ServerSettings.static_mapping_prefix() == nil
    end

    test "applies upload AND addressing subtrees in one request", %{conn: conn, session: session} do
      expect(SourceAliasMock, :arm_check, fn "2a03:4000:20:2d3:cb::/80" -> :ok end)

      conn =
        conn
        |> put_bearer(session.id)
        |> put("/admin/settings", %{
          "upload" => %{"active_host" => "litterbox"},
          "addressing" => %{
            "mode" => "static_mapping_with_reservations",
            "static_mapping_prefix" => "2a03:4000:20:2d3:cb::/80"
          }
        })

      assert %{
               "settings" => %{
                 "upload" => %{"active_host" => "litterbox"},
                 "addressing" => %{"mode" => "static_mapping_with_reservations"}
               }
             } = json_response(conn, 200)

      assert ServerSettings.get_upload_active_host() == :litterbox
      assert ServerSettings.addressing_mode() == :static_mapping_with_reservations
    end

    test "400 for a malformed (non-map) subtree — no silent swallow", %{
      conn: conn,
      session: session
    } do
      conn =
        conn
        |> put_bearer(session.id)
        |> put("/admin/settings", %{"addressing" => "not-a-map"})

      assert %{"error" => _} = json_response(conn, 400)
    end
  end

  describe "PUT /admin/settings — fan-out (UX-6-B2)" do
    setup do
      {_, session} = user_and_session(is_admin: true)
      %{session: session}
    end

    test "broadcasts server_settings_changed to subscribed user-topics", %{
      conn: conn,
      session: session
    } do
      # Same shape as `AdminControllerTest`'s cic_bundle_changed
      # broadcast assertion: register a fake socket pid so
      # `WSPresence.list_user_names/0` returns this user, then
      # subscribe a test process to the user-topic so we can observe
      # the fan-out.
      user_name = "settingsbcast-#{System.unique_integer([:positive])}"
      :ok = WSPresence.register(user_name, self())

      topic = Topic.user(user_name)
      :ok = Phoenix.PubSub.subscribe(Grappa.PubSub, topic)

      conn =
        conn
        |> put_bearer(session.id)
        |> put("/admin/settings", %{"upload" => %{"active_host" => "litterbox"}})

      assert json_response(conn, 200)

      assert_receive %Phoenix.Socket.Broadcast{
        event: "event",
        payload: %{
          kind: :server_settings_changed,
          upload: %{active_host: :litterbox}
        }
      }
    end

    test "broadcasts to VISITOR user-topics too (visitor cic also reads upload settings)",
         %{conn: conn, session: session} do
      visitor_name = "visitor:#{Ecto.UUID.generate()}"
      :ok = WSPresence.register(visitor_name, self())

      topic = Topic.user(visitor_name)
      :ok = Phoenix.PubSub.subscribe(Grappa.PubSub, topic)

      conn =
        conn
        |> put_bearer(session.id)
        |> put("/admin/settings", %{"upload" => %{"image_per_file_cap_bytes" => 4_000_000}})

      assert json_response(conn, 200)

      assert_receive %Phoenix.Socket.Broadcast{
        event: "event",
        payload: %{
          kind: :server_settings_changed,
          upload: %{image_per_file_cap_bytes: 4_000_000}
        }
      }
    end

    test "emits [:grappa, :admin, :server_settings_fanout] telemetry", %{
      conn: conn,
      session: session
    } do
      handler_id = "test-server-settings-fanout-#{System.unique_integer([:positive])}"
      parent = self()

      :telemetry.attach(
        handler_id,
        [:grappa, :admin, :server_settings_fanout],
        fn event, measurements, metadata, _ ->
          send(parent, {:telemetry, event, measurements, metadata})
        end,
        nil
      )

      try do
        user_name = "fanout-set-tel-#{System.unique_integer([:positive])}"
        :ok = WSPresence.register(user_name, self())

        conn =
          conn
          |> put_bearer(session.id)
          |> put("/admin/settings", %{"upload" => %{"global_cap_bytes" => 88_888}})

        assert json_response(conn, 200)

        assert_receive {:telemetry, [:grappa, :admin, :server_settings_fanout],
                        %{attempted: attempted, succeeded: succeeded, failed: failed}, _}

        assert is_integer(attempted)
        assert is_integer(succeeded)
        assert is_integer(failed)
        assert attempted >= 1
        assert succeeded + failed == attempted
      after
        :telemetry.detach(handler_id)
      end
    end

    test "does NOT fan out on validation failure", %{conn: conn, session: session} do
      user_name = "settingsbcast-novfail-#{System.unique_integer([:positive])}"
      :ok = WSPresence.register(user_name, self())

      topic = Topic.user(user_name)
      :ok = Phoenix.PubSub.subscribe(Grappa.PubSub, topic)

      conn =
        conn
        |> put_bearer(session.id)
        |> put("/admin/settings", %{"upload" => %{"active_host" => "imgbb"}})

      assert json_response(conn, 422)
      refute_receive %Phoenix.Socket.Broadcast{event: "event"}, 50
    end
  end
end
