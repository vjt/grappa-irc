defmodule GrappaWeb.ChannelsController do
  @moduledoc """
  Channel-tree read surface (`index/2`) + upstream JOIN / PART / TOPIC
  (`create/2` + `delete/2` + `topic/2`) for the per-(subject, network)
  session.

  Subject-dispatched (Task 30): every action reads `:current_subject`
  from `conn.assigns` (plumbed by `Plugs.Authn`) — a tagged tuple
  `{:user, %User{}} | {:visitor, %Visitor{}}` carrying the loaded
  struct (M-web-1). The `Grappa.Session.send_*` API speaks the leaner
  ID-tuple shape (`{:user, id} | {:visitor, id}`); the conversion
  goes through `GrappaWeb.Subject.to_session/1`. The URL `:network_id`
  slug → schema struct resolution + per-subject iso check happens in
  `GrappaWeb.Plugs.ResolveNetwork`; this controller reads
  `conn.assigns.network` and never re-resolves.

  ## index

  `GET /networks/:network_id/channels` returns the union of the
  subject's autojoin source (user → `Credential.autojoin_channels`,
  visitor → `Visitors.list_autojoin_channels/1`) and the live
  session-tracked channel set (`Grappa.Session.list_channels/2`).
  Wire shape per channel: `%{name, joined, source}` where `:source`
  is `:autojoin` for autojoin-declared entries (winner on overlap,
  Q3 pin) and `:joined` for dynamically-joined-only entries.

  Per-subject iso is enforced by `Plugs.ResolveNetwork` upstream —
  visitor's `network_slug` mismatch and user's missing-credential
  both surface as the same uniform `404 {"error": "not_found"}` body
  so probers cannot distinguish.

  ## create / delete / topic

  All require an active session for the network — without one,
  `Grappa.Session.send_*` returns `{:error, :no_session}` which the
  `FallbackController` maps to a uniform 404 `{"error": "not_found"}`
  (CP10 S14 oracle close). Persistence of JOIN/PART events into
  scrollback lands in Phase 5.
  """
  use GrappaWeb, :controller

  import GrappaWeb.Validation, only: [validate_channel_name: 1, validate_channel_list: 1]

  alias Grappa.Accounts.User
  alias Grappa.{Networks, Session, Visitors}
  alias Grappa.Networks.{Credentials, Network}
  alias GrappaWeb.{BodyLimit, Subject}

  @doc """
  `GET /networks/:network_id/channels` — lists the subject's channels
  for the network, with live joined-state.

  Composes the subject's autojoin source with the live
  `Grappa.Session.list_channels/2` snapshot (Q3-pinned: autojoin wins
  on overlap). Result is sorted alphabetically by `name` for stable
  rendering.
  """
  @spec index(Plug.Conn.t(), map()) :: Plug.Conn.t() | {:error, :not_found}
  def index(conn, _) do
    network = conn.assigns.network
    subject = conn.assigns.current_subject

    with {:ok, autojoin} <- subject_autojoin(subject, network) do
      # A SESSION THAT DOES NOT ANSWER STILL OWES THE AUTOJOIN HALF (issue
      # 2239, vjt's ruling). `Networks.session_channels_degrading/3` yields `[]`
      # on a timeout and logs it, so the tree below is autojoin-only rather
      # than a 504 — and that is deliberately NOT what the archive door does.
      #
      # Measured on cic, which is why this door does not propagate: this is a
      # `#717 boot-critical` GET, `lib/networks.ts` builds `channelsBySlug` with
      # `Promise.all` over every network, and that resource gates the splash.
      # One rejection rejects the whole thing, and `bootFetch` retries no HTTP
      # response of any status — so a 504 here leaves one stuck session blocking
      # cic's boot for EVERY network, which is the symptom that filed the issue.
      live = Networks.session_channels_degrading(Subject.to_session(subject), network, "GET /channels")

      entries = Networks.merge_channel_sources(autojoin, live)
      render(conn, :index, channels: entries)
    end
  end

  defp subject_autojoin({:user, user}, network) do
    with {:ok, credential} <- Credentials.get_credential(user, network) do
      {:ok, credential.autojoin_channels}
    end
  end

  defp subject_autojoin({:visitor, visitor}, network) do
    # #211 phase 4c — read the visitor's PER-NETWORK rejoin list from its
    # `(visitor_id, network_id)` Credential, NOT the single
    # `visitors.last_joined_channels` scalar (a multi-network visitor has a
    # distinct channel set per network). Network-scoped by the request
    # (`conn.assigns.network`). No credential on this network → empty list
    # (the visitor hasn't attached / joined anything there yet).
    {:ok, Visitors.list_autojoin_channels(visitor, network.id)}
  end

  @doc """
  `POST /networks/:network_id/channels` — body `{"name": "#chan"}` or
  `{"name": "#chan", "key": "secret"}` (UX-4 bucket F +k channel
  support). Calls through to `Session.send_join/4`, which writes
  `window_states[ch] = :pending` AND broadcasts `window_pending` on the
  user-level PubSub topic before returning. cic's setPending dispatch
  has fired (and the synthetic sidebar pseudo-row has rendered) by the
  time this returns 202 + `{"ok": true}`.

  #382 — `name` accepts the RFC1459 comma-separated channel LIST
  (`"#a,#b,#c"`); `validate_channel_list/1` requires EVERY element to be
  a valid channel (a malformed member fails the WHOLE request with 400,
  no partial JOIN) and `Session.send_join/4` forwards ONE multi-target
  JOIN line + opens a `:pending` window per channel. A single channel is
  a list-of-one, so the single-channel body is unchanged. Key-list
  (`JOIN #a,#b k1,k2`) is out of scope: a single `key` applies to the
  whole multi-join.

  The key (when present) is forwarded to the upstream JOIN frame as
  the +k channel key. It is NOT persisted to autojoin and NOT logged
  in scrollback. A wrong/missing key surfaces server-side as 475
  ERR_BADCHANNELKEY through the existing join-failure pipeline →
  `:join_failed` event with numeric=475 → cic surfaces the failure
  in the synthetic pseudo-row (state=:failed).

  issue 2114 / issue 2703 — a JOIN that arrives before the session has
  registered (no socket yet in the reconnect backoff, or a socket that is
  up before 001) is 202 as well, not 400: the session holds it and sends
  it at 001, and the `:pending` window this returns behind is the honest
  state either way. A `DELETE` for the same channel before then cancels
  the held JOIN. The 400 `not_connected` is left to the case the session
  cannot outlive.
  """
  @spec create(Plug.Conn.t(), map()) ::
          Plug.Conn.t()
          | {:error, :bad_request | :no_session | :invalid_line | :not_connected | :timeout}
  def create(conn, %{"name" => name} = params)
      when is_binary(name) and name != "" do
    subject = Subject.to_session(conn.assigns.current_subject)
    network = conn.assigns.network
    key = normalize_join_key_param(Map.get(params, "key"))

    with :ok <- validate_channel_list(name),
         :ok <- validate_optional_key(key),
         :ok <- Session.send_join(subject, network.id, name, key) do
      conn
      |> put_status(:accepted)
      |> json(%{ok: true})
    end
  end

  def create(_, _), do: {:error, :bad_request}

  # The wire body accepts `null`, missing, or a binary key. Normalise
  # `""` to `nil` so the empty-key form maps to "no key" downstream
  # (mirrors `Session.send_join/4`'s normalize_join_key).
  defp normalize_join_key_param(nil), do: nil
  defp normalize_join_key_param(""), do: nil
  defp normalize_join_key_param(key) when is_binary(key), do: key
  defp normalize_join_key_param(_), do: :bad_key

  defp validate_optional_key(nil), do: :ok
  defp validate_optional_key(:bad_key), do: {:error, :bad_request}

  defp validate_optional_key(key) when is_binary(key) do
    if byte_size(key) <= 64 and Grappa.IRC.Identifier.safe_line_token?(key) and
         not String.contains?(key, [" ", "\t"]),
       do: :ok,
       else: {:error, :bad_request}
  end

  # #1208 — the optional `?reason=` query param for DELETE (PART). Validated
  # UP FRONT, like `validate_channel_name/1` and `validate_optional_key/1` are
  # for their fields: `delete/2` removes the channel from autojoin BEFORE it
  # casts the PART, so a reason refused any later would leave a rejected
  # request with the leave already half-applied.
  #
  # Non-binary is `:bad_request` — a repeated key (`?reason[]=a&reason[]=b`)
  # reaches Plug as a list, and a list must not fall through to a binary
  # guard. CR/LF/NUL is `:invalid_line`, not `:bad_request`: the reason is
  # otherwise free text, so smuggling a second IRC command behind the trailing
  # `:` is the ONLY thing wrong with it, which is exactly the distinction
  # `FallbackController` keeps that tag for. `BodyLimit` owns the byte cap,
  # like it does for every other user-text field bound for the wire.
  #
  # `Session.send_part/4` re-checks CR/LF/NUL at the domain boundary, as
  # `send_join/4` does for its key: this controller is one door into PART,
  # not the only one.
  #
  # An absent param falls back to the subject's remembered leave message
  # (issue 2150) and, failing that, to `nil` — which frames the bare PART,
  # the pre-#1208 behaviour for every caller that never learns this param
  # exists. A subject with no stored default is therefore byte-identical
  # on the wire to before this setting existed.
  #
  # The stored value skips the two checks above it, and legitimately:
  # `UserSettings.put_quit_part_reason/3` refused CR/LF/NUL AT SAVE TIME
  # and bounded the bytes there, so a stored reason is safe by
  # construction — that is the whole point of validating at save rather
  # than at use. `Session.send_part/4` re-checks at the domain boundary
  # anyway, as it does for every caller.
  @spec part_reason(map(), Grappa.Session.subject()) ::
          {:ok, String.t() | nil} | {:error, :bad_request | :invalid_line | :body_too_large}
  defp part_reason(%{"reason" => reason}, _) when is_binary(reason) do
    with :ok <- BodyLimit.check(reason) do
      if Grappa.IRC.Identifier.safe_line_token?(reason),
        do: {:ok, reason},
        else: {:error, :invalid_line}
    end
  end

  defp part_reason(%{"reason" => _}, _), do: {:error, :bad_request}
  defp part_reason(_, subject), do: {:ok, Grappa.UserSettings.get_quit_part_reason(subject)}

  @doc """
  `DELETE /networks/:network_id/channels/:channel_id` — casts
  `PART <channel_id>` upstream AND removes the channel from the
  credential's `autojoin_channels` list (if present).

  Both ops run unconditionally: the PART fires even if the channel is
  not in autojoin (e.g. a manually-joined `source: :joined` channel),
  and the autojoin removal is a no-op when the channel is not in the
  list. Returns 202 + `{"ok": true}`.

  Optional `?reason=<text>` (#1208) becomes the PART message
  (`PART <channel> :<reason>`). Absent or empty leaves the wire frame
  byte-identical to the pre-#1208 bare form.
  """
  @spec delete(Plug.Conn.t(), map()) ::
          Plug.Conn.t()
          | {:error, :bad_request | :no_session | :invalid_line | :body_too_large}
  def delete(conn, %{"channel_id" => channel} = params) do
    subject = Subject.to_session(conn.assigns.current_subject)
    network = conn.assigns.network

    # Order matters: remove from autojoin (DB UPDATE) BEFORE send_part
    # (which broadcasts `channels_changed`). The broadcast triggers
    # cic's `refetchChannels` GET /channels; that read merges the
    # credential's `autojoin_channels` with `Session.list_channels/2`.
    # If the UPDATE hasn't committed yet when the GET reads
    # network_credentials, the response includes the removed channel
    # as `source: :autojoin` and the sidebar row never goes away.
    # Pre-fix race window was ~5ms (DB write latency); under load it
    # widened. e2e suite saw it as the cp15-b6/r6/bughunt-1-b/m9
    # rotating-victim cascade. (E2E-ROBUSTNESS bucket D follow-up.)
    # #1208 — `part_reason/1` is FIRST in the chain on purpose: a refused
    # reason must not leave the autojoin UPDATE below already applied, or a
    # 400 would still have half-performed the leave.
    with {:ok, reason} <- part_reason(params, subject),
         :ok <- validate_channel_name(channel),
         :ok <- remove_from_autojoin(conn.assigns.current_subject, network, channel),
         :ok <- Session.send_part(subject, network.id, channel, reason) do
      # #459 — archive_changed is broadcast by the SESSION when `send_part`
      # applies the PART (drops the channel from the active set), NOT here.
      # This action used to fire it optimistically right after the async cast,
      # before the PART applied, so cic's GET /archive refetch read a stale
      # (still-active) keyset and dropped the just-closed channel from the
      # archive (issue71-inc2 guardrail-1 flake + a real user-visible
      # stale-archive defect). See `Session.Server.handle_cast({:send_part, _})`.
      conn
      |> put_status(:accepted)
      |> json(%{ok: true})
    end
  end

  # Removes `channel` from the subject's persistent autojoin source so a
  # leave actually sticks. The source differs per subject but the "leave
  # intent" is identical (#87, 2026-06-26):
  #   * user    → `Credential.autojoin_channels`
  #   * visitor → `Visitor.last_joined_channels` (its snapshot IS the
  #               autojoin source — `Visitors.list_autojoin_channels/1`).
  # Pre-#87 the visitor branch was a no-op ("visitors have no persistent
  # credential"), which was wrong: a PART of a stale autojoin entry the
  # visitor was not live-joined to (so the session had no membership to
  # snapshot away) left the channel in `GET /channels` forever — the
  # un-dismissable tab the bug report hit. Visitors are NOT second-class:
  # the same door removes from the same kind of source.
  #
  # M16 (REV-D 2026-05-22): pre-fix this was a silent-swallow at the
  # boundary — failure was logged + the controller still returned 202.
  # Next reconnect re-joined a channel the user explicitly left,
  # invisibly. Now propagates `{:error, _}` so `FallbackController`
  # surfaces the failure to cic (422/404 per the changeset shape).
  # The IRC-side PART already went through; this only gates the
  # persistence side of the "leave the channel" intent.
  @spec remove_from_autojoin(
          {:user, User.t()} | {:visitor, Visitors.Visitor.t()},
          Network.t(),
          String.t()
        ) :: :ok | {:error, term()}
  defp remove_from_autojoin({:user, user}, %Network{} = network, channel) do
    case Credentials.remove_autojoin_channel(user, network, channel) do
      {:ok, _} ->
        :ok

      {:error, _} = err ->
        err
    end
  end

  defp remove_from_autojoin({:visitor, %Visitors.Visitor{} = visitor}, %Network{id: network_id}, channel) do
    # #211 phase 4c — remove from the visitor's PER-NETWORK credential
    # rejoin list (network-scoped by the request), not the single scalar.
    case Visitors.remove_autojoin_channel(visitor, network_id, channel) do
      {:ok, _} ->
        :ok

      {:error, _} = err ->
        err
    end
  end

  @doc """
  `POST /networks/:network_id/channels/:channel_id/topic` — body
  `{"body": "new topic"}`. Casts `TOPIC <channel> :<body>` upstream
  through the subject's session. Upstream echoes back and EventRouter
  persists the canonical `:topic` scrollback row + broadcasts (single
  write path, closes #22 duplicate-display).
  """
  @spec topic(Plug.Conn.t(), map()) ::
          Plug.Conn.t() | {:error, :bad_request | :no_session | :invalid_line}
  def topic(conn, %{"channel_id" => channel, "body" => body})
      when is_binary(body) and body != "" do
    subject = Subject.to_session(conn.assigns.current_subject)
    network = conn.assigns.network

    with :ok <- BodyLimit.check(body),
         :ok <- validate_channel_name(channel),
         :ok <- Session.send_topic(subject, network.id, channel, body) do
      conn
      |> put_status(:accepted)
      |> json(%{ok: true})
    end
  end

  def topic(_, _), do: {:error, :bad_request}
end
