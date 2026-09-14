defmodule GrappaWeb.NetworksController do
  @moduledoc """
  `GET /networks` — lists the authenticated subject's bound networks.
  `PATCH /networks/:network_id` — T32 connection_state transitions.

  Cicchetto (Phase 3 PWA) calls GET on app boot to render the
  network → channel tree. Two subject branches, both list-shaped since
  #211 phase 6:

    * **user** — `Credentials.list_credentials_for_user/1` returns
      every credential row the user has bound. Per-user iso is
      load-bearing: a user only sees networks they have a credential
      on.
    * **visitor** — `Credentials.list_visitor_credentials/1` returns
      one row per attached network (multi-network since phase 4c
      accretion). The visitor twin of the user branch (ruling A):
      per-network live-nick + the (now-real) `connection_state`. The
      pre-phase-6 singular `visitor.network_slug` → `[single network]`
      branch is retired — the scalar is dropped from the wire this
      phase (the column at phase 7).

  PATCH is subject-agnostic since #211 phase 6 (ruling D): BOTH users
  and visitors park/reconnect a network through it — visitors carry a
  real `connection_state` now, so the visitor `POST /session/{disconnect,
  reconnect}` pair is RETIRED in favor of this one verb. The
  `ResolveNetwork` plug provides the ownership check for either subject:
  a caller patching a network they hold no credential on gets a uniform
  404 from the plug so credential existence is not leaked.

  ## T32 connection_state transitions

  Clients may only set `:connected` or `:parked`. `:failed` is a
  server-internal terminal state (k-line / permanent SASL failure —
  see plan S1.4 lenient triggers). A request to set `:failed` returns
  400.

  On `:connected` transition: the controller delegates to
  `Grappa.SpawnOrchestrator.spawn/4` for the admission check +
  `Backoff.reset` + `Session.start_session/3` dance (cluster #8 —
  shared with `Grappa.Bootstrap`). The `Networks.connect/1` context
  fn only does the DB write + PubSub broadcast (no spawn) — spawn
  lives in the orchestrator per the S1.2 boundary note: `Networks`
  must not dep `Admission` to avoid a cycle, and the orchestrator's
  own top-level boundary deps both freely.

  Wire shapes live in `Grappa.Networks.Wire` — `network_with_nick_to_json/4`
  (user GET row), `visitor_network_to_json/4` (visitor GET row), and
  `credential_to_json/1` (PATCH). The view layer (`NetworksJSON`) is a
  thin delegator.
  """
  use GrappaWeb, :controller

  alias Grappa.Accounts.User
  alias Grappa.Avatars
  alias Grappa.IRC.Identifier
  alias Grappa.{Networks, ServerSettings, Session, Uploads, UserSettings}
  alias Grappa.Networks.{Credential, Credentials, SessionPlan}
  alias Grappa.Visitors.Visitor
  alias GrappaWeb.{NetworkSpawn, Subject}

  require Logger

  # M3a — mirrors `GrappaWeb.UploadsController`'s exact declaration:
  # consumed by the Sobelow analyzer (not the Elixir compiler) for the
  # `@sobelow_skip` annotations on the avatar-upload file-read helpers
  # below. Without this, `@sobelow_skip` would emit "module attribute
  # set but never used" and fail `mix compile --warnings-as-errors`.
  Module.register_attribute(__MODULE__, :sobelow_skip, accumulate: true, persist: true)

  @doc "`GET /networks` — list of network metadata for the bearer's subject."
  @spec index(Plug.Conn.t(), map()) :: Plug.Conn.t()
  def index(conn, _) do
    case conn.assigns.current_subject do
      {:user, user} ->
        credentials = Credentials.list_credentials_for_user(user)

        # BUG1-FIX: use the live IRC nick from the running Session rather
        # than the credential's configured nick. The two diverge whenever
        # NickServ forces a ghost/regain recovery suffix or the operator
        # issues /nick. Cicchetto uses this nick to subscribe to the
        # own-nick DM topic — a stale nick silently drops all inbound DMs.
        # Fall back to credential nick when the session is parked/failed.
        # `Networks.resolve_network_nick/2` is the single-sourced lookup
        # shared with `Networks.home_data_for_user/1` (UX-4 bucket B).
        #
        # T32 (CP19 parked-window): the credential is also threaded through
        # so the wire shape can carry the T32 connection-state fields cic
        # needs to derive the per-network + cascading per-channel greyed
        # treatment. nick stays the live-vs-configured Session.Server
        # value; T32 fields come straight off the credential row of record.
        network_rows =
          Enum.map(credentials, fn cred ->
            subject = {:user, user.id}

            {cred.network, Networks.resolve_network_nick(subject, cred), cred,
             resolve_connection_info(subject, cred.network_id)}
          end)

        render(conn, :index, networks: {:user, network_rows})

      {:visitor, visitor} ->
        # #211 phase 6 — list-shaped visitor branch (ruling A). A visitor
        # is multi-network now (phase 4c accretion): return ONE row per
        # attached network — the visitor twin of the user branch, via the
        # 4c reader `Credentials.list_visitor_credentials/1` (`WHERE
        # visitor_id ==`, `:network` preloaded, subject-blind-safe). Each
        # row carries the live-nick-with-fallback + the credential's
        # `connection_state` (ruling D: visitors carry a real
        # connection_state now). Replaces the pre-phase-6 singular
        # `visitor.network_slug` → `[single network]` branch (the scalar
        # is dropped from the wire this phase, the column at phase 7).
        credentials = Credentials.list_visitor_credentials(visitor.id)

        network_rows =
          Enum.map(credentials, fn cred ->
            subject = {:visitor, visitor.id}

            {cred.network, Networks.resolve_network_nick(subject, cred), cred,
             resolve_connection_info(subject, cred.network_id)}
          end)

        render(conn, :index, networks: {:visitor, network_rows})
    end
  end

  # #474 B — resolve the LIVE upstream connection facts for a /networks row, or
  # nil when there is no live connected session (parked / failed / no pid) — the
  # honest "no connection" the server-window rail renders as an absent card.
  # Same live-vs-DB split as `resolve_network_nick/2`: these facts come from the
  # running Session.Server, never the credential row of record.
  @spec resolve_connection_info(Session.subject(), integer()) ::
          Session.connection_info() | nil
  defp resolve_connection_info(subject, network_id) do
    case Session.connection_info(subject, network_id) do
      {:ok, info} -> info
      {:error, _} -> nil
    end
  end

  @doc """
  `PATCH /networks/:network_id` — T32 connection_state transition.

  Accepts `{connection_state: "parked" | "connected", reason: string|nil}`.
  `:failed` is server-set only — returns 400 to the caller.

  #211 phase 6 — subject-agnostic (ruling D): BOTH users and visitors
  park/reconnect a network through this ONE verb. The `ResolveNetwork`
  plug already gated ownership (user → credential, visitor → credential),
  so `conn.assigns.network` is the caller's own network and
  `conn.assigns.current_subject` names who. The visitor
  disconnect/reconnect `POST /session/{disconnect,reconnect}` pair is
  RETIRED in favor of this — visitors are now equal to users on the
  connection-state surface.
  """
  @spec update(Plug.Conn.t(), map()) ::
          Plug.Conn.t()
          | {:error, :bad_request | :forbidden | :not_found | :not_connected}
  def update(conn, params) do
    with {:ok, target_state} <- parse_connection_state(params),
         {:ok, reason} <- parse_reason(params),
         {:ok, credential} <-
           fetch_credential(conn.assigns.current_subject, conn.assigns.network),
         {:ok, updated_cred} <-
           apply_transition(conn, conn.assigns.current_subject, credential, target_state, reason) do
      render(conn, :update, credential: updated_cred)
    end
  end

  @doc """
  `PATCH /networks/:network_id/identity` — #211 phase 6 (ruling E, subsumes
  original #211): per-network IRC identity edit (`nick` + `ident` +
  `realname`) for BOTH subjects, live-applied via an internal reconnect.

  Identity is per-`(subject, network)` credential (the same nick may be
  in use on other networks), so this edits ONE network's credential. The
  `ResolveNetwork` plug asserts ownership (a caller with no credential on
  the network 404s). On success the upstream is RE-REGISTERED so the new
  ident/realname/nick take effect: ident/realname ride the once-only USER
  line (no live verb), so applying to a live session means a bounce — via
  the shared `SpawnOrchestrator.reconnect/5` (phase 5), wrapped HERE in
  the web layer (never the Networks context — that closes the
  `Networks → SpawnOrchestrator → Admission → Networks` Boundary cycle,
  DESIGN_NOTES 2026-07-11). A parked/no-live-session edit persists only;
  the next spawn reads the row.

  #211 phase 7 — the per-network credential is the SINGLE identity write
  path for BOTH subjects. The phase-6 visitor primary-network scalar
  dual-write is GONE: the `visitors.nick`/`network_slug` scalars are
  dropped, and `find_or_provision_anon`'s login-lookup resolves
  credential-first (`resolve_identity_by_nick/2`, keyed on the credential's
  `(fold(nick), network_id)`), so there is no row scalar left to keep in
  sync.

  Body: `{nick?, ident?, realname?}` — all optional. 200 with the updated
  credential; 422 on validation (bad nick / folded-nick collision); 404
  if the credential vanished; 401 without a Bearer.
  """
  @spec identity(Plug.Conn.t(), map()) ::
          Plug.Conn.t()
          | {:error, :bad_request | :not_found | Ecto.Changeset.t()}
  def identity(conn, params) do
    subject = conn.assigns.current_subject
    network = conn.assigns.network

    with {:ok, attrs} <- parse_identity_attrs(params),
         {:ok, credential} <- fetch_credential(subject, network),
         {:ok, updated_cred} <- Credentials.update_credential_identity(credential, attrs) do
      # #211 phase 7 — the visitor-row scalar dual-write is GONE: identity
      # lives ONLY on the `(subject, network)` credential now, and login
      # resolves it credential-first. The per-network door is the single
      # write path for BOTH subjects.
      :ok = live_apply_identity(subject, network, updated_cred)
      render(conn, :update, credential: updated_cred)
    end
  end

  @doc """
  `PATCH /networks/:network_id/profile` — the KVIrc-style CTCP USERINFO
  profile (age/gender/location/languages/a free custom field), per
  `(subject, network)` for BOTH subjects. Unlike `/identity`, this never
  bounces the live session: these fields don't ride the IRC handshake,
  they only feed `Grappa.Session.EventRouter`'s CTCP USERINFO auto-reply
  — see `Credentials.update_credential_profile/2` for how a live session
  picks up the change without reconnecting.

  Body: `{age?, gender?, location?, languages?, custom?}` — all optional
  strings; `gender` must be one of `Credential.genders/0` (`male`,
  `female`, `nonbinary`) or blank (`""`) to clear. 200 with the updated
  credential; 422 on validation (CRLF injection, over the byte cap, an
  unrecognised gender); 404 if the credential vanished; 401 without a
  Bearer.
  """
  @spec profile(Plug.Conn.t(), map()) ::
          Plug.Conn.t()
          | {:error, :bad_request | :not_found | Ecto.Changeset.t()}
  def profile(conn, params) do
    subject = conn.assigns.current_subject
    network = conn.assigns.network

    with {:ok, attrs} <- parse_profile_attrs(params),
         {:ok, credential} <- fetch_credential(subject, network),
         {:ok, updated_cred} <- Credentials.update_credential_profile(credential, attrs) do
      render(conn, :update, credential: updated_cred)
    end
  end

  @doc """
  `PUT /networks/:network_id/avatar` — M3a: uploads (or replaces) the
  credential's own avatar, per `(subject, network)` for BOTH subjects.
  Sibling of `/profile` in every respect that matters: it never bounces
  the live session either (the avatar doesn't ride the IRC handshake,
  only `Grappa.Session.EventRouter`'s CTCP AVATAR auto-reply) — see
  `Credentials.set_avatar/3` for the live-update-without-reconnect
  mechanism.

  Multipart body: `file` — binary, required, image only. Reuses the
  SAME MIME allowlist + per-category cap `POST /api/uploads` enforces
  for `:image` (`GrappaWeb.UploadsController.mime_categories/0` +
  `ServerSettings.get_upload_per_file_cap_bytes/1`) — an avatar is
  stored via the identical `Grappa.Uploads` pipeline
  (`MetadataStrip`-scrubbed, same MIME/size boundary checks), just
  PERMANENT (`expires_at: nil`) instead of TTL'd, and linked to the
  credential instead of standing alone.

  200 with the updated credential (carrying the new `avatar_url`); 400
  on a missing/unreadable file; 415 on a non-image MIME; 413 over the
  per-file cap; 507 over the global cap OR the uploader's own
  per-subject quota (issue 2175 — an avatar is an `uploads` row owned
  by the subject, so it spends the same budget as any other upload);
  404 if the credential vanished; 401 without a Bearer.
  """
  @spec avatar(Plug.Conn.t(), map()) ::
          Plug.Conn.t()
          | {:error, :bad_request | :not_found | :unsupported_media_type | Ecto.Changeset.t()}
  def avatar(conn, params) do
    subject = conn.assigns.current_subject
    network = conn.assigns.network

    with {:ok, upload} <- extract_avatar_field(params),
         {:ok, mime} <- validate_avatar_mime(upload),
         :ok <- check_avatar_per_file_cap(upload),
         {:ok, bytes} <- read_avatar_file(upload),
         :ok <-
           Uploads.check_caps(
             Subject.to_session(subject),
             byte_size(bytes),
             ServerSettings.upload_caps()
           ),
         {:ok, credential} <- fetch_credential(subject, network),
         {:ok, updated_cred} <- Credentials.set_avatar(credential, bytes, mime) do
      render(conn, :update, credential: updated_cred)
    end
  end

  @doc """
  `DELETE /networks/:network_id/avatar` — M3a: removes the credential's
  own avatar, per `(subject, network)` for BOTH subjects. Same
  never-bounces-the-session posture as `PUT` above.

  200 with the updated credential (`avatar_url: null`) — a no-op
  success when there was no avatar to begin with, not a 404; 404 only
  if the credential itself vanished; 401 without a Bearer.
  """
  @spec delete_avatar(Plug.Conn.t(), map()) ::
          Plug.Conn.t() | {:error, :not_found | Ecto.Changeset.t()}
  def delete_avatar(conn, _) do
    subject = conn.assigns.current_subject
    network = conn.assigns.network

    with {:ok, credential} <- fetch_credential(subject, network),
         {:ok, updated_cred} <- Credentials.clear_avatar(credential) do
      render(conn, :update, credential: updated_cred)
    end
  end

  @doc """
  `GET /networks/:network_id/peer_avatar/:slug` — M3b: serves a cached
  PEER avatar's sanitized bytes. Deliberately NOT the public, unauth'd
  `GET /uploads/:slug` shape — a peer's declared CTCP AVATAR URL is
  untrusted content grappa fetched on their behalf, never something the
  operator's own user chose to publish, so it stays behind the SAME
  `:authn` + `:resolve_network` gate every other `/networks/:network_id/*`
  route already has (ownership: any live credential on this network).

  The lookup is scoped to the RESOLVED network, not to the slug alone —
  `:resolve_network` proves a credential on the network in the path and
  nothing beyond it, so `Avatars.get_by_slug/2` takes that network's id
  and the "ownership on this network" clause above is enforced rather
  than merely intended.

  200 with the image bytes; 404 for a bad slug, a missing/expired row, a
  row cached for a different network, or a row whose file went missing
  (no oracle — same collapse `UploadsController.show/2` uses); 401
  without a Bearer; 403/404 (via `:resolve_network`) for a network the
  caller has no credential on.

  `path` comes from `Avatars.storage_path/1`, which validates the slug
  against `^[a-z2-7]{26}$` before joining it — same guard
  `Uploads.storage_path/2` gives `UploadsController.show/2`'s identical
  shape. `bytes` is sanitized file content, not attacker-supplied HTML —
  Sobelow can't follow either provenance across the module boundary.
  """
  @sobelow_skip ["Traversal.FileModule", "XSS.SendResp"]
  @spec peer_avatar(Plug.Conn.t(), map()) :: Plug.Conn.t()
  def peer_avatar(conn, %{"slug" => slug}) when is_binary(slug) do
    with {:ok, row} <- Avatars.get_by_slug(conn.assigns.network.id, slug),
         path = Avatars.storage_path(row.slug),
         {:ok, bytes} <- File.read(path) do
      conn
      |> put_resp_header("content-type", row.mime)
      |> put_resp_header("x-content-type-options", "nosniff")
      |> put_resp_header("cache-control", "private, max-age=3600")
      |> send_resp(200, bytes)
    else
      _ ->
        conn |> put_status(:not_found) |> json(%{error: "not_found"})
    end
  end

  def peer_avatar(conn, _), do: conn |> put_status(:not_found) |> json(%{error: "not_found"})

  @doc """
  `PUT /networks/:network_id/password` — #124: the per-network PASSWORD field,
  for BOTH subjects. One field, one stored secret.

  Sibling of `/identity` rather than a key on it, deliberately. The password is
  WRITE-ONLY (identity round-trips), it needs its own changeset and Azzurra's
  services-side validation, and its blank semantics are the OPPOSITE of
  identity's: there, `""` is a deliberate "clear to default"; here a blank is a
  400, because clearing the secret an operator identifies with must never be
  something a form submits by accident.

  Live-applied by the same internal reconnect `/identity` uses: the secret is
  read at connect, so a live session has to re-register to identify with the
  new value — which is the entire point of the field. A parked / no-session
  edit persists only.

  Body: `{password}` — required, non-blank. 200 with the updated credential,
  which says nothing about the stored secret: not the value, and deliberately
  not even its set-ness (pinned by the write-only test). 400 on a missing or blank
  password; 422 when services would refuse it (spaces / under 5 / over 32 bytes
  / control codes / equal to the nick); 404 if the credential vanished; 401
  without a Bearer.
  """
  @spec update_password(Plug.Conn.t(), map()) ::
          Plug.Conn.t()
          | {:error, :bad_request | :not_found | Ecto.Changeset.t()}
  def update_password(conn, params) do
    subject = conn.assigns.current_subject
    network = conn.assigns.network

    with {:ok, password} <- parse_password(params),
         {:ok, credential} <- fetch_credential(subject, network),
         {:ok, updated} <- Credentials.update_credential_password(credential, password) do
      :ok = live_apply_identity(subject, network, updated)
      render(conn, :update, credential: updated)
    end
  end

  # A password is REQUIRED here — unlike the identity fields, an absent or
  # blank one is not "leave alone" but a malformed request. Leave-blank-to-keep
  # lives in the CLIENT (it simply does not call this endpoint when the input is
  # empty); encoding it here would make "clear my password" and "I typed
  # nothing" the same request, and one of those must never happen by accident.
  @spec parse_password(map()) :: {:ok, String.t()} | {:error, :bad_request}
  defp parse_password(%{"password" => pw}) when is_binary(pw) and pw != "", do: {:ok, pw}
  defp parse_password(_), do: {:error, :bad_request}

  @doc """
  GH #189 — GET the on-connect perform list for this `(subject, network)`.

  Returns `{perform_list, oper_pass_set}`: the raw command list (nil when
  unset) plus a boolean for whether the write-only `$oper_pass` secret is set.
  The secret itself is NEVER returned — write-only, like a password. 404 if the
  credential vanished; 401 without a Bearer.

  #124 removed the `nickserv_pass_set` sibling: `$nickserv_pass` expands from
  the credential password now, whose set-ness no surface reports at all — the
  password door is write-only end to end. #1044's server `PASS` has its own
  `GET /networks/:network_id/server_pass`, not a key here: that secret belongs
  to registration, not to the perform list.
  """
  @spec perform(Plug.Conn.t(), map()) :: Plug.Conn.t() | {:error, :not_found}
  def perform(conn, _) do
    subject = conn.assigns.current_subject
    network = conn.assigns.network

    with {:ok, credential} <- fetch_credential(subject, network) do
      render(conn, :perform, perform: perform_wire(credential))
    end
  end

  @doc """
  GH #189 — PUT the on-connect perform list + `$oper_pass`.

  Body: `{perform_list?, oper_pass?}` — both optional; `""` clears a field,
  omitting the secret keeps it (leave-blank-to-keep). Persists ONLY: there is
  no live verb, since the list is read at 001. A live session applies it on its
  next (re)connect (the plan is re-resolved on every `Session.Server` restart).
  200 with `{perform_list, oper_pass_set}`; 422 on validation (NUL / over-cap /
  CRLF in the secret); 404 if the credential vanished; 401 without a Bearer.

  #124 retired the `nickserv_pass` body key — that secret has ONE home now, the
  credential password, written through `PUT /networks/:network_id/password`.
  A body still carrying the key earns a 410 rather than a silent drop, so a
  stale cached client cannot pretend it saved a password.
  """
  @spec update_perform(Plug.Conn.t(), map()) ::
          Plug.Conn.t()
          | {:error, :not_found | :nickserv_pass_retired | Ecto.Changeset.t()}
  def update_perform(conn, params) do
    subject = conn.assigns.current_subject
    network = conn.assigns.network

    with :ok <- reject_retired_nickserv_pass(params),
         {:ok, credential} <- fetch_credential(subject, network),
         {:ok, updated} <- Credentials.update_perform_list(credential, perform_attrs(params)) do
      render(conn, :perform, perform: perform_wire(updated))
    end
  end

  @doc """
  GH #1044 — GET the server `PASS` set-ness for this `(subject, network)`.

  Returns `{server_pass_set}` and never the value: write-only, exactly like
  `$oper_pass` on the perform surface. 404 if the credential vanished; 401
  without a Bearer.
  """
  @spec server_pass(Plug.Conn.t(), map()) :: Plug.Conn.t() | {:error, :not_found}
  def server_pass(conn, _) do
    subject = conn.assigns.current_subject
    network = conn.assigns.network

    with {:ok, credential} <- fetch_credential(subject, network) do
      render(conn, :server_pass, server_pass: server_pass_wire(credential))
    end
  end

  @doc """
  GH #1044 — PUT the server `PASS`, the secret a password-gated network
  demands before registration.

  A sibling of `/password` rather than a key on it, and for the reason the
  whole issue exists: they are two different secrets with two different
  destinations, and one field editing both is the state this replaces.

  Body: `{server_pass}` — `""` clears, omitting the key keeps the stored one
  (leave-blank-to-keep). Persists ONLY: the secret is spent during
  registration, so a live session picks it up on its next (re)connect — this
  endpoint deliberately does not bounce a working connection the way
  `/password` does, since that one changes what an ALREADY-registered
  session would do next.

  200 with `{server_pass_set}`; 422 on a value that is not a single wire
  token (spaces / CR / LF / NUL) or on a visitor credential, which cannot
  spend this secret at all; 404 if the credential vanished; 401 without a
  Bearer.
  """
  @spec update_server_pass(Plug.Conn.t(), map()) ::
          Plug.Conn.t() | {:error, :not_found | Ecto.Changeset.t()}
  def update_server_pass(conn, params) do
    subject = conn.assigns.current_subject
    network = conn.assigns.network

    with {:ok, credential} <- fetch_credential(subject, network),
         {:ok, updated} <- Credentials.update_server_pass(credential, server_pass_attrs(params)) do
      render(conn, :server_pass, server_pass: server_pass_wire(updated))
    end
  end

  # ---------------------------------------------------------------------------
  # Private helpers
  # ---------------------------------------------------------------------------

  # #1044 — pick ONLY the secret from the body (string keys), dropping the
  # `:network_id` route param and any stray key before the changeset casts.
  # Mirror of `perform_attrs/1`.
  @spec server_pass_attrs(map()) :: map()
  defp server_pass_attrs(params), do: Map.take(params, ["server_pass"])

  # #1044 — the wire shape: set-ness only. The secret is NEVER serialised,
  # the same write-only posture `$oper_pass` has on the perform surface.
  @spec server_pass_wire(Credential.t()) :: %{server_pass_set: boolean()}
  defp server_pass_wire(%Credential{} = credential) do
    %{server_pass_set: Credential.upstream_server_pass(credential) != nil}
  end

  # Only `:connected` and `:parked` are user-settable. `:failed` is
  # server-set only (k-line / permanent SASL — S1.4 lenient triggers);
  # returning :bad_request keeps the public surface closed without
  # leaking that `:failed` is a valid DB state.
  @spec parse_connection_state(map()) ::
          {:ok, Credential.connection_state()} | {:error, :bad_request}
  defp parse_connection_state(%{"connection_state" => "connected"}), do: {:ok, :connected}
  defp parse_connection_state(%{"connection_state" => "parked"}), do: {:ok, :parked}
  defp parse_connection_state(%{"connection_state" => _}), do: {:error, :bad_request}
  defp parse_connection_state(_), do: {:error, :bad_request}

  # Optional reason string. Validated for CRLF/NUL safety so it can be
  # forwarded upstream as the IRC QUIT reason without injection risk.
  @spec parse_reason(map()) :: {:ok, String.t() | nil} | {:error, :bad_request}
  defp parse_reason(%{"reason" => reason}) when is_binary(reason) do
    if Identifier.safe_line_token?(reason),
      do: {:ok, reason},
      else: {:error, :bad_request}
  end

  defp parse_reason(_), do: {:ok, nil}

  # #211 phase 6 — subject-agnostic credential fetch. Both branches are
  # `WHERE <subject>_id ==` (subject-blind-safe): a user can't reach a
  # visitor credential and vice versa. `ResolveNetwork` already asserted
  # the caller owns a credential on this network, so a miss here is a
  # concurrent unbind, not an authz probe.
  @spec fetch_credential(GrappaWeb.Subject.t(), Grappa.Networks.Network.t()) ::
          {:ok, Credential.t()} | {:error, :not_found}
  defp fetch_credential({:user, %User{} = user}, network),
    do: Credentials.get_credential(user, network)

  defp fetch_credential({:visitor, %Visitor{id: vid}}, %{id: nid}),
    do: Credentials.get_visitor_credential(vid, nid)

  # #189 — pick ONLY the perform-list fields from the request body
  # (string keys). The `:network_id` route param and any stray keys are
  # dropped before the changeset casts; `Credential.perform_changeset/2`
  # validates the values (NUL / byte cap / oper_pass CRLF).
  @spec perform_attrs(map()) :: map()
  defp perform_attrs(params), do: Map.take(params, ["perform_list", "oper_pass"])

  # #124 — a `nickserv_pass` key in the body is REFUSED, loudly, rather than
  # dropped by the `Map.take/2` above. cic is a PWA: a service-worker-cached
  # bundle predating #124 still carries the retired input, and silently
  # discarding its write is exactly the silent-swallow the boundary rule
  # forbids — the operator would watch a password "save" and go on failing to
  # identify, which is the split brain #124 exists to end. 410 Gone, naming the
  # door that replaced it.
  @spec reject_retired_nickserv_pass(map()) :: :ok | {:error, :nickserv_pass_retired}
  defp reject_retired_nickserv_pass(params) do
    if Map.has_key?(params, "nickserv_pass"),
      do: {:error, :nickserv_pass_retired},
      else: :ok
  end

  # #189 — the perform wire shape: the raw list text (nil when unset) + a
  # boolean for whether the write-only `$oper_pass` secret is set. The secret
  # itself is NEVER serialised (write-only, like a password). #124 dropped the
  # `nickserv_pass_set` sibling along with the field it described.
  @spec perform_wire(Credential.t()) :: %{
          perform_list: String.t() | nil,
          oper_pass_set: boolean()
        }
  defp perform_wire(%Credential{} = credential) do
    %{
      perform_list: Credential.perform_list_text(credential),
      oper_pass_set: Credential.upstream_oper_pass(credential) != nil
    }
  end

  # Dispatch to the right context fn based on the target state. Both
  # transitions are subject-agnostic since phase 6 — `Networks.disconnect/2`
  # + `Networks.connect/1` derive the subject from the credential's XOR FK.
  @spec apply_transition(
          Plug.Conn.t(),
          GrappaWeb.Subject.t(),
          Credential.t(),
          Credential.connection_state(),
          String.t() | nil
        ) :: {:ok, Credential.t()} | {:error, atom()}
  defp apply_transition(_, subject, credential, :parked, reason) do
    Networks.disconnect(credential, reason || parked_reason(subject))
  end

  defp apply_transition(conn, subject, credential, :connected, _) do
    # U-0 stop-swallow fix (2026-05-16): spawn FIRST against the
    # parked credential, THEN commit the DB transition to `:connected`
    # only on spawn success. Pre-U-0, `Networks.connect/1` committed
    # first and `spawn_session_after_connect/3` swallowed every error
    # — cap-saturated PATCH /connect returned 200 OK with row at
    # `:connected` while no Session.Server was running, and subsequent
    # `POST /messages` 404'd silently. Per CLAUDE.md "REST is for
    # resources" + the no-silent-drops cluster lesson, the failure
    # must surface honestly at the REST boundary.
    #
    # **Concurrent-PATCH safety**: two simultaneous PATCH /connect on
    # the same parked credential are benign. SpawnOrchestrator.spawn/4
    # dedupes via `:already_started` (second request gets the live
    # pid, no second Session.Server); `Networks.connect/1` short-
    # circuits on `:connected` (second request's DB write is a no-op +
    # idempotent broadcast). No orphan process, no DB drift. Cic
    # tolerates the duplicate broadcast since `connection_state_changed`
    # is idempotent at the wire-edge.
    with {:ok, plan} <- resolve_plan(subject, credential, conn.assigns.network),
         {:ok, _} <- NetworkSpawn.orchestrate(conn, subject, credential, plan),
         {:ok, updated_cred} <- Networks.connect(credential) do
      {:ok, updated_cred}
    end
  end

  # issue 2150 — the leave message, in precedence order: the one this
  # request carried, else the subject's remembered default, else the
  # `"user-disconnect"` literal every park has sent since T32.
  #
  # Resolved HERE, and that is the whole design decision. Doing it in cic
  # would make the default apply only for a client that has hydrated the
  # setting — the same "saved but never applied" gap the save-time
  # validation exists to close — and would leave every other door (a
  # second client, a direct PATCH) sending `user-disconnect` instead. The
  # server always has the row.
  #
  # It therefore covers the per-network park from the sidebar × as well as
  # `/quit`'s park-all, because both are the subject leaving and both come
  # through this verb. `Grappa.Operator` is the OTHER caller of
  # `Networks.disconnect/2` and is deliberately NOT routed through here:
  # an operator-forced disconnect is not the user leaving, and it keeps
  # its own constant.
  #
  # Nothing is validated here: `put_quit_part_reason/3` already refused
  # CR/LF/NUL at save time, so a stored value is safe on the wire by
  # construction, and `Session.send_quit/3` re-checks at the domain
  # boundary regardless.
  @spec parked_reason(Subject.t()) :: String.t()
  defp parked_reason(subject) do
    case UserSettings.get_quit_part_reason(Subject.to_session(subject)) do
      nil -> "user-disconnect"
      stored -> stored
    end
  end

  # Resolve a `SessionPlan` from the credential. Subject-polymorphic:
  # the user resolver reads `Accounts.get_user!`, the visitor resolver
  # reads the `%Visitor{}` identity — routing a visitor through the user
  # resolver would crash on `Accounts.get_user!(nil)` (the phase-1
  # subject-blind-reader class). Returns a typed `:resolve_failed` on
  # failure so the controller surfaces it via FallbackController.
  @spec resolve_plan(GrappaWeb.Subject.t(), Credential.t(), Grappa.Networks.Network.t()) ::
          {:ok, Session.start_opts()} | {:error, :resolve_failed}
  defp resolve_plan({:user, %User{id: user_id}}, credential, _) do
    case SessionPlan.resolve(credential) do
      {:ok, _} = ok ->
        ok

      {:error, reason} ->
        Logger.warning("PATCH /connect: session plan resolve failed",
          user: user_id,
          error: inspect(reason)
        )

        {:error, :resolve_failed}
    end
  end

  defp resolve_plan({:visitor, %Visitor{} = visitor}, _, network) do
    # The visitor resolver is network-explicit (phase 4c) — a
    # multi-network visitor resolves the RIGHT network's plan, not the
    # (retired) singular `network_slug`. The `ResolveNetwork` plug
    # assigned `conn.assigns.network`.
    case Grappa.Visitors.SessionPlan.resolve(visitor, network) do
      {:ok, _} = ok ->
        ok

      {:error, reason} ->
        Logger.warning("PATCH /connect: visitor session plan resolve failed",
          visitor_id: visitor.id,
          error: inspect(reason)
        )

        {:error, :resolve_failed}
    end
  end

  # ---------------------------------------------------------------------------
  # PATCH /networks/:network_id/identity helpers (#211 phase 6, ruling E)
  # ---------------------------------------------------------------------------

  # Whitelist the three identity fields from the body. A key the caller
  # OMITS is left out (no clobber); a present `""` passes through (a
  # deliberate "clear to default" — the SessionPlan effective_* fallback
  # applies). #211 phase 7 — this is the CANONICAL identity edit surface
  # for both subjects (the retired `PATCH /me/identity` / `identity_attrs/1`
  # is gone). `nil` values are rejected (a JSON null for an identity field
  # is malformed). Empty map is a valid no-op.
  @spec parse_identity_attrs(map()) ::
          {:ok, %{optional(:nick) => String.t(), optional(:ident) => String.t(), optional(:realname) => String.t()}}
          | {:error, :bad_request}
  defp parse_identity_attrs(params) do
    Enum.reduce_while([{"nick", :nick}, {"ident", :ident}, {"realname", :realname}], {:ok, %{}}, fn
      {string_key, atom_key}, {:ok, acc} ->
        case Map.fetch(params, string_key) do
          {:ok, v} when is_binary(v) -> {:cont, {:ok, Map.put(acc, atom_key, v)}}
          {:ok, _} -> {:halt, {:error, :bad_request}}
          :error -> {:cont, {:ok, acc}}
        end
    end)
  end

  # ---------------------------------------------------------------------------
  # PATCH /networks/:network_id/profile helpers
  # ---------------------------------------------------------------------------

  # Whitelist the 5 profile fields, mapping the un-prefixed wire keys
  # (`age`/`gender`/`location`/`languages`/`custom`, matching what
  # `credential_to_json/1` emits) onto the schema's `profile_*` atoms. Same
  # omit-vs-blank contract as `parse_identity_attrs/1`: an omitted key is
  # left out (no clobber), a present `""` is a deliberate clear.
  @spec parse_profile_attrs(map()) ::
          {:ok,
           %{
             optional(:profile_age) => String.t(),
             optional(:profile_gender) => String.t(),
             optional(:profile_location) => String.t(),
             optional(:profile_languages) => String.t(),
             optional(:profile_custom) => String.t()
           }}
          | {:error, :bad_request}
  defp parse_profile_attrs(params) do
    Enum.reduce_while(
      [
        {"age", :profile_age},
        {"gender", :profile_gender},
        {"location", :profile_location},
        {"languages", :profile_languages},
        {"custom", :profile_custom}
      ],
      {:ok, %{}},
      fn {string_key, atom_key}, {:ok, acc} ->
        case Map.fetch(params, string_key) do
          {:ok, v} when is_binary(v) -> {:cont, {:ok, Map.put(acc, atom_key, v)}}
          {:ok, _} -> {:halt, {:error, :bad_request}}
          :error -> {:cont, {:ok, acc}}
        end
      end
    )
  end

  # ---------------------------------------------------------------------------
  # PUT /networks/:network_id/avatar helpers
  # ---------------------------------------------------------------------------

  defp extract_avatar_field(%{"file" => %Plug.Upload{} = upload}), do: {:ok, upload}
  defp extract_avatar_field(_), do: {:error, :bad_request}

  # Avatar-scoped: only the `:image` slice of the SAME closed MIME
  # allowlist `POST /api/uploads` enforces
  # (`GrappaWeb.UploadsController.mime_categories/0`) — a video/document/
  # audio upload is rejected the same way an unmapped MIME is there
  # (415), not a second hand-rolled allowlist. No octet-stream/extension
  # rescue here (that's specifically the audio-on-iOS workaround) — an
  # avatar's declared Content-Type must already be a real image MIME.
  @sobelow_skip ["Traversal.FileModule"]
  @spec validate_avatar_mime(Plug.Upload.t()) ::
          {:ok, String.t()} | {:error, :unsupported_media_type}
  defp validate_avatar_mime(%Plug.Upload{content_type: ct}) when is_binary(ct) do
    {mime, _} = Uploads.parse_content_type(ct)

    case Map.fetch(GrappaWeb.UploadsController.mime_categories(), mime) do
      {:ok, :image} -> {:ok, mime}
      _ -> {:error, :unsupported_media_type}
    end
  end

  defp validate_avatar_mime(_), do: {:error, :unsupported_media_type}

  # Same pre-read stat-then-cap-check ordering as
  # `UploadsController.check_per_file_cap/2` (S4: never buffer the whole
  # temp file into the BEAM heap before the cheap cap check) — reuses
  # the SAME `:image` cap, not a separate avatar-specific ceiling.
  #
  # `path` is `Plug.Upload.path`, a tmp file synthesized by
  # `Plug.Parsers :multipart` — never user-controlled string input.
  @sobelow_skip ["Traversal.FileModule"]
  defp check_avatar_per_file_cap(%Plug.Upload{path: path}) do
    cap = ServerSettings.get_upload_per_file_cap_bytes(:image)

    case File.stat(path) do
      {:ok, %File.Stat{size: size}} when size <= cap -> :ok
      {:ok, %File.Stat{}} -> {:error, {:file_too_large, cap}}
      {:error, _} -> {:error, :bad_request}
    end
  end

  # `path` is `Plug.Upload.path`, a tmp file synthesized by
  # `Plug.Parsers :multipart` — never user-controlled string input.
  @sobelow_skip ["Traversal.FileModule"]
  defp read_avatar_file(%Plug.Upload{path: path}) do
    case File.read(path) do
      {:ok, bytes} -> {:ok, bytes}
      {:error, _} -> {:error, :bad_request}
    end
  end

  # Web-layer reconnect wrapper (NEVER the Networks context — Boundary
  # cycle). Resolves the subject's plan for the network + bounces the
  # LIVE session via `SpawnOrchestrator.reconnect/5` so the new
  # ident/realname/nick re-register on a fresh USER line. The `whereis`
  # guard keeps it to an already-live session (a parked/no-session edit
  # persists only). Failures are logged, never surfaced — the identity is
  # saved regardless of the bounce (mirrors `Visitors.maybe_reconnect_after_identity/1`).
  @spec live_apply_identity(GrappaWeb.Subject.t(), Grappa.Networks.Network.t(), Credential.t()) ::
          :ok
  defp live_apply_identity(subject, %{id: network_id} = network, credential) do
    session_subject = Subject.to_session(subject)

    with pid when is_pid(pid) <- Session.whereis(session_subject, network_id),
         {:ok, plan} <- resolve_plan(subject, credential, network) do
      case Grappa.SpawnOrchestrator.reconnect(
             session_subject,
             network_id,
             plan,
             identity_capacity_input(subject, network_id),
             "applying identity change"
           ) do
        {:ok, _, _} ->
          :ok

        other ->
          Logger.warning(
            "PATCH /identity: reconnect failed (identity persisted) #{inspect(session_subject)}",
            network_id: network_id,
            error: inspect(other)
          )

          :ok
      end
    else
      # No live session (parked / never connected) or unresolvable plan —
      # persist-only; the next spawn reads the new identity.
      _ -> :ok
    end
  end

  # Mirror of `NetworkSpawn.orchestrate/4`'s capacity_input for the
  # identity bounce (reconnect/5, not spawn/4). `requesting_subject`
  # self-excludes the caller's own session from the per-IP cap on the
  # respawn.
  @spec identity_capacity_input(GrappaWeb.Subject.t(), integer()) :: Grappa.Admission.capacity_input()
  defp identity_capacity_input(subject, network_id) do
    session_subject = Subject.to_session(subject)

    %{
      network_id: network_id,
      source_ip: nil,
      flow: Subject.connect_flow(subject),
      requesting_subject: session_subject
    }
  end
end
