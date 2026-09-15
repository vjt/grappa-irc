defmodule GrappaWeb.Admin.SettingsController do
  @moduledoc """
  Admin verbs over `Grappa.ServerSettings`. Behind `:admin_authn` —
  visitor + non-admin user collapse to 403 upstream.

  ## GET /admin/settings

  Returns the admin settings view — the `upload` subtree of
  `public_view/0` plus the admin-only `addressing` (#543) and `dcc` (issue
  2185) subtrees, both read straight from the `Grappa.ServerSettings`
  accessors because neither is part of `public_view/0`. It deliberately
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
        "addressing" => %{
          "mode" => "pool_with_reservations" | "static_mapping_with_reservations",
          "static_mapping_prefix" => String.t()
        }
      }

  All three of `upload`, `dcc` and `addressing` are independently optional
  subtrees, and every key within each is optional — the controller upserts
  only the keys present in the body. Any invalid value (out-of-set
  host/mode string, non-positive integer cap, non-16-bit-group prefix
  length) collapses to 422 `invalid_setting` with the offending dotted key
  in `field`, and so does any key outside the three closed sets above
  (#1407 W-S3) — a typo is named, never absorbed, and it refuses the WHOLE
  body rather than applying the keys it did recognise.

  ⚠️ The two `dcc` keys are NOT cross-validated against each other (vjt,
  issue 2185): a per-transfer ceiling above the spool budget is a legal
  end state, and refusing it would make the ORDER of two writes
  significant for a UI that saves one field at a time.

  On success: 200 with the new full settings view AND fan-out of a
  `server_settings_changed` push on every live `Topic.user(name)`
  for cic reactive update without a poll. Same precedent +
  iterator as `AdminController.cic_bundle_changed/2` (CP23 S4 B5
  cic-bundle fan-out): one broadcast per operator with a live WS.
  Wire-shape lives at `Grappa.ServerSettings.Wire`.

  The intermediate `Grappa.ServerSettings.topic/0` broadcast that
  `put_*/1` emits stays as an in-process signal for tests + any
  future internal subscriber; the cic fan-out path lives HERE
  (single explicit door, parity with `cic_bundle_changed`).
  """

  use GrappaWeb, :controller

  alias Grappa.Net.SourceAliasManager
  alias Grappa.{PubSub, ServerSettings, WSPresence}
  alias Grappa.PubSub.Topic
  alias Grappa.ServerSettings.Wire, as: SettingsWire

  # The three closed key sets. Every entry here MUST have a matching
  # `apply_upload_key/2` / `apply_dcc_key/2` clause (resp. a
  # `resolve_addressing_*` one) — adding a key to one and not the other is
  # caught by that key's own per-key test, loudly, never silently.
  #
  # ⚠️ **"Loudly" is exactly as strong as the per-key test and no stronger,
  # and that was MEASURED rather than assumed (issue 2185, three
  # mutants).** A key WITH a per-key test is caught in both directions:
  # dropping its `apply_dcc_key/2` clauses killed 4 tests, and dropping it
  # from this set while keeping the clauses killed 3. But adding a key
  # that NO test names — `spool_retention_seconds`, no clause, no test —
  # left the suite at **46/46 green**. Nothing structural pairs a set
  # entry with its clause: `reject_unknown_keys/3` compares strings at
  # runtime, so the compiler cannot see the pair, and no test enumerates
  # these sets. A key added here without its per-key test in the SAME pass
  # ships a latent 500 on the first request that uses it.
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
      json(conn, %{settings: render_view(view)})
    end
  end

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

  defp apply_updates(params) when is_map(params) do
    with :ok <- apply_subtree(params, "upload", @upload_keys, &apply_upload_key/2),
         :ok <- apply_subtree(params, "dcc", @dcc_keys, &apply_dcc_key/2) do
      apply_addressing(Map.get(params, "addressing"))
    end
  end

  defp apply_updates(_), do: {:error, :bad_request}

  # Fold a present subtree through its per-key applier. Absent subtree → :ok
  # (each is independently optional — an empty body updates nothing); a
  # non-map subtree → bad_request (no silent swallow of a malformed shape).
  defp apply_subtree(params, key, allowed, fun) do
    case Map.get(params, key) do
      nil ->
        :ok

      subtree when is_map(subtree) ->
        apply_known_keys(subtree, allowed, key, fun)

      _ ->
        {:error, :bad_request}
    end
  end

  # Gate then fold, in that order — see `reject_unknown_keys/3` for why the
  # gate cannot move after the fold. Its own function so neither the guard
  # nor the fold lambda nests inside the shape `case` above.
  defp apply_known_keys(subtree, allowed, key, fun) do
    with :ok <- reject_unknown_keys(subtree, allowed, key) do
      Enum.reduce_while(subtree, :ok, fn {k, v}, _ -> halt_or_cont(fun.(k, v)) end)
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

  # Per-key dispatch so the surrounding fold stays a 2-line lambda
  # and Credo's cyclomatic-complexity check on `apply_updates/1`
  # stays below the 9 ceiling.
  defp apply_upload_key("active_host", "embedded"), do: ServerSettings.put_upload_active_host(:embedded)
  defp apply_upload_key("active_host", "litterbox"), do: ServerSettings.put_upload_active_host(:litterbox)
  defp apply_upload_key("active_host", _), do: {:error, {:invalid_setting, "upload.active_host"}}

  defp apply_upload_key("image_per_file_cap_bytes", n) when is_integer(n) and n > 0,
    do: ServerSettings.put_upload_per_file_cap_bytes(:image, n)

  defp apply_upload_key("image_per_file_cap_bytes", _),
    do: {:error, {:invalid_setting, "upload.image_per_file_cap_bytes"}}

  defp apply_upload_key("video_per_file_cap_bytes", n) when is_integer(n) and n > 0,
    do: ServerSettings.put_upload_per_file_cap_bytes(:video, n)

  defp apply_upload_key("video_per_file_cap_bytes", _),
    do: {:error, {:invalid_setting, "upload.video_per_file_cap_bytes"}}

  defp apply_upload_key("document_per_file_cap_bytes", n) when is_integer(n) and n > 0,
    do: ServerSettings.put_upload_per_file_cap_bytes(:document, n)

  defp apply_upload_key("document_per_file_cap_bytes", _),
    do: {:error, {:invalid_setting, "upload.document_per_file_cap_bytes"}}

  defp apply_upload_key("audio_per_file_cap_bytes", n) when is_integer(n) and n > 0,
    do: ServerSettings.put_upload_per_file_cap_bytes(:audio, n)

  defp apply_upload_key("audio_per_file_cap_bytes", _),
    do: {:error, {:invalid_setting, "upload.audio_per_file_cap_bytes"}}

  defp apply_upload_key("global_cap_bytes", n) when is_integer(n) and n > 0,
    do: ServerSettings.put_upload_global_cap_bytes(n)

  defp apply_upload_key("global_cap_bytes", _),
    do: {:error, {:invalid_setting, "upload.global_cap_bytes"}}

  # issue 2175 — TWO per-subject ceilings, never one shared knob: a
  # single field would silently move the disposable visitor and the
  # durable account together.
  defp apply_upload_key("per_user_cap_bytes", n) when is_integer(n) and n > 0,
    do: ServerSettings.put_upload_per_user_cap_bytes(n)

  defp apply_upload_key("per_user_cap_bytes", _),
    do: {:error, {:invalid_setting, "upload.per_user_cap_bytes"}}

  defp apply_upload_key("per_visitor_cap_bytes", n) when is_integer(n) and n > 0,
    do: ServerSettings.put_upload_per_visitor_cap_bytes(n)

  defp apply_upload_key("per_visitor_cap_bytes", _),
    do: {:error, {:invalid_setting, "upload.per_visitor_cap_bytes"}}

  defp apply_upload_key("video_max_duration_seconds", n) when is_integer(n) and n > 0,
    do: ServerSettings.put_upload_video_max_duration_seconds(n)

  defp apply_upload_key("video_max_duration_seconds", _),
    do: {:error, {:invalid_setting, "upload.video_max_duration_seconds"}}

  # No unknown-key clause: `reject_unknown_keys/3` has already refused
  # every key outside `@upload_keys` before this fold begins.

  # ---- dcc.* (issue 2185) — key by key, like `upload` ----------------
  #
  # Per-key rather than addressing's unit apply, because there is no probe
  # and no ordering constraint to preserve: neither key's validity depends
  # on the other's value. That independence is the RULING, not an
  # accident — an operator may set the per-transfer ceiling above the
  # spool budget, which only means nothing fits until they raise the
  # budget. Cross-validating would make the order of two writes
  # significant and break a UI that saves one field at a time.
  defp apply_dcc_key("max_transfer_bytes", n) when is_integer(n) and n > 0,
    do: ServerSettings.put_dcc_max_transfer_bytes(n)

  defp apply_dcc_key("max_transfer_bytes", _),
    do: {:error, {:invalid_setting, "dcc.max_transfer_bytes"}}

  defp apply_dcc_key("global_cap_bytes", n) when is_integer(n) and n > 0,
    do: ServerSettings.put_dcc_global_cap_bytes(n)

  defp apply_dcc_key("global_cap_bytes", _),
    do: {:error, {:invalid_setting, "dcc.global_cap_bytes"}}

  # ---- addressing.* — probe-gated unit apply (#543 / #609) ----------
  #
  # Unlike `upload`, the addressing subtree is applied as a UNIT, not key by
  # key: the #609 capability probe must run against the RESULTING (mode, prefix)
  # — each taken from the body or, when the body omits it, the current row — and
  # it must run BEFORE anything persists so an unusable mode-2 change never
  # reaches the DB (vjt's order: preflight when the mode is SET, then hard-fail
  # per-address at acquire).
  defp apply_addressing(nil), do: :ok

  defp apply_addressing(subtree) when is_map(subtree) do
    with :ok <- reject_unknown_keys(subtree, @addressing_keys, "addressing"),
         {:ok, mode} <- resolve_addressing_mode(subtree),
         {:ok, prefix} <- resolve_addressing_prefix(subtree),
         :ok <- arm_if_static(mode, prefix),
         :ok <- persist_addressing_prefix(subtree),
         :ok <- persist_addressing_mode(subtree) do
      :ok
    end
  end

  defp apply_addressing(_), do: {:error, :bad_request}

  # Target mode = the body's mode (validated against the closed set) or, when
  # the body omits it, the currently stored mode.
  defp resolve_addressing_mode(%{"mode" => "pool_with_reservations"}),
    do: {:ok, :pool_with_reservations}

  defp resolve_addressing_mode(%{"mode" => "static_mapping_with_reservations"}),
    do: {:ok, :static_mapping_with_reservations}

  defp resolve_addressing_mode(%{"mode" => _}),
    do: {:error, {:invalid_setting, "addressing.mode"}}

  defp resolve_addressing_mode(_), do: {:ok, ServerSettings.addressing_mode()}

  # Target prefix = the body's prefix (validated + canonicalized, no persist)
  # or, when the body omits it, the currently stored prefix (may be nil).
  defp resolve_addressing_prefix(%{"static_mapping_prefix" => value}) when is_binary(value) do
    case ServerSettings.validate_static_mapping_prefix(value) do
      {:ok, canonical} -> {:ok, canonical}
      {:error, :invalid_prefix} -> {:error, {:invalid_setting, "addressing.static_mapping_prefix"}}
    end
  end

  defp resolve_addressing_prefix(%{"static_mapping_prefix" => _}),
    do: {:error, {:invalid_setting, "addressing.static_mapping_prefix"}}

  defp resolve_addressing_prefix(_), do: {:ok, ServerSettings.static_mapping_prefix()}

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

  # Persist only the keys the body carried (both already validated above).
  # Prefix first, then mode, so mode 2 is never stored ahead of the prefix it
  # needs.
  defp persist_addressing_prefix(%{"static_mapping_prefix" => value}) when is_binary(value) do
    case ServerSettings.put_static_mapping_prefix(value) do
      :ok -> :ok
      # #523/#518 — transient DB saturation → :db_unavailable → clean 503,
      # NOT the 422 an invalid-setting tuple would render.
      {:error, :db_unavailable} = err -> err
      {:error, :invalid_prefix} -> {:error, {:invalid_setting, "addressing.static_mapping_prefix"}}
    end
  end

  defp persist_addressing_prefix(_), do: :ok

  defp persist_addressing_mode(%{"mode" => "pool_with_reservations"}),
    do: ServerSettings.put_addressing_mode(:pool_with_reservations)

  defp persist_addressing_mode(%{"mode" => "static_mapping_with_reservations"}),
    do: ServerSettings.put_addressing_mode(:static_mapping_with_reservations)

  defp persist_addressing_mode(_), do: :ok

  # Translate per-key return to Enum.reduce_while continuation. `:ok`
  # → continue; `{:error, _}` → halt with the error preserved.
  defp halt_or_cont(:ok), do: {:cont, :ok}
  defp halt_or_cont({:error, _} = err), do: {:halt, err}

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
      addressing: %{
        mode: ServerSettings.addressing_mode(),
        static_mapping_prefix: ServerSettings.static_mapping_prefix()
      }
    }
  end
end
