defmodule Grappa.Networks.Credential do
  @moduledoc """
  Per-(user, network) IRC binding: nick, optional realname/SASL identity,
  the upstream auth method (`:auto | :sasl | :server_pass | :nickserv_identify | :none`),
  an optional auth-command template (free-form NickServ verbs), and the
  channel autojoin list.

  ## Encrypted password

  `password_encrypted` is a `Grappa.EncryptedBinary` (Cloak AES-GCM). The
  virtual `:password` field is the input-only plaintext; the changeset
  copies it into `password_encrypted` only when the changeset is otherwise
  valid, mirroring the Argon2 deferral in `Grappa.Accounts.User`. The
  virtual field is `redact: true` so plaintext never appears in
  `inspect/1` or Logger output.

  ## auth_method validation

  `:none` accepts any (or no) password — there's nothing to authenticate
  against upstream. Every other method REQUIRES a non-empty password;
  validation returns a normal changeset error on failure.

  ## Composite primary key

  `(user_id, network_id)` is the natural key — a user has at most one
  credential per network. We don't carry a surrogate `id` because
  every callsite (the operator mix tasks, future REST credentials
  surface, the Session.Server boot path) already has both halves.
  """
  use Ecto.Schema
  import Ecto.Changeset

  alias Grappa.Accounts.User
  alias Grappa.EncryptedBinary
  alias Grappa.IRC.{AuthFSM, Identifier}
  alias Grappa.Networks.Network

  # The atom literal stays here (Ecto.Enum needs a compile-time literal for
  # validates_inclusion + DB cast); the @type forwards to AuthFSM so there
  # is one canonical source for "what does auth_method mean" and Dialyzer
  # sees a single declaration. Adding a sixth method requires editing
  # `Grappa.IRC.AuthFSM` (the verb owner) and mirroring the literal here.
  @auth_methods [:auto, :sasl, :server_pass, :nickserv_identify, :none]

  # T32 (channel-client-polish S1.1): terminal/user-visible connection
  # state for a credential.
  #
  # `:connected` — Bootstrap (or `Networks.connect/1`) spawned a
  #   `Session.Server`; the binding is live, OR the session is in
  #   continuous reconnect / backoff. Runtime sub-states
  #   (`:connecting`, `:reconnecting`, `:backing_off`) stay in
  #   Session.Server GenServer state — NOT mirrored here.
  # `:parked`    — user-driven `/disconnect` or `/quit`. Bouncer
  #   stays parked across reboots until `/connect <network>`.
  # `:failed`    — server-set on permanent error (k-line 465 +
  #   permanent SASL 904/906 — see plan S1.4 lenient triggers).
  #
  # State-transition policy lives in `Grappa.Networks.connect/1`,
  # `disconnect/2`, and `mark_failed/2` — the schema accepts any
  # value in the closed set; the context module enforces which
  # transitions are valid.
  @connection_states [:connected, :parked, :failed]

  # H15 (REV-D 2026-05-22): hard ceiling on the per-credential
  # `last_joined_channels` snapshot. Schema-level cap so every
  # persistence path observes the same bound — the context helper
  # `Credentials.update_last_joined_channels/3` reads this attribute
  # via `last_joined_channels_max/0` so the SoT lives here, not at
  # the context. Bounds the JSON column write + boot-time merge cost
  # so a pathological session can't grow the snapshot without limit.
  @last_joined_channels_max 200

  @doc """
  Returns the schema-level cap on `last_joined_channels` length. Public
  so the context helper (`Credentials.update_last_joined_channels/3`)
  can pre-truncate the input list using the same constant the
  changeset validator enforces. Single source of truth — renaming
  `@last_joined_channels_max` here automatically updates the context.
  """
  @spec last_joined_channels_max() :: unquote(@last_joined_channels_max)
  def last_joined_channels_max, do: @last_joined_channels_max

  @doc """
  Returns the closed-set list of valid `:auth_method` values. Exposed
  so tests (notably the migration drift-detector
  `Grappa.Migrations.CheckConstraintsTest`) can iterate the full enum
  without hard-coding the list at the test site (which would silently
  drift the moment a sixth method lands in the schema).
  """
  @spec auth_methods() :: [auth_method(), ...]
  def auth_methods, do: @auth_methods

  @doc """
  Returns the closed-set list of valid `:connection_state` values
  (T32). Mirror of `auth_methods/0` shape.
  """
  @spec connection_states() :: [connection_state(), ...]
  def connection_states, do: @connection_states

  @type auth_method :: AuthFSM.auth_method()
  @type connection_state :: :connected | :parked | :failed

  @type t :: %__MODULE__{
          user_id: Ecto.UUID.t() | nil,
          user: User.t() | Ecto.Association.NotLoaded.t() | nil,
          network_id: integer() | nil,
          network: Network.t() | Ecto.Association.NotLoaded.t() | nil,
          nick: String.t() | nil,
          realname: String.t() | nil,
          sasl_user: String.t() | nil,
          password_encrypted: binary() | nil,
          password: String.t() | nil,
          auth_method: auth_method() | nil,
          auth_command_template: String.t() | nil,
          autojoin_channels: [String.t()],
          last_joined_channels: [String.t()],
          connection_state: connection_state() | nil,
          connection_state_reason: String.t() | nil,
          connection_state_changed_at: DateTime.t() | nil,
          inserted_at: DateTime.t() | nil,
          updated_at: DateTime.t() | nil
        }

  @primary_key false
  schema "network_credentials" do
    belongs_to :user, User, type: :binary_id, primary_key: true
    belongs_to :network, Network, primary_key: true

    field :nick, :string
    field :realname, :string
    field :sasl_user, :string
    # `redact: true` on `password_encrypted` is load-bearing: Cloak's
    # `:load` callback decrypts on read so the field IN MEMORY carries
    # the plaintext upstream password, not the AES-GCM ciphertext. The
    # virtual `:password` field below is also redacted (input-only),
    # but after `Repo.one!` it's `nil` while `password_encrypted` IS
    # the cleartext — so `inspect/1` over a fetched credential would
    # leak it without this. Symmetric with `Grappa.IRC.Client`'s
    # `@derive {Inspect, except: [:password]}` from sub-task 2f I3.
    field :password_encrypted, EncryptedBinary, redact: true
    field :password, :string, virtual: true, redact: true
    # No default: operators MUST pick the auth method explicitly. S29
    # H10: defaulting to `:auto` was a footgun — half-built attrs (in
    # tests, REPL, future REST attrs) without a password passed the
    # enum check then crashed mid-handshake on the SASL bitstring
    # builder with :badarg. validate_required([:auth_method]) below
    # is the boundary check; the absence of a default means a missing
    # field surfaces as `can't be blank` instead of `:auto-then-crash`.
    field :auth_method, Ecto.Enum, values: @auth_methods
    field :auth_command_template, :string
    field :autojoin_channels, {:array, :string}, default: []

    # CP22 cluster B (channel-client-polish #14, B-restart) — runtime
    # snapshot of currently joined channels. Persisted by Session.Server
    # on every self-JOIN / self-PART / self-KICK so a restart can
    # rehydrate the channel list at boot. Boot semantics: union with
    # `autojoin_channels` (operator-config never-changes-channels) +
    # this field (runtime fluctuating channels), deduped.
    #
    # Stored as a JSON TEXT column in sqlite (same shape as
    # autojoin_channels). Bounded by the live join count — typically
    # 5-50 channels. NOT a long-term audit log; the latest write
    # overwrites the previous value.
    field :last_joined_channels, {:array, :string}, default: []

    # T32 (channel-client-polish S1.1).
    field :connection_state, Ecto.Enum, values: @connection_states, default: :connected
    field :connection_state_reason, :string
    field :connection_state_changed_at, :utc_datetime

    timestamps(type: :utc_datetime_usec)
  end

  @doc """
  Builds a create/update changeset. The plaintext `:password` (when
  given) is copied into `:password_encrypted` only when the changeset
  is otherwise valid — the Cloak Ecto type encrypts on dump. For
  `auth_method != :none`, either a new `:password` OR an existing
  `:password_encrypted` from a prior bind must be present (so an
  unrelated update — e.g., renaming `:nick` — doesn't force the
  caller to re-supply the password).
  """
  @spec changeset(t(), map()) :: Ecto.Changeset.t()
  def changeset(credential, attrs) do
    credential
    |> cast(attrs, [
      :user_id,
      :network_id,
      :nick,
      :realname,
      :sasl_user,
      :password,
      :auth_method,
      :auth_command_template,
      :autojoin_channels,
      :last_joined_channels,
      :connection_state,
      :connection_state_reason,
      :connection_state_changed_at
    ])
    |> canonicalize_channel_lists()
    |> validate_required([:user_id, :network_id, :nick, :auth_method])
    # A8: nick syntax + length is the same `Identifier.valid_nick?/1`
    # rule that `Grappa.Scrollback.Message.changeset/2` and the IRC
    # parser already use — single regex, single source. The local
    # `@nick_format` + `validate_length(:nick, ...)` pair was retired
    # in favor of Identifier's RFC-aligned 30-char cap.
    |> validate_change(:nick, &validate_nick/2)
    |> validate_password_for_auth_method()
    # S29 C1 review-fix #1: every text field that ends up interpolated
    # into a wire line — PASS, NICK, USER, PRIVMSG NickServ — must be
    # CRLF/NUL-free. The REST surface's safe_line_token? guard at
    # Session.send_* covers user-supplied PRIVMSG body/target; the
    # operator-input path (this changeset) is the OTHER door into
    # Client and needs the same hygiene. autojoin_channels gets the
    # full Identifier.valid_channel?/1 regex (which excludes whitespace
    # + control bytes) since these become JOIN <name> on registration.
    |> validate_change(:realname, &validate_safe_line_token/2)
    |> validate_change(:sasl_user, &validate_safe_line_token/2)
    |> validate_change(:password, &validate_safe_line_token/2)
    |> validate_change(:auth_command_template, &validate_safe_line_token/2)
    |> validate_change(:autojoin_channels, &validate_autojoin_channels/2)
    # H15 (REV-D 2026-05-22): defensive schema-level cap on the
    # `last_joined_channels` snapshot. The context helper
    # `Credentials.update_last_joined_channels/3` truncates to
    # `@last_joined_channels_max` before building the changeset, but
    # any other writer (a future REST surface, an operator mix task,
    # a test-only helper) bypassing that helper could otherwise grow
    # the JSON column without bound. The schema is the single source
    # of truth: enforce the same cap here so every persistence path
    # observes the same ceiling.
    |> validate_length(:last_joined_channels, max: @last_joined_channels_max)
    |> put_encrypted_password()
    |> put_default_connection_state_changed_at()
    # Admin-panel bucket 3 — pre-fix `bind_credential/3` (via the
    # REST `POST /admin/credentials`) raised `Ecto.ConstraintError`
    # on a duplicate `(user_id, network_id)` because the composite
    # PK unique-violation surfaced as an exception, not a changeset
    # error. Declaring the constraint here lets `Repo.insert/2` map
    # it to a normal changeset error keyed on `:user_id`; the
    # controller's `pk_collision?/1` classifier then collapses it
    # to `{:error, :already_exists}` for the 409 wire body.
    |> unique_constraint(:user_id,
      name: :network_credentials_user_id_network_id_index,
      message: "credential already exists for this (user, network)"
    )
  end

  # UX-4 bucket A — canonicalise channel names in both array columns
  # before persistence. Operators may type `#Sniffo` in a mix task or
  # the future REST credentials surface; the runtime persists
  # `last_joined_channels` from `Session.Server` state.members keys
  # which are themselves canonicalised by EventRouter at intake. The
  # backfill migration covers existing rows; this changeset covers
  # everything written from bucket-A forward.
  @spec canonicalize_channel_lists(Ecto.Changeset.t()) :: Ecto.Changeset.t()
  defp canonicalize_channel_lists(changeset) do
    changeset
    |> maybe_canonicalize_channel_list(:autojoin_channels)
    |> maybe_canonicalize_channel_list(:last_joined_channels)
  end

  defp maybe_canonicalize_channel_list(changeset, field) do
    case get_change(changeset, field) do
      list when is_list(list) ->
        put_change(changeset, field, Enum.map(list, &canonicalize_channel_entry/1))

      _ ->
        changeset
    end
  end

  defp canonicalize_channel_entry(name) when is_binary(name),
    do: Identifier.canonical_channel(name)

  defp canonicalize_channel_entry(other), do: other

  # The migration column has no DB default (sqlite ADD COLUMN forbids
  # CURRENT_TIMESTAMP defaults — see migration 20260504120000 moduledoc).
  # The schema layer fills it on every insert that omits it; explicit
  # `Networks.{connect,disconnect,mark_failed}` callers already set it
  # via `DateTime.utc_now/0` and that explicit value wins.
  defp put_default_connection_state_changed_at(changeset) do
    case fetch_field(changeset, :connection_state_changed_at) do
      {_, %DateTime{}} ->
        changeset

      _ ->
        put_change(changeset, :connection_state_changed_at, DateTime.truncate(DateTime.utc_now(), :second))
    end
  end

  defp validate_nick(field, value) when is_binary(value) do
    if Identifier.valid_nick?(value),
      do: [],
      else: [{field, "must be a valid IRC nickname"}]
  end

  @doc """
  Narrow changeset for `connection_state` transitions.

  REV-J M13: pre-fix `Networks.transition!/3` cast via raw
  `Ecto.Changeset.change/2`, which skipped every changeset rule
  including the `safe_line_token` guard on `:connection_state_reason`.
  Reasons come from controlled internal sources today
  (`Networks.disconnect/2` callers gate user input upstream), so this
  is defense-in-depth rather than a live bug — but a future caller
  threading an unvalidated string through `transition!/3` would land
  CR/LF in the column, splitting log lines on any downstream
  log-shipping consumer and confusing the operator-visible error
  trail.

  Same shape as `Accounts.User.admin_changeset/2`: cast only the
  fields the verb owns; run only the validations that apply to those
  fields. The closed-set `connection_state` Ecto.Enum cast still fires
  via `cast/3` so a bogus atom raises at the changeset level.
  """
  @spec connection_state_changeset(t(), map()) :: Ecto.Changeset.t()
  def connection_state_changeset(credential, attrs) do
    credential
    |> cast(attrs, [
      :connection_state,
      :connection_state_reason,
      :connection_state_changed_at
    ])
    |> validate_required([:connection_state, :connection_state_changed_at])
    |> validate_change(:connection_state_reason, &validate_safe_line_token/2)
  end

  @doc """
  Narrow changeset for an in-session NickServ SET PASSWD capture (#131):
  casts the virtual `:password`, encrypts it into `:password_encrypted`,
  and touches nothing else.

  Distinct from the wide `changeset/2` on purpose — the operator binding
  (nick, auth_method, autojoin) is untouched; only the upstream NickServ
  secret rotated on the wire. Running the wide changeset's
  `validate_password_for_auth_method` / channel-list canonicalisation
  here would be irrelevant noise (and could reject a valid password
  rotation on a `:none` row that legitimately carries no other change).
  `cast/3`'s default `empty_values` maps a blank `""` to missing, so
  `validate_required/2` rejects it at the changeset boundary — the same
  belt-and-braces guard pattern as the H15 `last_joined_channels` cap.
  """
  @spec password_changeset(t(), String.t()) :: Ecto.Changeset.t()
  def password_changeset(credential, password) when is_binary(password) do
    credential
    |> cast(%{password: password}, [:password])
    |> validate_required([:password])
    # Same wire-hygiene guard the wide `changeset/2` applies to `:password`
    # (line ~220): the stored value is re-interpolated into PASS /
    # `PRIVMSG NickServ :IDENTIFY` on the next auto-identify, so a CR/LF/NUL
    # byte would split or truncate the outbound frame. A SET PASSWD password
    # is rest-of-line (spaces are legal — `safe_line_token?` only rejects
    # CR/LF/NUL), so this rejects only genuinely wire-unsafe values.
    |> validate_change(:password, &validate_safe_line_token/2)
    |> put_encrypted_password()
  end

  defp validate_safe_line_token(field, value) when is_binary(value) do
    if Identifier.safe_line_token?(value),
      do: [],
      else: [{field, "contains CR, LF, or NUL byte"}]
  end

  defp validate_autojoin_channels(field, list) when is_list(list) do
    Enum.flat_map(list, fn name ->
      cond do
        not is_binary(name) -> [{field, "must contain only strings"}]
        not Identifier.valid_channel?(name) -> [{field, "invalid channel name: #{inspect(name)}"}]
        true -> []
      end
    end)
  end

  # Either a new plaintext `:password` arrives in this changeset, OR the
  # row already carries a stored `password_encrypted` from a prior bind
  # AND the auth_method isn't being changed. Validating only the virtual
  # field would force every update of an unrelated attribute (nick,
  # autojoin) to re-supply the password. But silently inheriting an
  # existing password across an auth_method CHANGE would let an operator
  # accidentally promote a NickServ-IDENTIFY password into a SASL
  # credential — different upstream auth surface, almost certainly a
  # typo. So when auth_method is in `cs.changes`, we require a fresh
  # `:password`.
  @spec validate_password_for_auth_method(Ecto.Changeset.t()) :: Ecto.Changeset.t()
  defp validate_password_for_auth_method(cs) do
    case get_field(cs, :auth_method) do
      :none ->
        cs

      _ ->
        new_pw = get_field(cs, :password)
        stored = get_field(cs, :password_encrypted)
        auth_method_changed? = Map.has_key?(cs.changes, :auth_method)

        cond do
          is_binary(new_pw) and byte_size(new_pw) > 0 ->
            cs

          auth_method_changed? ->
            add_error(cs, :password, "must be re-supplied when auth_method changes")

          is_binary(stored) and byte_size(stored) > 0 ->
            cs

          true ->
            add_error(cs, :password, "required for auth_method != :none")
        end
    end
  end

  @spec put_encrypted_password(Ecto.Changeset.t()) :: Ecto.Changeset.t()
  defp put_encrypted_password(%{valid?: true, changes: %{password: pw}} = cs)
       when is_binary(pw) do
    put_change(cs, :password_encrypted, pw)
  end

  defp put_encrypted_password(cs), do: cs

  @doc """
  Returns the post-Cloak-load plaintext upstream IRC password.

  After `Repo.one!`, the `:password_encrypted` field carries the
  decrypted plaintext (the field name describes the on-disk
  representation, not the in-memory value — see schema comment).
  Callers that need the plaintext (currently the IRC handshake
  builder in `Grappa.Session.Server`) MUST go through this accessor
  rather than reading `.password_encrypted` directly: keeping the
  access centralised prevents the misleading field name from being
  mistaken for an opaque ciphertext at the call site.

  Returns `nil` when no upstream secret is bound (e.g.
  `auth_method: :none`).

  This is the in-memory accessor only. The JSON wire shape
  (`Grappa.Networks.Wire.credential_to_json/1`) deliberately
  excludes the password — read that module's moduledoc before
  exposing the plaintext anywhere outside the IRC handshake path.
  """
  @spec upstream_password(t()) :: binary() | nil
  def upstream_password(%__MODULE__{password_encrypted: pw}), do: pw

  @doc """
  Returns `:realname` if set, otherwise `:nick`. The nil-fallback is
  encoded once here so callers (Session.Server.init, IRC.Client opts
  builder) never have to write `credential.realname || credential.nick`
  inline — that pattern was flagged in the 2f code review (I1) for
  silently masking the contract that `realname` defaults to `nick`.
  """
  @spec effective_realname(t()) :: String.t()
  def effective_realname(%__MODULE__{realname: nil, nick: nick}) when is_binary(nick), do: nick
  def effective_realname(%__MODULE__{realname: r}) when is_binary(r), do: r

  @doc """
  Returns `:sasl_user` if set, otherwise `:nick`. Same rationale as
  `effective_realname/1`.
  """
  @spec effective_sasl_user(t()) :: String.t()
  def effective_sasl_user(%__MODULE__{sasl_user: nil, nick: nick}) when is_binary(nick), do: nick
  def effective_sasl_user(%__MODULE__{sasl_user: s}) when is_binary(s), do: s
end
