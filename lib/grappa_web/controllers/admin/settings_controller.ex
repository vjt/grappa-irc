defmodule GrappaWeb.Admin.SettingsController do
  @moduledoc """
  Admin verbs over `Grappa.ServerSettings`. Behind `:admin_authn` —
  visitor + non-admin user collapse to 403 upstream.

  ## GET /admin/settings

  Returns the admin settings view — the `upload` subtree of
  `public_view/0` plus the admin-only `addressing` (#543) and `dcc` (issue
  2185) subtrees, both read straight from the `Grappa.ServerSettings`
  accessors because neither is part of `public_view/0`, and the admin
  projection of `auto_away` (issue 2359): the STORED site default
  (`nil` = follow the boot fallback) next to that fallback. It deliberately
  OMITS the #324 `http_host_aliases` that the authenticated
  `/api/server-settings` carries: those are deployment config
  (env-derived), not an admin-editable DB setting. Wire shape:

      %{
        settings: %{
          upload: %{
            active_host: "embedded" | "litterbox",
            image_per_file_cap_bytes: pos_integer(),
            video_per_file_cap_bytes: pos_integer(),
            document_per_file_cap_bytes: pos_integer(),
            audio_per_file_cap_bytes: pos_integer(),
            global_cap_bytes: pos_integer(),
            per_user_cap_bytes: pos_integer(),
            per_visitor_cap_bytes: pos_integer(),
            video_max_duration_seconds: pos_integer()
          },
          dcc: %{
            max_transfer_bytes: pos_integer(),
            global_cap_bytes: pos_integer()
          },
          auto_away: %{
            default_debounce_seconds: 0 | 60 | 300 | 600 | 1800 | 3600 | nil,
            fallback_debounce_seconds: pos_integer()
          },
          addressing: %{
            mode: "pool_with_reservations" | "static_mapping_with_reservations",
            static_mapping_prefix: String.t() | nil
          }
        }
      }

  ## PUT /admin/settings

  Body shape:

      %{
        "upload" => %{
          "active_host" => "embedded" | "litterbox",
          "image_per_file_cap_bytes" => pos_integer(),
          "video_per_file_cap_bytes" => pos_integer(),
          "document_per_file_cap_bytes" => pos_integer(),
          "audio_per_file_cap_bytes" => pos_integer(),
          "global_cap_bytes" => pos_integer(),
          "per_user_cap_bytes" => pos_integer(),
          "per_visitor_cap_bytes" => pos_integer(),
          "video_max_duration_seconds" => pos_integer()
        },
        "dcc" => %{
          "max_transfer_bytes" => pos_integer(),
          "global_cap_bytes" => pos_integer()
        },
        "auto_away" => %{
          "default_debounce_seconds" => 0 | 60 | 300 | 600 | 1800 | 3600 | nil
        },
        "addressing" => %{
          "mode" => "pool_with_reservations" | "static_mapping_with_reservations",
          "static_mapping_prefix" => String.t()
        }
      }

  All four of `upload`, `dcc`, `auto_away` and `addressing` are independently optional
  subtrees, and every key within each is optional — the controller upserts
  only the keys present in the body. Any invalid value (out-of-set
  host/mode string, non-positive integer cap, non-16-bit-group prefix
  length) collapses to 422 `invalid_setting` with the offending dotted key
  in `field`, and so does any key outside the four closed sets above
  (#1407 W-S3) — a typo is named, never absorbed, and it refuses the WHOLE
  body rather than applying the keys it did recognise.

  A save is all-or-nothing. Every key of the body is VALIDATED before any is
  written (issue 2546), so a refused value leaves no sibling written behind
  it: `parse_updates/1` is pure — it decides on the body alone, with no
  write, no read and no state — and turns the body into the list of writes
  `Grappa.ServerSettings.put_many/1` commits in ONE transaction (issue
  2609), so a `:db_unavailable` (503) leaves every key as it was too.

  ⚠️ The two `dcc` keys are NOT cross-validated against each other (vjt,
  issue 2185): a per-transfer ceiling above the spool budget is a legal
  end state, and refusing it would make the ORDER of two writes
  significant for a UI that saves one field at a time.

  On success: 200 with the new full settings view AND fan-out of a
  `server_settings_changed` push on every live `Topic.user(name)`
  for cic reactive update without a poll. Same precedent +
  iterator as `AdminController.cic_bundle_changed/2` (CP23 S4 B5
  cic-bundle fan-out): one broadcast per operator with a live WS.
  Wire-shape lives at `Grappa.ServerSettings.Wire`. A write carrying
  `auto_away` additionally calls `Grappa.Session.reapply_auto_away_site_default/0`
  (issue 2359, ruling: LIVE), so running sessions that follow the site
  default move with it; sessions with their own delay do not.

  The intermediate `Grappa.ServerSettings.topic/0` broadcast that
  `put_many/1` emits — once per save, after the commit — stays as an
  in-process signal for tests + any future internal subscriber; the cic
  fan-out path lives HERE (single explicit door, parity with
  `cic_bundle_changed`).
  """

  use GrappaWeb, :controller

  alias Grappa.Net.SourceAliasManager
  alias Grappa.{PubSub, ServerSettings, Session, WSPresence}
  alias Grappa.PubSub.Topic
  alias Grappa.ServerSettings.Wire, as: SettingsWire

  # The four closed key sets. Every entry here MUST have its `parse_*_key/2`
  # clause (resp. the `parse_addressing_*` pair) — and, for a new SETTING,
  # its `Grappa.ServerSettings.write()` with the `encode/1` clause behind it.
  #
  # ⚠️ **A missing clause is caught exactly as well as that key's own test
  # catches it, and that was MEASURED rather than assumed (issue 2185).**
  # Adding a key that NO test names — `spool_retention_seconds`, no clause,
  # no test — left the suite green. Nothing structural pairs a set entry
  # with its clause: `reject_unknown_keys/3` compares strings at runtime, so
  # the compiler cannot see the pair, and no test enumerates these sets. (The
  # kill counts #2185 and issue 2546 recorded measured the one-clause and
  # the validate/put-pair shapes this file had before issue 2609; they are
  # history, not a claim about this shape.) A key added here without its
  # test in the SAME pass ships a latent 500 on the first request that uses
  # it — raised in the parse pass, so since issue 2609 always BEFORE anything
  # is written.
  @upload_keys ~w(active_host image_per_file_cap_bytes video_per_file_cap_bytes
                  document_per_file_cap_bytes audio_per_file_cap_bytes
                  global_cap_bytes per_user_cap_bytes per_visitor_cap_bytes
                  video_max_duration_seconds)

  # issue 2185 — DCC's own closed set, disjoint from `@upload_keys` on
  # purpose: `global_cap_bytes` is a member of BOTH and means a different
  # budget in each, which is why the subtree and not the key name carries
  # the family.
  @dcc_keys ~w(max_transfer_bytes global_cap_bytes)

  @addressing_keys ~w(mode static_mapping_prefix)

  # issue 2359 — the auto-away site default. One key; `null` is a VALUE here
  # (delete the row, back to the boot fallback), not an absent key.
  @auto_away_keys ~w(default_debounce_seconds)

  @doc false
  @spec index(Plug.Conn.t(), map()) :: Plug.Conn.t()
  def index(conn, _) do
    json(conn, %{settings: render_view(ServerSettings.public_view())})
  end

  @doc false
  @spec update(Plug.Conn.t(), map()) ::
          Plug.Conn.t()
          | {:error,
             atom()
             | {:invalid_setting, String.t()}
             | {:addressing_unusable, atom()}
             | Ecto.Changeset.t()}
  def update(conn, params) do
    with :ok <- apply_updates(params) do
      view = ServerSettings.public_view()
      :ok = fanout_changed(view)
      :ok = reapply_auto_away(params)
      json(conn, %{settings: render_view(view)})
    end
  end

  # issue 2359 (ruling: LIVE) — a write that carried `auto_away` reaches the
  # RUNNING sessions too, not only the next spawn. Gated on the KEY having been
  # written (a `null` or `{}` subtree writes nothing) so an upload or dcc save
  # does not wake every session for nothing; the context
  # decides, per session, whether anything moved.
  defp reapply_auto_away(%{"auto_away" => %{"default_debounce_seconds" => _}}),
    do: Session.reapply_auto_away_site_default()

  defp reapply_auto_away(_), do: :ok

  # UX-6-B2 (2026-05-21): fan out the new view on every live
  # `Topic.user(name)`. Mirrors `AdminController.cic_bundle_changed/2`'s
  # `WSPresence.list_user_names/0` iterator + per-target
  # `broadcast_event/2` — same delivery contract (Phoenix Channel
  # fastlane → one WS frame per connected socket on the topic).
  # Telemetry attempted/succeeded/failed lets a downstream PromEx
  # alarm fire on per-target broadcast failure (HIGH-17 lesson:
  # never silently discard per-target return).
  defp fanout_changed(view) do
    payload = SettingsWire.server_settings_changed(view)
    user_names = WSPresence.list_user_names()
    attempted = length(user_names)

    succeeded =
      Enum.count(user_names, fn name ->
        PubSub.broadcast_event(Topic.user(name), payload) == :ok
      end)

    :telemetry.execute(
      [:grappa, :admin, :server_settings_fanout],
      %{attempted: attempted, succeeded: succeeded, failed: attempted - succeeded},
      %{}
    )

    :ok
  end

  # ---- Internal ----------------------------------------------------

  # issue 2546 + 2609 — parse the whole body, probe, then commit ONCE.
  # `parse_updates/1` is PURE (no write, no read, no state) and the only place
  # this door checks a value: it turns the body into the writes
  # `ServerSettings.put_many/1` commits in one transaction, refusing the first
  # bad value. The addressing probe is the one refusal that needs the stored
  # row, so it runs after parsing and before anything is written (#609).
  # Nothing is written until every key has passed, and `put_many/1` writes
  # all of them or — on `:db_unavailable` — none.
  defp apply_updates(params) when is_map(params) do
    with {:ok, writes} <- parse_updates(params),
         :ok <- arm_for(Map.get(params, "addressing"), writes) do
      ServerSettings.put_many(writes)
    end
  end

  defp apply_updates(_), do: {:error, :bad_request}

  defp parse_updates(params) do
    with {:ok, upload} <- parse_subtree(params, "upload", @upload_keys, &parse_upload_key/2),
         {:ok, dcc} <- parse_subtree(params, "dcc", @dcc_keys, &parse_dcc_key/2),
         {:ok, auto_away} <- parse_subtree(params, "auto_away", @auto_away_keys, &parse_auto_away_key/2),
         {:ok, addressing} <- parse_addressing(Map.get(params, "addressing")) do
      {:ok, upload ++ dcc ++ auto_away ++ addressing}
    end
  end

  # A present subtree. Absent → no writes (each is independently optional — an
  # empty body updates nothing); a non-map → bad_request (no silent swallow
  # of a malformed shape). Gate then walk, in that order — see
  # `reject_unknown_keys/3` for why the gate cannot move after the walk.
  defp parse_subtree(params, key, allowed, fun) do
    case Map.get(params, key) do
      nil ->
        {:ok, []}

      subtree when is_map(subtree) ->
        with :ok <- reject_unknown_keys(subtree, allowed, key), do: traverse(Map.to_list(subtree), fun)

      _ ->
        {:error, :bad_request}
    end
  end

  # Collect-or-bail traversal (CLAUDE.md, "Recursive pattern match over
  # `Enum.reduce_while/3`"): every key must parse, the first refusal is the
  # answer.
  defp traverse(pairs, fun), do: traverse(pairs, [], fun)
  defp traverse([], writes, _), do: {:ok, Enum.reverse(writes)}

  defp traverse([{k, v} | rest], writes, fun) do
    case fun.(k, v) do
      {:ok, write} -> traverse(rest, [write | writes], fun)
      {:error, _} = err -> err
    end
  end

  # W-S3 (#1407) — an unrecognised key is a typo, not a forward-compat
  # shape: `AdminSettingsTab` sends a fixed literal set, so nothing but a
  # hand-rolled request can produce one. It used to be logged and dropped
  # while the action still answered 200 with the full view, so an operator
  # who typed `image_per_file_cap` watched a save succeed and change
  # nothing — the "no silent-swallow at boundaries" failure exactly.
  #
  # The check runs BEFORE the fold, so a body mixing a good key with a typo
  # writes nothing: the all-or-nothing posture every sibling admin
  # controller already takes by validating keys before building attrs.
  #
  # The 422 `invalid_setting` envelope is chosen over the siblings' bare
  # `bad_request` because this door already has a `field` vocabulary and
  # cic already reads it (`AdminSettingsTab`'s `err.info.field` highlights
  # the offending input inline). Naming the key IS the fix; a bare 400
  # would leave the operator exactly as uninformed as the 200 did.
  # Sorted, so a body carrying several unknown keys names the same one on
  # every request.
  defp reject_unknown_keys(subtree, allowed, subtree_name) do
    case subtree |> Map.keys() |> Enum.reject(&(&1 in allowed)) |> Enum.sort() do
      [] -> :ok
      [key | _] -> {:error, {:invalid_setting, subtree_name <> "." <> key}}
    end
  end

  # Per-key parse: an accepted value becomes its `ServerSettings.write()`, a
  # refused one names its dotted field. One clause set per key — there is no
  # second, write-side copy to drift from it (issue 2609).
  defp parse_upload_key("active_host", "embedded"), do: {:ok, {:upload_active_host, :embedded}}
  defp parse_upload_key("active_host", "litterbox"), do: {:ok, {:upload_active_host, :litterbox}}

  defp parse_upload_key("active_host", _),
    do: {:error, {:invalid_setting, "upload.active_host"}}

  defp parse_upload_key("image_per_file_cap_bytes", n), do: parse_per_file_cap(:image, n)
  defp parse_upload_key("video_per_file_cap_bytes", n), do: parse_per_file_cap(:video, n)
  defp parse_upload_key("document_per_file_cap_bytes", n), do: parse_per_file_cap(:document, n)
  defp parse_upload_key("audio_per_file_cap_bytes", n), do: parse_per_file_cap(:audio, n)

  defp parse_upload_key("global_cap_bytes", n),
    do: parse_pos_int(:upload_global_cap_bytes, n, "upload.global_cap_bytes")

  # issue 2175 — TWO per-subject ceilings, never one shared knob: a
  # single field would silently move the disposable visitor and the
  # durable account together.
  defp parse_upload_key("per_user_cap_bytes", n),
    do: parse_pos_int(:upload_per_user_cap_bytes, n, "upload.per_user_cap_bytes")

  defp parse_upload_key("per_visitor_cap_bytes", n),
    do: parse_pos_int(:upload_per_visitor_cap_bytes, n, "upload.per_visitor_cap_bytes")

  defp parse_upload_key("video_max_duration_seconds", n),
    do: parse_pos_int(:upload_video_max_duration_seconds, n, "upload.video_max_duration_seconds")

  # No unknown-key clause: `reject_unknown_keys/3` has already refused
  # every key outside `@upload_keys` before this walk begins.

  # ---- dcc.* (issue 2185) — key by key, like `upload` ----------------
  #
  # Neither key's validity depends on the other's value. That independence
  # is the RULING, not an accident — an operator may set the per-transfer
  # ceiling above the spool budget, which only means nothing fits until they
  # raise the budget. Cross-validating would refuse a legal end state to a UI
  # that saves one field at a time.
  defp parse_dcc_key("max_transfer_bytes", n),
    do: parse_pos_int(:dcc_max_transfer_bytes, n, "dcc.max_transfer_bytes")

  defp parse_dcc_key("global_cap_bytes", n),
    do: parse_pos_int(:dcc_global_cap_bytes, n, "dcc.global_cap_bytes")

  # ---- auto_away.* (issue 2359) ---------------------------------------
  #
  # The closed set is `ServerSettings`'s, so the controller does not restate
  # it: `valid_auto_away_default_seconds?/1` IS the ladder. `nil` (JSON
  # null) clears the stored value — the boot fallback applies again.
  defp parse_auto_away_key("default_debounce_seconds", v) do
    if ServerSettings.valid_auto_away_default_seconds?(v),
      do: {:ok, {:auto_away_default_seconds, v}},
      else: {:error, {:invalid_setting, "auto_away.default_debounce_seconds"}}
  end

  # ---- addressing.* — probe-gated (#543 / #609) ----------------------
  #
  # The pure half: closed key set, a mode in the closed set, a prefix that
  # canonicalizes — decided on the BODY alone, mode before prefix (the order a
  # body carrying two bad values is answered in). Nothing here reads the
  # stored row; `arm_for/2` does, and only to probe.
  defp parse_addressing(nil), do: {:ok, []}

  defp parse_addressing(subtree) when is_map(subtree) do
    with :ok <- reject_unknown_keys(subtree, @addressing_keys, "addressing"),
         {:ok, mode} <- parse_addressing_mode(subtree),
         {:ok, prefix} <- parse_addressing_prefix(subtree) do
      {:ok, prefix ++ mode}
    end
  end

  defp parse_addressing(_), do: {:error, :bad_request}

  defp parse_addressing_mode(%{"mode" => "pool_with_reservations"}),
    do: {:ok, [{:addressing_mode, :pool_with_reservations}]}

  defp parse_addressing_mode(%{"mode" => "static_mapping_with_reservations"}),
    do: {:ok, [{:addressing_mode, :static_mapping_with_reservations}]}

  defp parse_addressing_mode(%{"mode" => _}), do: {:error, {:invalid_setting, "addressing.mode"}}
  defp parse_addressing_mode(_), do: {:ok, []}

  # The write carries the CANONICAL prefix — the one the probe runs against.
  defp parse_addressing_prefix(%{"static_mapping_prefix" => value}) do
    case ServerSettings.validate_static_mapping_prefix(value) do
      {:ok, canonical} -> {:ok, [{:static_mapping_prefix, canonical}]}
      {:error, :invalid_prefix} -> {:error, {:invalid_setting, "addressing.static_mapping_prefix"}}
    end
  end

  defp parse_addressing_prefix(_), do: {:ok, []}

  # The probe runs against the RESULTING (mode, prefix) — each from the
  # body's writes or, when the body omits it, the stored row — and BEFORE
  # anything persists, so an unusable mode-2 change never reaches the DB
  # (vjt's order: preflight when the mode is SET, then hard-fail per-address
  # at acquire). No addressing subtree, no probe.
  defp arm_for(nil, _), do: :ok

  defp arm_for(_, writes) do
    arm_if_static(
      target(writes, :addressing_mode, &ServerSettings.addressing_mode/0),
      target(writes, :static_mapping_prefix, &ServerSettings.static_mapping_prefix/0)
    )
  end

  defp target(writes, setting, stored) do
    case List.keyfind(writes, setting, 0) do
      {^setting, value} -> value
      nil -> stored.()
    end
  end

  # Capability gate: a mode-2 target must be armable on THIS substrate before it
  # is stored. `SourceAliasManager.arm/1` probes and, on success, adopts the
  # prefix + publishes armed? (so the set goes live without a reboot, B1); on
  # refusal it changes no state and we surface the concrete reason as 422. Mode
  # 1 (pool) has no substrate prerequisite. A nil prefix under mode 2 cannot arm.
  defp arm_if_static(:static_mapping_with_reservations, nil),
    do: {:error, {:addressing_unusable, :no_static_prefix}}

  defp arm_if_static(:static_mapping_with_reservations, prefix) do
    case SourceAliasManager.arm(prefix) do
      :ok -> :ok
      {:error, reason} -> {:error, {:addressing_unusable, reason}}
    end
  end

  defp arm_if_static(:pool_with_reservations, _), do: :ok

  # The per-file caps delegate to the context's own predicate (issue 2546):
  # issue 2529 deliberately took the guard OUT of this controller and put it
  # in the context, so restating it here would be the regression, not the
  # convention. This door's job is to NAME the field.
  defp parse_per_file_cap(category, n) do
    if ServerSettings.valid_upload_per_file_cap_bytes?(category, n),
      do: {:ok, {:upload_per_file_cap_bytes, category, n}},
      else: {:error, {:invalid_setting, "upload.#{category}_per_file_cap_bytes"}}
  end

  defp parse_pos_int(setting, n, _) when is_integer(n) and n > 0, do: {:ok, {setting, n}}
  defp parse_pos_int(_, _, field), do: {:error, {:invalid_setting, field}}

  # Admin settings view. The `upload` subtree comes from public_view/0 via
  # the shared Wire projection; the `dcc` (issue 2185) and `addressing`
  # (#543) subtrees are admin-only so they are read straight from the
  # accessors — deliberately NOT part of public_view/0, which broadcasts to
  # every cic client. Without `dcc:` here an operator could write the two
  # ceilings and never read back what they wrote.
  defp render_view(%{upload: upload}) do
    %{
      upload: SettingsWire.upload_view(upload),
      dcc: %{
        max_transfer_bytes: ServerSettings.get_dcc_max_transfer_bytes(),
        global_cap_bytes: ServerSettings.get_dcc_global_cap_bytes()
      },
      # issue 2359 — the STORED value (nil = follow the fallback) beside the
      # fallback itself; the RESOLVED one is what `public_view/0` ships.
      auto_away: ServerSettings.auto_away_admin_view(),
      addressing: %{
        mode: ServerSettings.addressing_mode(),
        static_mapping_prefix: ServerSettings.static_mapping_prefix()
      }
    }
  end
end
