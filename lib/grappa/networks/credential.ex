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

  ## Subject XOR (#211 phase 1)

  A credential is subject-polymorphic: exactly one of `:user_id` /
  `:visitor_id` is set — the established `Grappa.Subject` XOR-FK pattern
  the 8 downstream subject-scoped tables already use (NOT a role/type
  flag; Rule-6 is not triggered by XOR-FK). Enforced at three layers,
  mirroring `Grappa.ReadCursor.Cursor`:

    * Schema-level `validate_subject_xor/1` (errors attach to the
      synthetic `:subject` key for uniform client-side rendering).
    * DB CHECK constraint `network_credentials_subject_xor`.
    * Two partial unique indexes — `(user_id, network_id)
      WHERE user_id IS NOT NULL` and `(visitor_id, network_id)
      WHERE visitor_id IS NOT NULL` — so per-subject uniqueness holds
      without NULL pairs colliding spuriously.

  ## Surrogate primary key

  A surrogate `id` autoincrement is the primary key. Pre-#211 the natural
  key `(user_id, network_id)` WAS the composite PK — but a composite PK
  column cannot be NULL, and a visitor credential carries `user_id IS
  NULL`. So the XOR promotion (migration
  `20260711123000_xor_fk_network_credentials`) dropped the composite PK
  for a surrogate `id`, matching every other already-XOR table
  (`read_cursors`, `query_windows`, `user_settings`). The surrogate is
  invisible to callers: every callsite keys by `(subject_id, network_id)`
  via `Repo.get_by`/`where`, never by PK struct identity. Per-subject
  uniqueness now lives in the two partial unique indexes above rather
  than the PK.
  """
  use Ecto.Schema
  import Ecto.Changeset

  alias Grappa.Accounts.User
  alias Grappa.EncryptedBinary
  alias Grappa.IRC.{AuthFSM, Identifier, Identity}
  alias Grappa.Networks.Network
  alias Grappa.Visitors.Visitor

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
          id: integer() | nil,
          user_id: Ecto.UUID.t() | nil,
          user: User.t() | Ecto.Association.NotLoaded.t() | nil,
          visitor_id: Ecto.UUID.t() | nil,
          visitor: Visitor.t() | Ecto.Association.NotLoaded.t() | nil,
          network_id: integer() | nil,
          network: Network.t() | Ecto.Association.NotLoaded.t() | nil,
          nick: String.t() | nil,
          ident: String.t() | nil,
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

  schema "network_credentials" do
    belongs_to :user, User, type: :binary_id
    belongs_to :visitor, Visitor, type: :binary_id
    belongs_to :network, Network

    field :nick, :string
    # GH #152 — the per-(user, network) IRC ident (the `user` slot of
    # `nick!user@host`). Free-form, non-unique, nullable;
    # `effective_ident/1` falls back to nick when unset, mirroring
    # `effective_realname/1`/`effective_sasl_user/1`.
    field :ident, :string
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
      :visitor_id,
      :network_id,
      :nick,
      :ident,
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
    |> Identity.sanitize_ident()
    |> validate_required([:network_id, :nick, :auth_method])
    # #211 — subject XOR: exactly one of user_id / visitor_id. Replaces
    # the pre-#211 `validate_required([:user_id])`, which is now
    # XOR-gated (a visitor credential carries user_id IS NULL). Mirror
    # of `Grappa.ReadCursor.Cursor.validate_subject_xor/1`.
    |> validate_subject_xor()
    # A8: nick syntax + length is the same `Identifier.valid_nick?/1`
    # rule that `Grappa.Scrollback.Message.changeset/2` and the IRC
    # parser already use — single regex, single source. The local
    # `@nick_format` + `validate_length(:nick, ...)` pair was retired
    # in favor of Identifier's RFC-aligned 30-char cap.
    |> validate_change(:nick, &Identity.validate_nick/2)
    # GH #152 — ident shape guard. The `Identity.sanitize_ident/1` step
    # above has already stripped a leading `~` (anti-spoof, grappa runs no
    # identd), so this rejects anything still not matching the
    # RFC-user-charset / cap-10 shape (residual tilde, `@`, whitespace,
    # over-length).
    |> validate_change(:ident, &Identity.validate_ident/2)
    |> validate_password_for_auth_method()
    # S29 C1 review-fix #1: every text field that ends up interpolated
    # into a wire line — PASS, NICK, USER, PRIVMSG NickServ — must be
    # CRLF/NUL-free. The REST surface's safe_line_token? guard at
    # Session.send_* covers user-supplied PRIVMSG body/target; the
    # operator-input path (this changeset) is the OTHER door into
    # Client and needs the same hygiene. autojoin_channels gets the
    # full Identifier.valid_channel?/1 regex (which excludes whitespace
    # + control bytes) since these become JOIN <name> on registration.
    |> validate_change(:realname, &Identity.safe_line_token/2)
    |> validate_change(:sasl_user, &Identity.safe_line_token/2)
    |> validate_change(:password, &Identity.safe_line_token/2)
    |> validate_change(:auth_command_template, &Identity.safe_line_token/2)
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
    # to `{:error, :already_exists}` for the 409 wire body. #211 moved
    # the physical uniqueness from the composite PK to a partial unique
    # index (`WHERE user_id IS NOT NULL`) of the same name, so the
    # constraint mapping is unchanged.
    |> unique_constraint(:user_id,
      name: :network_credentials_user_id_network_id_index,
      message: "credential already exists for this (user, network)"
    )
    # #211 — visitor twin of the uniqueness above (partial unique index
    # `WHERE visitor_id IS NOT NULL`). Keyed on `:visitor_id` so a
    # duplicate visitor credential surfaces as a changeset error, not an
    # exception — same collapse-to-409 path as the user branch.
    |> unique_constraint(:visitor_id,
      name: :network_credentials_visitor_id_network_id_index,
      message: "credential already exists for this (visitor, network)"
    )
    # #211 phase 4b — the credential-side folded-nick partial unique index
    # for VISITOR credentials (`(fold(nick), network_id) WHERE visitor_id
    # IS NOT NULL`, GH #121). Two DIFFERENT visitors cannot hold the same
    # rfc1459-folded nick on one network — the per-network identity guard
    # that phase 4c resolves identity against and accretion collision-checks
    # (mirrors the `visitors`-table folded index onto the Credential). Keyed
    # on `:nick` so a cross-visitor collision surfaces as a changeset error.
    # Partial (`WHERE visitor_id IS NOT NULL`), so a user credential sharing
    # the nick does NOT collide — users are a separate operator-bound
    # identity space.
    |> unique_constraint(:nick,
      name: :network_credentials_visitor_folded_nick_network_id_index,
      message: "nick already taken on this network"
    )
    # #211 — DB-level XOR mirror. Maps the CHECK violation to a changeset
    # error on the synthetic `:subject` key (mirror of
    # `Grappa.ReadCursor.Cursor`) so a raw both-set / both-null insert
    # slipping past `validate_subject_xor/1` still surfaces cleanly.
    |> check_constraint(:subject,
      name: :network_credentials_subject_xor,
      message: "user_id and visitor_id are mutually exclusive"
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

  # #211 — subject XOR: exactly one of user_id / visitor_id must be set.
  # Byte-mirror of `Grappa.ReadCursor.Cursor.validate_subject_xor/1`;
  # errors attach to the synthetic `:subject` key so the client renders
  # one uniform subject error regardless of which FK column is at fault.
  @spec validate_subject_xor(Ecto.Changeset.t()) :: Ecto.Changeset.t()
  defp validate_subject_xor(changeset) do
    user_id = get_field(changeset, :user_id)
    visitor_id = get_field(changeset, :visitor_id)

    case {user_id, visitor_id} do
      {nil, nil} -> add_error(changeset, :subject, "must set user_id or visitor_id")
      {_, nil} -> changeset
      {nil, _} -> changeset
      {_, _} -> add_error(changeset, :subject, "user_id and visitor_id are mutually exclusive")
    end
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
    |> validate_change(:connection_state_reason, &Identity.safe_line_token/2)
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
    |> validate_change(:password, &Identity.safe_line_token/2)
    |> put_encrypted_password()
  end

  @doc """
  Narrow changeset for the `last_joined_channels` snapshot written on
  the self-JOIN/PART/KICK hot path (S34, 2026-07-08 review). Mirrors the
  narrow-changeset pattern of
  `Grappa.Visitors.Visitor.last_joined_channels_changeset/2`.

  `Credentials.update_last_joined_channels/3` fires this on every
  self-membership change; routing it through the WIDE `changeset/2`
  re-ran every unrelated validator (`validate_password_for_auth_method`,
  `put_encrypted_password`, the `unique_constraint`) on a high-frequency
  write that only touches one JSON column. This casts + canonicalises +
  caps ONLY that column — applying the exact same operations the wide
  `changeset/2` applies to `:last_joined_channels` (canonicalisation via
  `canonicalize_channel_entry/1`, the H15 `@last_joined_channels_max`
  cap; the wide path runs NO per-entry channel-syntax validation on this
  field — that guard is `autojoin_channels`-only), so persisted values
  are byte-identical to the wide path.
  """
  @spec last_joined_channels_changeset(t(), [String.t()]) :: Ecto.Changeset.t()
  def last_joined_channels_changeset(%__MODULE__{} = credential, channels)
      when is_list(channels) do
    canonical = Enum.map(channels, &canonicalize_channel_entry/1)

    credential
    |> cast(%{last_joined_channels: canonical}, [:last_joined_channels])
    |> validate_length(:last_joined_channels, max: @last_joined_channels_max)
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

  Thin struct-accessor over `Grappa.IRC.Identity.effective_realname/2`
  (#211 phase 2) — the fallback logic is shared with the visitor
  write-path; the user subject's fallback is its own `:nick`.
  """
  @spec effective_realname(t()) :: String.t()
  def effective_realname(%__MODULE__{realname: realname, nick: nick}),
    do: Identity.effective_realname(realname, nick)

  @doc """
  Returns `:ident` if set, otherwise `:nick` (GH #152). Same nil-fallback
  contract as `effective_realname/1` — the ident defaults to the nick, so
  the AuthFSM's USER line stays `USER <nick> ...` for a credential that
  never set a distinct ident (upstream behaviour today). Threaded into
  the plan by `Grappa.Networks.SessionPlan.build_plan/4`.

  Thin struct-accessor over `Grappa.IRC.Identity.effective_ident/2`
  (#211 phase 2).
  """
  @spec effective_ident(t()) :: String.t()
  def effective_ident(%__MODULE__{ident: ident, nick: nick}),
    do: Identity.effective_ident(ident, nick)

  @doc """
  Returns `:sasl_user` if set, otherwise `:nick`. Same rationale as
  `effective_realname/1`.

  Thin struct-accessor over `Grappa.IRC.Identity.effective_sasl_user/2`
  (#211 phase 2).
  """
  @spec effective_sasl_user(t()) :: String.t()
  def effective_sasl_user(%__MODULE__{sasl_user: sasl_user, nick: nick}),
    do: Identity.effective_sasl_user(sasl_user, nick)
end
