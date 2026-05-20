defmodule Grappa.AdminEvents.Wire do
  @moduledoc """
  Single source of truth for the public JSON wire shapes broadcast on
  `Grappa.PubSub.Topic.admin_events/0` (M-cluster M-11).

  ## Closed-union discipline

  Every constructor below pattern-matches on a closed `kind:` atom
  union. `from_telemetry/3` is intentionally NOT total — adding a new
  `:telemetry.attach_many/4` entry in `Grappa.AdminEvents` WITHOUT a
  matching `from_telemetry/3` arm raises `FunctionClauseError` at
  runtime in the AdminEvents GenServer, surfacing on the next
  emission. Mirror of `Grappa.Session.Wire.members_seeded/3` pattern.

  Cic-side enforces the same exhaustiveness via the `WireAdminEvent`
  discriminated union + `assertNever` in
  `cicchetto/src/lib/adminEvents.ts`. Per `feedback_no_silent_drops_closed`
  every union arm walks both sides.

  ## No localized strings on the wire

  Per CLAUDE.md "Don't bake human-readable strings into bodies/wire"
  the server emits structured fields only (ids, atoms-as-strings,
  ISO-8601 timestamps, typed enums). Human-readable rendering for the
  Events tab lives in `cicchetto/src/AdminEventsTab.tsx` `renderEvent`.

  ## Actor attribution

  Admin-mutation events (`:visitor_deleted`, `:session_disconnected`,
  `:session_terminated`, `:network_caps_updated`, `:circuit_reset`)
  carry `actor_user_id` + `actor_user_name`. Both `nil` for
  system-initiated events (`bin/grappa` rpc-eval verbs, scheduled
  reaper sweeps). Cic renders "by <name>" only when both are set.

  Admission-side telemetry events (`:circuit_open`, `:circuit_close`,
  `:capacity_reject`) DO NOT carry actor attribution — they fire
  inside admission-layer modules with no controller-side conn in
  scope. M-12 audit-hardening is the place to thread actor through
  `NetworkCircuit.reset/2` if operator audit value requires it
  (today the `:circuit_reset` synthetic event covers the
  operator-driven reset surface).
  """

  alias Grappa.Networks

  @typedoc "Closed enum of admin event kinds. Mirror on cic side: `WireAdminEvent[\"kind\"]`."
  @type event_kind ::
          :circuit_open
          | :circuit_close
          | :capacity_reject
          | :visitor_deleted
          | :visitor_reaped
          | :reaper_swept
          | :upload_reaped
          | :uploads_swept
          | :session_disconnected
          | :session_terminated
          | :network_caps_updated
          | :circuit_reset
          | :cap_counts_changed

  @type circuit_open_event :: %{
          kind: :circuit_open,
          network_id: integer(),
          network_slug: String.t() | nil,
          threshold: integer(),
          cooldown_ms: integer(),
          at: String.t()
        }

  @type circuit_close_event :: %{
          kind: :circuit_close,
          network_id: integer(),
          network_slug: String.t() | nil,
          reason: :success | :cooldown_expired,
          at: String.t()
        }

  @type capacity_reject_event :: %{
          kind: :capacity_reject,
          flow: atom(),
          error: String.t(),
          network_id: integer(),
          network_slug: String.t() | nil,
          client_id: String.t() | nil,
          at: String.t()
        }

  @type visitor_deleted_event :: %{
          kind: :visitor_deleted,
          visitor_id: String.t(),
          visitor_nick: String.t() | nil,
          network_slug: String.t() | nil,
          actor_user_id: String.t() | nil,
          actor_user_name: String.t() | nil,
          at: String.t()
        }

  @type visitor_reaped_event :: %{
          kind: :visitor_reaped,
          visitor_id: String.t(),
          visitor_nick: String.t() | nil,
          network_slug: String.t() | nil,
          at: String.t()
        }

  @type reaper_swept_event :: %{
          kind: :reaper_swept,
          count: non_neg_integer(),
          at: String.t()
        }

  @type upload_reaped_event :: %{
          kind: :upload_reaped,
          upload_id: String.t(),
          slug: String.t(),
          subject_kind: :user | :visitor,
          subject_id: String.t(),
          at: String.t()
        }

  @type uploads_swept_event :: %{
          kind: :uploads_swept,
          count: non_neg_integer(),
          at: String.t()
        }

  @type session_disconnected_event :: %{
          kind: :session_disconnected,
          subject_kind: :user | :visitor,
          subject_id: String.t(),
          network_id: integer(),
          network_slug: String.t() | nil,
          actor_user_id: String.t() | nil,
          actor_user_name: String.t() | nil,
          at: String.t()
        }

  @type session_terminated_event :: %{
          kind: :session_terminated,
          subject_kind: :user | :visitor,
          subject_id: String.t(),
          network_id: integer(),
          network_slug: String.t() | nil,
          actor_user_id: String.t() | nil,
          actor_user_name: String.t() | nil,
          at: String.t()
        }

  @type network_caps_updated_event :: %{
          kind: :network_caps_updated,
          network_id: integer(),
          network_slug: String.t(),
          max_concurrent_visitor_sessions: integer() | nil,
          max_concurrent_user_sessions: integer() | nil,
          max_per_client: integer() | nil,
          actor_user_id: String.t() | nil,
          actor_user_name: String.t() | nil,
          at: String.t()
        }

  @type circuit_reset_event :: %{
          kind: :circuit_reset,
          network_id: integer(),
          network_slug: String.t() | nil,
          actor_user_id: String.t() | nil,
          actor_user_name: String.t() | nil,
          at: String.t()
        }

  @type cap_counts_changed_event :: %{
          kind: :cap_counts_changed,
          network_id: integer(),
          network_slug: String.t() | nil,
          visitors: non_neg_integer(),
          users: non_neg_integer(),
          max_concurrent_visitor_sessions: integer() | nil,
          max_concurrent_user_sessions: integer() | nil,
          at: String.t()
        }

  @type event ::
          circuit_open_event()
          | circuit_close_event()
          | capacity_reject_event()
          | visitor_deleted_event()
          | visitor_reaped_event()
          | reaper_swept_event()
          | upload_reaped_event()
          | uploads_swept_event()
          | session_disconnected_event()
          | session_terminated_event()
          | network_caps_updated_event()
          | circuit_reset_event()
          | cap_counts_changed_event()

  ## ----- Constructors --------------------------------------------------
  ##
  ## Each constructor renders one of the closed-union arms documented in
  ## the moduledoc. Bodies are intentionally thin (struct shape + `at:
  ## now()`); the per-kind contract is enforced by the function head's
  ## `when` guards (visitor delete with empty visitor_id, network caps
  ## with empty slug, etc. all fail loud).

  @doc false
  @spec circuit_open(integer(), String.t() | nil, integer(), integer()) :: circuit_open_event()
  def circuit_open(network_id, network_slug, threshold, cooldown_ms)
      when is_integer(network_id) and (is_binary(network_slug) or is_nil(network_slug)) and
             is_integer(threshold) and is_integer(cooldown_ms) do
    %{
      kind: :circuit_open,
      network_id: network_id,
      network_slug: network_slug,
      threshold: threshold,
      cooldown_ms: cooldown_ms,
      at: now()
    }
  end

  @doc false
  @spec circuit_close(integer(), String.t() | nil, :success | :cooldown_expired) ::
          circuit_close_event()
  def circuit_close(network_id, network_slug, reason)
      when is_integer(network_id) and (is_binary(network_slug) or is_nil(network_slug)) and
             reason in [:success, :cooldown_expired] do
    %{
      kind: :circuit_close,
      network_id: network_id,
      network_slug: network_slug,
      reason: reason,
      at: now()
    }
  end

  @doc false
  @spec capacity_reject(atom(), term(), integer(), String.t() | nil, String.t() | nil) ::
          capacity_reject_event()
  def capacity_reject(flow, error, network_id, network_slug, client_id)
      when is_atom(flow) and is_integer(network_id) and
             (is_binary(network_slug) or is_nil(network_slug)) and
             (is_binary(client_id) or is_nil(client_id)) do
    %{
      kind: :capacity_reject,
      flow: flow,
      error: error_to_string(error),
      network_id: network_id,
      network_slug: network_slug,
      client_id: client_id,
      at: now()
    }
  end

  @doc false
  @spec visitor_deleted(
          String.t(),
          String.t() | nil,
          String.t() | nil,
          String.t() | nil,
          String.t() | nil
        ) :: visitor_deleted_event()
  def visitor_deleted(visitor_id, visitor_nick, network_slug, actor_user_id, actor_user_name)
      when is_binary(visitor_id) and (is_binary(visitor_nick) or is_nil(visitor_nick)) and
             (is_binary(network_slug) or is_nil(network_slug)) do
    :ok = validate_actor(actor_user_id, actor_user_name)

    %{
      kind: :visitor_deleted,
      visitor_id: visitor_id,
      visitor_nick: visitor_nick,
      network_slug: network_slug,
      actor_user_id: actor_user_id,
      actor_user_name: actor_user_name,
      at: now()
    }
  end

  @doc false
  @spec visitor_reaped(String.t(), String.t() | nil, String.t() | nil) :: visitor_reaped_event()
  def visitor_reaped(visitor_id, visitor_nick, network_slug)
      when is_binary(visitor_id) and (is_binary(visitor_nick) or is_nil(visitor_nick)) and
             (is_binary(network_slug) or is_nil(network_slug)) do
    %{
      kind: :visitor_reaped,
      visitor_id: visitor_id,
      visitor_nick: visitor_nick,
      network_slug: network_slug,
      at: now()
    }
  end

  @doc false
  @spec reaper_swept(non_neg_integer()) :: reaper_swept_event()
  def reaper_swept(count) when is_integer(count) and count >= 0 do
    %{kind: :reaper_swept, count: count, at: now()}
  end

  @doc false
  @spec upload_reaped(String.t(), String.t(), :user | :visitor, String.t()) ::
          upload_reaped_event()
  def upload_reaped(upload_id, slug, subject_kind, subject_id)
      when is_binary(upload_id) and is_binary(slug) and subject_kind in [:user, :visitor] and
             is_binary(subject_id) do
    %{
      kind: :upload_reaped,
      upload_id: upload_id,
      slug: slug,
      subject_kind: subject_kind,
      subject_id: subject_id,
      at: now()
    }
  end

  @doc false
  @spec uploads_swept(non_neg_integer()) :: uploads_swept_event()
  def uploads_swept(count) when is_integer(count) and count >= 0 do
    %{kind: :uploads_swept, count: count, at: now()}
  end

  @doc false
  @spec session_disconnected(
          :user | :visitor,
          String.t(),
          integer(),
          String.t() | nil,
          String.t() | nil,
          String.t() | nil
        ) :: session_disconnected_event()
  def session_disconnected(
        subject_kind,
        subject_id,
        network_id,
        network_slug,
        actor_user_id,
        actor_user_name
      )
      when subject_kind in [:user, :visitor] and is_binary(subject_id) and
             is_integer(network_id) and
             (is_binary(network_slug) or is_nil(network_slug)) do
    :ok = validate_actor(actor_user_id, actor_user_name)

    %{
      kind: :session_disconnected,
      subject_kind: subject_kind,
      subject_id: subject_id,
      network_id: network_id,
      network_slug: network_slug,
      actor_user_id: actor_user_id,
      actor_user_name: actor_user_name,
      at: now()
    }
  end

  @doc false
  @spec session_terminated(
          :user | :visitor,
          String.t(),
          integer(),
          String.t() | nil,
          String.t() | nil,
          String.t() | nil
        ) :: session_terminated_event()
  def session_terminated(
        subject_kind,
        subject_id,
        network_id,
        network_slug,
        actor_user_id,
        actor_user_name
      )
      when subject_kind in [:user, :visitor] and is_binary(subject_id) and
             is_integer(network_id) and
             (is_binary(network_slug) or is_nil(network_slug)) do
    :ok = validate_actor(actor_user_id, actor_user_name)

    %{
      kind: :session_terminated,
      subject_kind: subject_kind,
      subject_id: subject_id,
      network_id: network_id,
      network_slug: network_slug,
      actor_user_id: actor_user_id,
      actor_user_name: actor_user_name,
      at: now()
    }
  end

  @doc false
  @spec network_caps_updated(
          integer(),
          String.t(),
          integer() | nil,
          integer() | nil,
          integer() | nil,
          String.t() | nil,
          String.t() | nil
        ) :: network_caps_updated_event()
  def network_caps_updated(
        network_id,
        network_slug,
        max_concurrent_visitor_sessions,
        max_concurrent_user_sessions,
        max_per_client,
        actor_user_id,
        actor_user_name
      ) do
    :ok =
      validate_caps_args(
        network_id,
        network_slug,
        max_concurrent_visitor_sessions,
        max_concurrent_user_sessions,
        max_per_client
      )

    :ok = validate_actor(actor_user_id, actor_user_name)

    %{
      kind: :network_caps_updated,
      network_id: network_id,
      network_slug: network_slug,
      max_concurrent_visitor_sessions: max_concurrent_visitor_sessions,
      max_concurrent_user_sessions: max_concurrent_user_sessions,
      max_per_client: max_per_client,
      actor_user_id: actor_user_id,
      actor_user_name: actor_user_name,
      at: now()
    }
  end

  # Split out to keep `network_caps_updated/7` below Credo's
  # cyclomatic-complexity gate. The 7-arg signature has too many
  # `when` clauses to fit a single head — splitting into two arg-
  # group validators keeps each below the gate while preserving the
  # fail-loud invariant.
  defp validate_caps_args(
         network_id,
         network_slug,
         max_concurrent_visitor_sessions,
         max_concurrent_user_sessions,
         max_per_client
       )
       when is_integer(network_id) and is_binary(network_slug) and network_slug != "" and
              (is_integer(max_concurrent_visitor_sessions) or
                 is_nil(max_concurrent_visitor_sessions)) and
              (is_integer(max_concurrent_user_sessions) or
                 is_nil(max_concurrent_user_sessions)) and
              (is_integer(max_per_client) or is_nil(max_per_client)),
       do: :ok

  # Shared actor validator across every actor-bearing constructor
  # (visitor_deleted, session_disconnected, session_terminated,
  # network_caps_updated, circuit_reset). M-11 reviewer HIGH-4:
  # actor_user_id + actor_user_name must be BOTH binary or BOTH nil —
  # half-attribution silently drops on the cic side, where
  # `renderEvent` only shows "by <name>" when both are set. Crashing
  # at the boundary forces honest call sites.
  defp validate_actor(nil, nil), do: :ok
  defp validate_actor(id, name) when is_binary(id) and is_binary(name), do: :ok

  @doc false
  @spec circuit_reset(integer(), String.t() | nil, String.t() | nil, String.t() | nil) ::
          circuit_reset_event()
  def circuit_reset(network_id, network_slug, actor_user_id, actor_user_name)
      when is_integer(network_id) and (is_binary(network_slug) or is_nil(network_slug)) do
    :ok = validate_actor(actor_user_id, actor_user_name)

    %{
      kind: :circuit_reset,
      network_id: network_id,
      network_slug: network_slug,
      actor_user_id: actor_user_id,
      actor_user_name: actor_user_name,
      at: now()
    }
  end

  @doc """
  Derived live-counts event emitted by the AdminEvents sink on
  `[:grappa, :session, :lifecycle, :spawned | :terminated]`.

  Unlike `:session_terminated` (operator-attributed, fires only on
  explicit terminate verbs from admin controllers), this event fires
  on EVERY lifecycle transition — boot-time spawn, crash-respawn,
  graceful shutdown, link-death — and carries the projection
  `Admission.live_counts_for_network/1` would compute right after the
  transition. No actor attribution: this is the anonymous counts
  surface the Networks tab subscribes to.

  The `visitors`/`users` field shape mirrors
  `Admission.live_counts_for_network/1`'s return map so cic can read
  one shape across the live broadcast AND the cold-state
  `GET /admin/networks` `live_counts` projection (S8 of U-5 review:
  one wire shape per logical field, no rename adapters).

  Caps echoed on every event so the cic Networks tab doesn't need a
  parallel `GET /admin/networks` round-trip to re-render the
  denominator after a `PATCH /networks/:id` lands — the next
  cap_counts_changed carries the new cap directly.
  """
  @spec cap_counts_changed(
          integer(),
          String.t() | nil,
          %{visitors: non_neg_integer(), users: non_neg_integer()},
          integer() | nil,
          integer() | nil
        ) :: cap_counts_changed_event()
  def cap_counts_changed(
        network_id,
        network_slug,
        %{visitors: v, users: u} = counts,
        max_visitor_sessions,
        max_user_sessions
      ) do
    :ok =
      validate_cap_counts_args(
        network_id,
        network_slug,
        counts,
        max_visitor_sessions,
        max_user_sessions
      )

    %{
      kind: :cap_counts_changed,
      network_id: network_id,
      network_slug: network_slug,
      visitors: v,
      users: u,
      max_concurrent_visitor_sessions: max_visitor_sessions,
      max_concurrent_user_sessions: max_user_sessions,
      at: now()
    }
  end

  # Split out to keep `cap_counts_changed/5` below Credo's cyclomatic
  # gate. Two helpers (one per arg cluster) per `validate_caps_args/5`
  # pattern; both raise FunctionClauseError on shape violation.
  defp validate_cap_counts_args(
         network_id,
         network_slug,
         %{visitors: v, users: u},
         max_visitor_sessions,
         max_user_sessions
       )
       when is_integer(network_id) and (is_binary(network_slug) or is_nil(network_slug)) do
    :ok = validate_cap_count_pair(v, u)
    :ok = validate_cap_max_pair(max_visitor_sessions, max_user_sessions)
    :ok
  end

  defp validate_cap_count_pair(v, u)
       when is_integer(v) and v >= 0 and is_integer(u) and u >= 0,
       do: :ok

  defp validate_cap_max_pair(max_v, max_u)
       when (is_integer(max_v) or is_nil(max_v)) and (is_integer(max_u) or is_nil(max_u)),
       do: :ok

  ## ----- Telemetry adapter ---------------------------------------------

  @doc """
  Translate a `:telemetry.execute/3` triple into an admin event. Closed
  union — `:operator_reset` reason for circuit_close is INTENTIONALLY
  unmatched: the operator-driven path emits a `:circuit_reset` synthetic
  event via `Grappa.AdminEvents.record/1` with actor attribution, so
  the telemetry-side `:operator_reset` would double-emit. Returning
  `:skip` lets the GenServer no-op cleanly without duplicating the
  surface.

  Adding a new `:telemetry.attach_many/4` event in
  `Grappa.AdminEvents`'s `init/1` callback WITHOUT a matching
  `from_telemetry/3` arm here raises `FunctionClauseError` — exact
  closed-union signal per `feedback_no_silent_drops_closed`.
  """
  @spec from_telemetry([atom()], map(), map()) :: event() | :skip
  def from_telemetry(
        [:grappa, :admission, :circuit, :open],
        _,
        %{network_id: nid, threshold: t, cooldown_ms: c}
      ) do
    circuit_open(nid, lookup_slug(nid), t, c)
  end

  def from_telemetry(
        [:grappa, :admission, :circuit, :close],
        _,
        %{network_id: _, reason: :operator_reset}
      ) do
    :skip
  end

  def from_telemetry(
        [:grappa, :admission, :circuit, :close],
        _,
        %{network_id: nid, reason: r}
      )
      when r in [:success, :cooldown_expired] do
    circuit_close(nid, lookup_slug(nid), r)
  end

  def from_telemetry(
        [:grappa, :admission, :capacity, :reject],
        _,
        %{flow: f, error: e, network_id: nid, client_id: cid}
      ) do
    capacity_reject(f, e, nid, lookup_slug(nid), cid)
  end

  ## ----- Private --------------------------------------------------------

  @spec now() :: String.t()
  defp now, do: DateTime.to_iso8601(DateTime.utc_now())

  # Lookup the slug for an admission-side telemetry event. `nil` is the
  # honest signal that the network row was deleted between the event
  # firing and the slug lookup (rare; cic renders `net#<id>` fallback).
  @spec lookup_slug(integer()) :: String.t() | nil
  defp lookup_slug(network_id) when is_integer(network_id) do
    case Networks.get_network(network_id) do
      nil -> nil
      net -> net.slug
    end
  end

  # `:capacity_reject` error metadata can be an atom
  # (`:visitor_cap_exceeded`, `:user_cap_exceeded`, `:client_cap_exceeded`),
  # a tuple (`{:network_circuit_open, 60_000}`), or any term — collapse
  # to a stable string for the wire. Atoms stay readable; tuples become
  # an `inspect/1` for operator audit value.
  @spec error_to_string(term()) :: String.t()
  defp error_to_string(e) when is_atom(e), do: Atom.to_string(e)
  defp error_to_string(e), do: inspect(e)
end
