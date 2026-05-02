# Visitor-Auth Cluster — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Ship `cluster/visitor-auth` — collapses M2 (NickServ-IDP) + M3a (anon) into a single unified-auth path. Visitors land on grappa, type a nick (+ optional NickServ password), get connected to the configured network. Wrong password ≠ failure (silent stay-anon). +r MODE observation upgrades sliding TTL 48h → 7d.

**Architecture:** Hybrid email-discriminator dispatch at `POST /auth/login` (`@` in identifier → `Accounts.local_login`, else → `Visitors.login`). Single `accounts.sessions` table with XOR `user_id|visitor_id`. Single Authorization-bearer transport (no cookies — XSS surface for cicchetto is limited; HttpOnly retrofit deferred to Phase 5). Synchronous login (8s budget, awaits upstream `001 RPL_WELCOME`). Outbound NS-command interceptor in Session.Server captures pending password into staging buffer; +r MODE observation atomically commits password+nick to visitor row + bumps expires_at to now+7d. Reconnect-on-nick-collision via pure GhostRecovery FSM (NICK 433 → underscore-append → GHOST → WHOIS → 401-vs-311 dispatch). Reaper sweeps expired visitors via FK CASCADE.

**Tech Stack:** Elixir 1.19 / Phoenix 1.8 / Ecto + ecto_sqlite3 + Cloak.Vault for password-at-rest / cicchetto (TS + Phoenix.js). All runs in container per `scripts/*.sh`.

---

## Pinned decisions (do not re-litigate)

From 2026-05-01 + 2026-05-02 brainstorm with vjt:

| # | Decision |
|---|----------|
| **W1** | `visitor_channels` table separate from `Networks.Channel`. FK `visitor_id` ON DELETE CASCADE. |
| **W2** | `visitors` table separate from `users`. `messages` adds nullable `visitor_id`, CHECK `(user_id IS NULL) <> (visitor_id IS NULL)`. |
| **W3** | `GRAPPA_MAX_VISITORS_PER_IP=5` default. |
| **W4** | Single cluster, no Sub-1/Sub-2 split. |
| **W5** | Synchronous `POST /auth/login` w/ 8s timeout. 502 on connect-fail, 504 on timeout, 200 on `001 RPL_WELCOME`. |
| **W6** | Inline regex classifier. Nick: `~r/^[A-Za-z\[\]\\\`_^{|}][A-Za-z0-9\[\]\\\`_^{|}-]{0,30}$/`. Email: `~r/^[^@\s]+@[^@\s]+\.[^@\s]+$/`. |
| **W7** | `Grappa.Bootstrap` hard-errors if any `visitor.network_slug` references a network not in current config. Recovery: `mix grappa.reap_visitors --network=<slug>`. |
| **W8** | Concurrent NS commands → mailbox FIFO gives latest-wins for free. No extra code. |
| **W9** | Visitor `expires_at` refresh cadence: bump on user-initiated REST/WS verbs only, ≥1h since last bump OR +r jump (now+7d). Not on idle WS heartbeats / inbound IRC events. |
| **Q-A** | `accounts.sessions` shared with XOR `user_id|visitor_id`. No separate `visitor_sessions` table. |
| **Q-B** | (Moot — no cookie.) |
| **Q-C** | Single Authorization-bearer transport. `Plugs.Authn` reads header, calls `Accounts.authenticate/1`, branches on session FK to assign `current_user` xor `current_visitor`. |
| **Q-D** | (Moot — no cookie, so no UserSocket cookie path needed.) |
| **Q-E** | Login response: `200 {token, subject: {kind: :user | :visitor, id, name | nick, network_slug?}}`. Single wire shape, server-discriminated. |
| **Q-F** | `visitors.id` UUID. |
| **Q-G** | (Moot — no separate visitor_sessions table.) |
| **Q-H** | sqlite supports `CHECK ((user_id IS NULL) <> (visitor_id IS NULL))`. |
| **Actor abstraction** | Rejected — over-engineering for 2 modes. CLAUDE.md: "shared data model with type flag = boundary violation." |
| **HttpOnly cookies** | Deferred to Phase 5 hardening (XSS posture / untrusted-browser scenarios). Logged in `docs/todo.md`. |

---

## File Structure

### New server-side modules

| Path | Purpose |
|------|---------|
| `lib/grappa/auth/identifier_classifier.ex` | Pure module. `classify(id) :: {:email, id} \| {:nick, id} \| {:error, :malformed}`. Inline RFC2812 + RFC5322-light regex. |
| `lib/grappa/visitors.ex` | Public context. Boundary: `top_level: true`, deps: `[Grappa.Networks, Grappa.Session, Grappa.Accounts, Grappa.Repo, Grappa.PubSub, Grappa.Vault]`. |
| `lib/grappa/visitors/visitor.ex` | Ecto schema. `(nick, network_slug, password_encrypted, expires_at)`. UUID PK. Cloak `EncryptedBinary`. |
| `lib/grappa/visitors/visitor_channel.ex` | Ecto schema. `(visitor_id FK, network_slug, name)`. |
| `lib/grappa/visitors/login.ex` | Synchronous probe-connect orchestrator (`Visitors.login/4`). Spawns Session.Server, awaits `:session_ready` w/ 8s timeout. |
| `lib/grappa/visitors/session_plan.ex` | Mirrors `Networks.SessionPlan` shape. `resolve(%Visitor{}, [%VisitorChannel{}]) :: {:ok, Session.start_opts()} \| {:error, reason}`. |
| `lib/grappa/visitors/reaper.ex` | GenServer, `:permanent`, 60s sweep. Deletes expired visitors → CASCADE wipes scrollback + visitor_channels + accounts_sessions. |
| `lib/grappa/session/ns_interceptor.ex` | Pure module. `intercept(outbound_line) :: :passthrough \| {:capture, password}`. Pattern-match `PRIVMSG NickServ :IDENTIFY\|GHOST\|REGISTER ...`. |
| `lib/grappa/session/ghost_recovery.ex` | Pure FSM. Mirrors `Grappa.IRC.AuthFSM` shape. Handles NICK-433-w/-cached-pwd reconnect dance. |
| `lib/mix/tasks/grappa.reap_visitors.ex` | Operator recovery for W7. `--network=<slug>` deletes orphaned visitor rows. |
| `priv/repo/migrations/<ts>_create_visitors.exs` | New table. UUID PK, unique on `(nick, network_slug)`, indexed on `(expires_at)` for Reaper. |
| `priv/repo/migrations/<ts>_create_visitor_channels.exs` | New table. FK to visitors ON DELETE CASCADE. |
| `priv/repo/migrations/<ts>_add_visitor_id_to_messages.exs` | Additive nullable + CHECK constraint. |
| `priv/repo/migrations/<ts>_add_visitor_id_to_accounts_sessions.exs` | Additive nullable + CHECK constraint. |

### Modified server-side modules

| Path | Change |
|------|--------|
| `lib/grappa/accounts.ex` | `authenticate/1` returns `Session.t()` w/ either FK; `create_session/3` accepts `subject :: {:user, id} \| {:visitor, id}`; `revoke_session/1` unchanged. |
| `lib/grappa/accounts/session.ex` | Add `visitor_id` field. Mutually-exclusive `belongs_to`. |
| `lib/grappa/scrollback.ex` | `persist_event/1` accepts `:visitor_id` xor `:user_id` in attrs. |
| `lib/grappa/scrollback/message.ex` | Add `visitor_id` field. Changeset enforces XOR. |
| `lib/grappa/session/server.ex` | `pending_auth: nil \| {pwd, monotonic_deadline}` state field. Outbound `send_privmsg` invokes `NSInterceptor`. `delegate/2` invokes `GhostRecovery.step/2`. `+r` MODE observation commits `pending_auth` via `Visitors.commit_password/2`. New `notify_pid` start_opt for synchronous login wait. |
| `lib/grappa/session/event_router.ex` | Detect `:mode` events on session's own nick that include `+r`; emit `{:visitor_r_observed, password}` effect when `pending_auth` is set. |
| `lib/grappa/bootstrap.ex` | Adds visitor respawn loop after credential loop. Pre-flight check W7: visitor network slugs must exist in config; raise on mismatch w/ recovery instructions. |
| `lib/grappa_web/controllers/auth_controller.ex` | `login/2` dispatches via `IdentifierClassifier`. Rendered subject shape per Q-E. |
| `lib/grappa_web/controllers/auth_json.ex` | New `subject` rendering. |
| `lib/grappa_web/plugs/authn.ex` | After `Accounts.authenticate/1`, branch on session FK to assign `current_user` xor `current_visitor`. On visitor branch, call `Visitors.touch/1` (W9). |
| `lib/grappa_web/channels/user_socket.ex` | `connect/3` branches on session FK; assigns `current_visitor` if applicable. |
| `lib/grappa_web/router.ex` | No new routes (existing `POST /auth/login` reused). |
| `config/config.exs` | Add `:grappa, :visitor_network` (read from `GRAPPA_VISITOR_NETWORK`), `:max_visitors_per_ip` (read from `GRAPPA_MAX_VISITORS_PER_IP`, default `5`). |
| `config/runtime.exs` | Reads env vars at runtime. |

### Modified cicchetto modules

| Path | Change |
|------|--------|
| `cicchetto/src/Login.tsx` | Single identifier field + optional password field. No mode tabs. |
| `cicchetto/src/lib/auth.ts` | Single `POST /auth/login` call. Branch on `subject.kind` for post-login navigation + state. |
| `cicchetto/src/lib/me.ts` | `GET /me` already returns user — extend to handle visitor subject kind. |
| `cicchetto/src/App.tsx` | Conditionally render visitor-specific UI (e.g., expires_at countdown badge — defer or include? See Task 25). |

### Test files

| Path | Tests |
|------|-------|
| `test/grappa/auth/identifier_classifier_test.exs` | Property tests for nick + email regex + malformed dispatch. |
| `test/grappa/visitors_test.exs` | Visitor CRUD, lifecycle, atomic password commit, sliding TTL, per-IP cap. |
| `test/grappa/visitors/reaper_test.exs` | Sweep behavior, CASCADE verification. |
| `test/grappa/visitors/login_test.exs` | Probe-connect happy/sad paths via `IRCServer` test helper, 8s timeout. |
| `test/grappa/visitors/session_plan_test.exs` | Resolve happy/sad paths. |
| `test/grappa/session/ns_interceptor_test.exs` | Capture for IDENTIFY/GHOST/REGISTER, passthrough for unrelated PRIVMSGs. |
| `test/grappa/session/ghost_recovery_test.exs` | FSM state transitions. |
| `test/grappa/scrollback_test.exs` | Extend: visitor_id persist path. |
| `test/grappa/bootstrap_test.exs` | Extend: visitor respawn happy + W7 hard-error. |
| `test/grappa_web/controllers/auth_controller_test.exs` | Extend: dispatch by classifier, subject rendering. |
| `test/grappa_web/plugs/authn_test.exs` | Extend: visitor session branch, `touch/1` cadence. |
| `test/grappa_web/channels/user_socket_test.exs` | Extend: visitor connect path. |
| `test/mix/tasks/grappa.reap_visitors_test.exs` | New: cli arg parse + DB delete. |

---

# Tasks

## Phase 1 — Foundation

### Task 1: IdentifierClassifier (pure module)

**Files:**
- Create: `lib/grappa/auth/identifier_classifier.ex`
- Test: `test/grappa/auth/identifier_classifier_test.exs`

- [ ] **Step 1.1: Write failing test**

```elixir
# test/grappa/auth/identifier_classifier_test.exs
defmodule Grappa.Auth.IdentifierClassifierTest do
  use ExUnit.Case, async: true
  alias Grappa.Auth.IdentifierClassifier

  describe "classify/1" do
    test "valid email → {:email, id}" do
      assert {:email, "vjt@bad.ass"} = IdentifierClassifier.classify("vjt@bad.ass")
    end

    test "valid RFC2812 nick → {:nick, id}" do
      assert {:nick, "vjt"} = IdentifierClassifier.classify("vjt")
      assert {:nick, "_grump"} = IdentifierClassifier.classify("_grump")
      assert {:nick, "[ofc]nerd"} = IdentifierClassifier.classify("[ofc]nerd")
    end

    test "nick starting with digit → :malformed (RFC2812)" do
      assert {:error, :malformed} = IdentifierClassifier.classify("9livesleft")
    end

    test "nick > 30 chars → :malformed" do
      long = String.duplicate("a", 31)
      assert {:error, :malformed} = IdentifierClassifier.classify(long)
    end

    test "nick with @ but invalid email → :malformed" do
      assert {:error, :malformed} = IdentifierClassifier.classify("foo@")
      assert {:error, :malformed} = IdentifierClassifier.classify("@bar")
    end

    test "empty string → :malformed" do
      assert {:error, :malformed} = IdentifierClassifier.classify("")
    end

    test "whitespace-padded → :malformed (no implicit trim)" do
      assert {:error, :malformed} = IdentifierClassifier.classify(" vjt ")
    end
  end
end
```

- [ ] **Step 1.2: Run, expect fail (module not loaded)**

```bash
scripts/test.sh test/grappa/auth/identifier_classifier_test.exs
```

Expected: `(UndefinedFunctionError)` or compile error.

- [ ] **Step 1.3: Implement**

The classifier delegates the nick-validity check to the canonical
`Grappa.IRC.Identifier.valid_nick?/1` rather than duplicating the
regex (CLAUDE.md "Implement once, reuse everywhere"). In the same
commit, tighten `Grappa.IRC.Identifier`'s `@nick_regex` from
`{0,30}` to `{0,29}` so the codebase has a single 30-char cap
across all callers (Networks.Credential changeset, IRC line guard,
IdentifierClassifier). Flip the corresponding 31-char-accept /
32-char-reject assertions in `test/grappa/irc/identifier_test.exs`
and `test/grappa/networks_test.exs` to 30-char-accept /
31-char-reject.

```elixir
# lib/grappa/auth/identifier_classifier.ex
defmodule Grappa.Auth.IdentifierClassifier do
  @moduledoc """
  Classifies a login identifier as an email (mode-1 admin path) or an
  RFC2812 nick (visitor path), or rejects malformed input at the
  boundary.

  Single discriminator: `String.contains?(id, "@")`. RFC2812 forbids
  `@` in nicks → unambiguous. Email path requires a minimal
  RFC5322-light shape (`x@y.z`); nick path delegates to
  `Grappa.IRC.Identifier.valid_nick?/1` so the codebase has a single
  source for the nick rule.

  Dispatch-only — actual email deliverability is checked downstream
  when the activation flow is invoked. Anything `x@y.z`-shaped routes
  to the email path; the email path itself is responsible for stricter
  validation.

  Used by `GrappaWeb.AuthController.login/2` to dispatch to either
  `Grappa.Accounts.get_user_by_credentials/2` or
  `Grappa.Visitors.login/4`.
  """

  use Boundary, top_level?: true, deps: [Grappa.IRC]

  alias Grappa.IRC.Identifier

  @email_re ~r/^[^@\s]+@[^@\s]+\.[^@\s]+$/

  @type result :: {:email, String.t()} | {:nick, String.t()} | {:error, :malformed}

  @doc """
  Classifies a login identifier as an email or RFC2812 nick.

  Returns `{:email, id}` if the identifier contains `@` and matches a
  minimal RFC5322-light pattern (`x@y.z`). Returns `{:nick, id}` if
  the identifier is a valid RFC2812 nick (delegated to
  `Grappa.IRC.Identifier.valid_nick?/1`). Returns
  `{:error, :malformed}` otherwise (leading digit, leading dash,
  invalid email format, length > 30, non-binary input, etc.).

  ## Examples

      iex> Grappa.Auth.IdentifierClassifier.classify("user@example.com")
      {:email, "user@example.com"}

      iex> Grappa.Auth.IdentifierClassifier.classify("vjt")
      {:nick, "vjt"}

      iex> Grappa.Auth.IdentifierClassifier.classify("9invalid")
      {:error, :malformed}

      iex> Grappa.Auth.IdentifierClassifier.classify(nil)
      {:error, :malformed}
  """
  @spec classify(term()) :: result()
  def classify(id) when is_binary(id) do
    cond do
      String.contains?(id, "@") and Regex.match?(@email_re, id) -> {:email, id}
      Identifier.valid_nick?(id) -> {:nick, id}
      true -> {:error, :malformed}
    end
  end

  def classify(_), do: {:error, :malformed}
end
```

```elixir
# lib/grappa/irc/identifier.ex — tighten cap from {0,30} (1+30=31) to
# {0,29} (1+29=30); update the comment from "Total length ≤ 31" to
# "Total length ≤ 30".
@nick_regex ~r/^[A-Za-z\[\]\\`_^{|}][\w\[\]\\`_^{|}\-]{0,29}$/
```

- [ ] **Step 1.4: Run, expect pass**

```bash
scripts/test.sh test/grappa/auth/identifier_classifier_test.exs
```

Expected: 7 passes.

- [ ] **Step 1.5: Property tests via StreamData**

The classifier-only logic to property-test is the email-shape
dispatch. The nick-validity properties live upstream in
`test/grappa/irc/identifier_test.exs:31-44` and cover the nick path
through `valid_nick?/1` already; duplicating them here would test
delegation, not behavior.

```elixir
# Append to test/grappa/auth/identifier_classifier_test.exs
  describe "property: classify/1" do
    use ExUnitProperties

    property "any x@y.z-shaped string classifies as :email" do
      check all(
              local <- StreamData.string([?a..?z, ?A..?Z, ?0..?9, ?_], min_length: 1, max_length: 20),
              domain <- StreamData.string([?a..?z, ?A..?Z, ?0..?9], min_length: 1, max_length: 20),
              tld <- StreamData.string([?a..?z], min_length: 2, max_length: 6)
            ) do
        addr = "#{local}@#{domain}.#{tld}"
        assert {:email, ^addr} = IdentifierClassifier.classify(addr)
      end
    end
  end
```

The test file's preamble adds a `doctest` macro so the `@doc`
examples are exercised at compile-time:

```elixir
defmodule Grappa.Auth.IdentifierClassifierTest do
  use ExUnit.Case, async: true
  doctest Grappa.Auth.IdentifierClassifier
  alias Grappa.Auth.IdentifierClassifier

  # …
end
```

- [ ] **Step 1.6: Run all gates**

```bash
scripts/check.sh
```

Expected: green. Zero warnings.

- [ ] **Step 1.7: Commit**

```bash
git add lib/grappa/auth/identifier_classifier.ex test/grappa/auth/identifier_classifier_test.exs
git commit -m "$(cat <<'EOF'
feat(auth): add IdentifierClassifier for hybrid email/nick dispatch

Pure module classifying login identifier as :email or :nick. Routes
mode-1 (admin) vs visitor paths in AuthController. RFC2812 nick regex
+ RFC5322-light email regex; @ presence is the unambiguous discriminator.

Foundation for cluster/visitor-auth — first task of the cluster.
EOF
)"
```

---

### Task 2: visitors table migration + schema

**Files:**
- Create: `priv/repo/migrations/<ts>_create_visitors.exs`
- Create: `lib/grappa/visitors/visitor.ex`
- Test: extend `test/grappa/visitors_test.exs` (created in Task 3)

- [ ] **Step 2.1: Generate migration**

```bash
scripts/mix.sh ecto.gen.migration create_visitors
```

Migration body:

```elixir
defmodule Grappa.Repo.Migrations.CreateVisitors do
  use Ecto.Migration

  def change do
    create table(:visitors, primary_key: false) do
      add :id, :binary_id, primary_key: true
      add :nick, :string, null: false
      add :network_slug, :string, null: false
      add :password_encrypted, :binary
      add :expires_at, :utc_datetime_usec, null: false
      add :ip, :string

      timestamps(type: :utc_datetime_usec)
    end

    create unique_index(:visitors, [:nick, :network_slug])
    create index(:visitors, [:expires_at])
    create index(:visitors, [:ip])
  end
end
```

- [ ] **Step 2.2: Run migration**

```bash
scripts/mix.sh ecto.migrate
```

Expected: `[info] create table visitors` followed by index creation.

- [ ] **Step 2.3: Schema module**

```elixir
# lib/grappa/visitors/visitor.ex
defmodule Grappa.Visitors.Visitor do
  @moduledoc """
  Self-service visitor — collapsed shape for both anon and
  NickServ-as-IDP modes per cluster/visitor-auth.

  ## Lifecycle
  - Created on first `POST /auth/login` with a non-`@` identifier.
  - `password_encrypted` nil = anon (no NickServ password ever observed
    via +r MODE).
  - `password_encrypted` non-nil = NickServ password atomically committed
    after grappa observed +r MODE on the visitor's nick (see
    `Grappa.Visitors.commit_password/2`).
  - `expires_at` slides on user-initiated REST/WS verbs (≥1h cadence) +
    jumps to now+7d on +r MODE observation.
  - Reaped by `Grappa.Visitors.Reaper` when `expires_at < now()`. CASCADE
    wipes related rows in `visitor_channels`, `messages`, `accounts_sessions`.

  ## Per-row network pinning
  `network_slug` is fixed at row creation. A config rotation
  (`GRAPPA_VISITOR_NETWORK` change) renders existing rows orphans —
  `Grappa.Bootstrap` hard-errors with operator instructions to run
  `mix grappa.reap_visitors --network=<old_slug>`.
  """

  use Ecto.Schema
  import Ecto.Changeset

  alias Grappa.EncryptedBinary
  alias Grappa.IRC.Identifier
  alias Grappa.Visitors.VisitorChannel

  @type t :: %__MODULE__{
          id: Ecto.UUID.t() | nil,
          nick: String.t() | nil,
          network_slug: String.t() | nil,
          password_encrypted: binary() | nil,
          expires_at: DateTime.t() | nil,
          ip: String.t() | nil,
          channels: [VisitorChannel.t()] | Ecto.Association.NotLoaded.t(),
          inserted_at: DateTime.t() | nil,
          updated_at: DateTime.t() | nil
        }

  @primary_key {:id, :binary_id, autogenerate: true}
  @foreign_key_type :binary_id
  schema "visitors" do
    field :nick, :string
    field :network_slug, :string
    field :password_encrypted, EncryptedBinary, redact: true
    field :expires_at, :utc_datetime_usec
    field :ip, :string

    has_many :channels, VisitorChannel, foreign_key: :visitor_id

    timestamps(type: :utc_datetime_usec)
  end

  @doc """
  Builds an anon-visitor create changeset. Required fields: `:nick`,
  `:network_slug`, `:expires_at`. `:ip` is optional. Validates `:nick`
  against `Identifier.valid_nick?/1` and `:network_slug` against
  `Identifier.valid_network_slug?/1` — both are wire-bound (PubSub
  topics + IRC handshake), so syntactic hygiene is enforced at the
  boundary. Uniqueness on `(nick, network_slug)` per W2.
  """
  @spec create_changeset(map()) :: Ecto.Changeset.t()
  def create_changeset(attrs) do
    %__MODULE__{}
    |> cast(attrs, [:nick, :network_slug, :expires_at, :ip])
    |> validate_required([:nick, :network_slug, :expires_at])
    |> validate_change(:nick, &validate_nick/2)
    |> validate_change(:network_slug, &validate_network_slug/2)
    |> unique_constraint([:nick, :network_slug])
  end

  @doc """
  Atomically commit a NickServ password (encrypted at rest by Cloak)
  and bump expires_at to the registered-user TTL after grappa observed
  +r MODE on the visitor's nick.

  Caller MUST pass a non-empty binary as `password`. Misuse raises
  `FunctionClauseError` — the +r MODE observation handler in
  `Grappa.Session.Server` is the documented (and only) call site, so
  let-it-crash on a bouncer-internal contract violation is the
  appropriate OTP shape.
  """
  @spec commit_password_changeset(t(), binary(), DateTime.t()) :: Ecto.Changeset.t()
  def commit_password_changeset(%__MODULE__{} = visitor, password, expires_at)
      when is_binary(password) and byte_size(password) > 0 do
    change(visitor, %{password_encrypted: password, expires_at: expires_at})
  end

  @doc """
  Slides `expires_at` forward on user-initiated REST/WS verbs. Caller
  enforces the ≥1h cadence (no-op if last touch <1h) — see
  `Grappa.Visitors.touch/1`. Pure schema-level concern: just bumps the
  column.
  """
  @spec touch_changeset(t(), DateTime.t()) :: Ecto.Changeset.t()
  def touch_changeset(%__MODULE__{} = visitor, new_expires_at) do
    change(visitor, %{expires_at: new_expires_at})
  end

  defp validate_nick(field, value) when is_binary(value) do
    if Identifier.valid_nick?(value),
      do: [],
      else: [{field, "must be a valid IRC nickname"}]
  end

  defp validate_network_slug(field, value) when is_binary(value) do
    if Identifier.valid_network_slug?(value),
      do: [],
      else: [{field, "must be a valid network slug"}]
  end
end
```

- [ ] **Step 2.4: Run check.sh (compile + format + credo)**

```bash
scripts/format.sh && scripts/credo.sh
```

Expected: green.

- [ ] **Step 2.5: Commit**

```bash
git add priv/repo/migrations/*_create_visitors.exs lib/grappa/visitors/visitor.ex
git commit -m "$(cat <<'EOF'
feat(visitors): add visitors schema + migration

UUID PK + (nick, network_slug) unique + nullable Cloak-encrypted
password + sliding expires_at. Anon path = nil password. Per-row
network pinning per W7 — config rotation triggers Bootstrap hard-error
with mix grappa.reap_visitors recovery path.
EOF
)"
```

---

### Task 3: visitor_channels table + schema

**Files:**
- Create: `priv/repo/migrations/<ts>_create_visitor_channels.exs`
- Create: `lib/grappa/visitors/visitor_channel.ex`

- [ ] **Step 3.1: Migration**

```bash
scripts/mix.sh ecto.gen.migration create_visitor_channels
```

```elixir
defmodule Grappa.Repo.Migrations.CreateVisitorChannels do
  use Ecto.Migration

  def change do
    create table(:visitor_channels, primary_key: false) do
      add :id, :binary_id, primary_key: true
      add :visitor_id, references(:visitors, type: :binary_id, on_delete: :delete_all), null: false
      add :network_slug, :string, null: false
      add :name, :string, null: false

      timestamps(type: :utc_datetime_usec)
    end

    create unique_index(:visitor_channels, [:visitor_id, :network_slug, :name])
    create index(:visitor_channels, [:visitor_id])
  end
end
```

- [ ] **Step 3.2: Run migration**

```bash
scripts/mix.sh ecto.migrate
```

- [ ] **Step 3.3: Schema**

```elixir
# lib/grappa/visitors/visitor_channel.ex
defmodule Grappa.Visitors.VisitorChannel do
  @moduledoc """
  Tracks a visitor's joined channels. Source of truth for
  Bootstrap-respawn rejoin list. Updated by Session.Server's join/part
  events for visitor sessions; symmetric to `Networks.Channel` for
  mode-1 users.

  W1 pin: separate from `Networks.Channel` to keep `(user, network)`
  + `(visitor, network)` lifecycles in distinct rowsets — no nullable
  cross-mode FK on `Networks.Channel`.
  """

  use Ecto.Schema
  import Ecto.Changeset

  alias Grappa.IRC.Identifier
  alias Grappa.Visitors.Visitor

  @type t :: %__MODULE__{
          id: Ecto.UUID.t() | nil,
          visitor_id: Ecto.UUID.t() | nil,
          visitor: Visitor.t() | Ecto.Association.NotLoaded.t() | nil,
          network_slug: String.t() | nil,
          name: String.t() | nil
        }

  @primary_key {:id, :binary_id, autogenerate: true}
  @foreign_key_type :binary_id
  schema "visitor_channels" do
    belongs_to :visitor, Visitor

    field :network_slug, :string
    field :name, :string

    timestamps(type: :utc_datetime_usec)
  end

  @doc """
  Builds a create changeset for a visitor's joined-channel record.
  Required fields: `:visitor_id`, `:network_slug`, `:name`. Both
  `:network_slug` (`Identifier.valid_network_slug?/1`) and `:name`
  (`Identifier.valid_channel?/1`) are validated against canonical
  IRC identifier predicates — channel names go on the wire as JOIN
  arguments, so syntactic hygiene matters. Uniqueness on
  `(visitor_id, network_slug, name)` prevents duplicate JOINs.
  """
  @spec changeset(map()) :: Ecto.Changeset.t()
  def changeset(attrs) do
    %__MODULE__{}
    |> cast(attrs, [:visitor_id, :network_slug, :name])
    |> validate_required([:visitor_id, :network_slug, :name])
    |> validate_change(:network_slug, &validate_network_slug/2)
    |> validate_change(:name, &validate_channel_name/2)
    |> unique_constraint([:visitor_id, :network_slug, :name])
    |> foreign_key_constraint(:visitor_id)
  end

  defp validate_network_slug(field, value) when is_binary(value) do
    if Identifier.valid_network_slug?(value),
      do: [],
      else: [{field, "must be a valid network slug"}]
  end

  defp validate_channel_name(field, value) when is_binary(value) do
    if Identifier.valid_channel?(value),
      do: [],
      else: [{field, "must be a valid IRC channel name"}]
  end
end
```

- [ ] **Step 3.4: Bidirectional association + Boundary export**

VisitorChannel ↔ Visitor needs a bidirectional Ecto association so
`Repo.preload(visitor, :channels)` works for Bootstrap-respawn
enumeration (Tasks 8 + 19) and so the schema shape mirrors the
documented CASCADE in `Visitor`'s moduledoc. The Visitor schema's
`alias` + `@type t` + `has_many` were added in Task 2's amended spec —
verify they landed.

The `Grappa.Visitors` Boundary stub (created opportunistically during
Task 2 to host the `alias Grappa.IRC.Identifier` cross-call from the
Visitor schema) currently exports only `[Visitor]`. Cross-boundary
callers in Tasks 6 + 8 + 19 will reference `VisitorChannel` directly
(Bootstrap pattern-matches `%VisitorChannel{}` on respawn rejoin
enumeration; Session.Server's join/part handler constructs them).
Sibling pattern in `Grappa.Networks` (`networks.ex:36`) exports every
cross-referenced child schema. Apply the same shape:

```elixir
# lib/grappa/visitors.ex — expand exports
use Boundary, top_level?: true, deps: [Grappa.IRC], exports: [Visitor, VisitorChannel]
```

(The Task 6 expansion at the bottom of this plan also reflects this
shape — see "exports: [Visitor, VisitorChannel]" there.)

- [ ] **Step 3.5: Commit**

```bash
git add priv/repo/migrations/*_create_visitor_channels.exs lib/grappa/visitors/visitor_channel.ex lib/grappa/visitors/visitor.ex lib/grappa/visitors.ex
git commit -m "$(cat <<'EOF'
feat(visitors): add visitor_channels schema + migration

Tracks joined channels per visitor for Bootstrap-respawn rejoin.
Separate table from Networks.Channel per W1 — distinct lifecycles,
no cross-mode FK on Networks.Channel.

Visitor schema gets a bidirectional has_many :channels association
mirroring Networks.Network → Server/Credential. Visitors boundary
exports VisitorChannel so Bootstrap + Session.Server can pattern-match
on it from outside the boundary.
EOF
)"
```

---

### Task 4: messages.visitor_id additive migration + XOR check

**Files:**
- Create: `priv/repo/migrations/<ts>_add_visitor_id_to_messages.exs`
- Modify: `lib/grappa/scrollback/message.ex`
- Modify: `lib/grappa/scrollback.ex`
- Test: extend `test/grappa/scrollback_test.exs`

- [ ] **Step 4.1: Migration**

```bash
scripts/mix.sh ecto.gen.migration add_visitor_id_to_messages
```

ecto_sqlite3 does NOT support `alter table ... modify` (sqlite has no
`ALTER COLUMN`) or `create constraint` (sqlite has no `ALTER TABLE ADD
CONSTRAINT` for CHECK). Use the rename + recreate + copy + drop pattern
in raw SQL via `execute/1` — same shape as
`priv/repo/migrations/20260426000003_messages_per_user_iso.exs` and
`20260426000004_messages_network_fk_restrict.exs`. Define
explicit `up/0` + `down/0` (not `change/0`) since auto-rollback can't
introspect raw SQL:

```elixir
defmodule Grappa.Repo.Migrations.AddVisitorIdToMessages do
  use Ecto.Migration

  def up do
    execute("ALTER TABLE messages RENAME TO messages_old")

    execute("""
    CREATE TABLE "messages" (
      "id" INTEGER PRIMARY KEY AUTOINCREMENT,
      "channel" TEXT NOT NULL,
      "server_time" INTEGER NOT NULL,
      "kind" TEXT NOT NULL,
      "sender" TEXT NOT NULL,
      "body" TEXT NULL,
      "meta" TEXT NOT NULL,
      "inserted_at" TEXT NOT NULL,
      "user_id" TEXT NULL CONSTRAINT "messages_user_id_fkey" REFERENCES "users"("id") ON DELETE CASCADE,
      "visitor_id" TEXT NULL CONSTRAINT "messages_visitor_id_fkey" REFERENCES "visitors"("id") ON DELETE CASCADE,
      "network_id" INTEGER NOT NULL CONSTRAINT "messages_network_id_fkey" REFERENCES "networks"("id") ON DELETE RESTRICT,
      CONSTRAINT "messages_subject_xor" CHECK ((user_id IS NULL) <> (visitor_id IS NULL))
    )
    """)

    execute("""
    INSERT INTO messages (id, channel, server_time, kind, sender, body, meta, inserted_at, user_id, network_id)
    SELECT id, channel, server_time, kind, sender, body, meta, inserted_at, user_id, network_id
    FROM messages_old
    """)

    execute("DROP TABLE messages_old")

    create index(:messages, [:user_id, :network_id, :channel, :server_time])
    create index(:messages, [:visitor_id])
  end

  def down do
    execute("ALTER TABLE messages RENAME TO messages_new")

    execute("""
    CREATE TABLE "messages" (
      "id" INTEGER PRIMARY KEY AUTOINCREMENT,
      "channel" TEXT NOT NULL,
      "server_time" INTEGER NOT NULL,
      "kind" TEXT NOT NULL,
      "sender" TEXT NOT NULL,
      "body" TEXT NULL,
      "meta" TEXT NOT NULL,
      "inserted_at" TEXT NOT NULL,
      "user_id" TEXT NOT NULL CONSTRAINT "messages_user_id_fkey" REFERENCES "users"("id") ON DELETE CASCADE,
      "network_id" INTEGER NOT NULL CONSTRAINT "messages_network_id_fkey" REFERENCES "networks"("id") ON DELETE RESTRICT
    )
    """)

    execute("""
    INSERT INTO messages (id, channel, server_time, kind, sender, body, meta, inserted_at, user_id, network_id)
    SELECT id, channel, server_time, kind, sender, body, meta, inserted_at, user_id, network_id
    FROM messages_new
    WHERE user_id IS NOT NULL
    """)

    execute("DROP TABLE messages_new")

    create index(:messages, [:user_id, :network_id, :channel, :server_time])
  end
end
```

The `down/0` filter `WHERE user_id IS NOT NULL` is load-bearing: if any
visitor-owned rows existed, they'd violate the restored `user_id NOT
NULL` constraint and the rollback would fail. Dropping them is the only
safe rollback semantic — operator must be aware visitor scrollback is
lost on downgrade. Phase 1 walking-skeleton dev DB has zero rows so
this is moot; documenting for Phase 5 onward.

- [ ] **Step 4.2: Run migration**

```bash
scripts/mix.sh ecto.migrate
```

- [ ] **Step 4.3: Update Message schema**

The current `Grappa.Scrollback.Message` schema (post-Task-3) uses the
two-arity `changeset(message, attrs)` shape called from 7+ sites
(`Scrollback.persist_event/1`, `ScrollbackHelpers.insert/1`, plus
direct test calls). PRESERVE the two-arity signature — do NOT change to
`changeset(attrs)`.

Schema block changes — add `belongs_to :visitor` next to `belongs_to :user`:

```elixir
schema "messages" do
  belongs_to :user, User, type: :binary_id
  belongs_to :visitor, Grappa.Visitors.Visitor, type: :binary_id
  belongs_to :network, Network
  # ... rest unchanged (channel, server_time, kind, sender, body, meta, timestamps)
end
```

`@type t` grows two entries (place near the existing `:user` /
`:user_id` lines for visual symmetry):

```elixir
visitor_id: Ecto.UUID.t() | nil,
visitor: Grappa.Visitors.Visitor.t() | Ecto.Association.NotLoaded.t() | nil,
```

Add `alias Grappa.Visitors.Visitor` near the existing `alias Grappa.Accounts.User`.

XOR-validation helper, placed alongside the existing `validate_body_for_kind/1`:

```elixir
@spec validate_subject_xor(Ecto.Changeset.t()) :: Ecto.Changeset.t()
defp validate_subject_xor(changeset) do
  user_id = get_field(changeset, :user_id)
  visitor_id = get_field(changeset, :visitor_id)

  case {user_id, visitor_id} do
    {nil, nil} -> add_error(changeset, :user_id, "must set user_id or visitor_id")
    {_, nil} -> changeset
    {nil, _} -> changeset
    {_, _} -> add_error(changeset, :user_id, "user_id and visitor_id are mutually exclusive")
  end
end
```

Wire into the existing two-arity `changeset/2` — extend the cast list,
DROP `:user_id` from `validate_required` (now must be one xor the other,
enforced by `validate_subject_xor`), add the XOR check, add
`assoc_constraint(:visitor)` next to the existing `:user` constraint:

```elixir
@spec changeset(t() | %__MODULE__{}, map()) :: Ecto.Changeset.t()
def changeset(message, attrs) do
  message
  |> cast(attrs, [
    :user_id,
    :visitor_id,
    :network_id,
    :channel,
    :server_time,
    :kind,
    :sender,
    :body,
    :meta
  ])
  |> validate_required([:network_id, :channel, :server_time, :kind, :sender])
  |> validate_subject_xor()
  |> validate_identifier(:channel, &Identifier.valid_channel?/1)
  |> validate_identifier(:sender, &Identifier.valid_sender?/1)
  |> validate_body_for_kind()
  |> assoc_constraint(:user)
  |> assoc_constraint(:visitor)
  |> assoc_constraint(:network)
end
```

`validate_subject_xor()` runs IMMEDIATELY after `validate_required`,
BEFORE the per-field validators. The XOR is a structural invariant —
without a subject the row is uncreatable regardless of body/identifier
shape, so the structural error should surface first. This mirrors the
pipeline-ordering convention in every other changeset in the codebase
(structural checks before per-field validators).

- [ ] **Step 4.4: Update Scrollback.persist_event/1**

The internal call shape (`Message.changeset(%Message{}, attrs)`)
stays — only the `@spec` widens. Move `:user_id` from `required` to
`optional`, add `:visitor_id` as `optional`. The XOR is enforced in
the changeset; the spec just allows either input shape.

```elixir
@spec persist_event(%{
        optional(:user_id) => Ecto.UUID.t(),
        optional(:visitor_id) => Ecto.UUID.t(),
        required(:network_id) => integer(),
        required(:channel) => String.t(),
        required(:server_time) => integer(),
        required(:kind) => Message.kind(),
        required(:sender) => String.t(),
        required(:body) => String.t() | nil,
        required(:meta) => Meta.t()
      }) :: {:ok, Message.t()} | {:error, Ecto.Changeset.t()}
def persist_event(%{kind: kind} = attrs) when is_atom(kind) do
  changeset = Message.changeset(%Message{}, attrs)

  case Repo.insert(changeset) do
    {:ok, message} -> {:ok, Repo.preload(message, :network)}
    {:error, _} = err -> err
  end
end
```

`server_time` stays `integer()` (epoch ms — see Message moduledoc),
NOT `DateTime.t()`. `meta` is `Meta.t()` (the typed map alias), NOT
plain `map()`.

`Grappa.Scrollback`'s Boundary `deps` grows `Grappa.Visitors` — the
`belongs_to :visitor, Visitor, type: :binary_id` reference in the
schema crosses that boundary. Without the dep declaration, Boundary
fails compile with a cross-boundary call violation. Verified
acyclic: `Grappa.Visitors` deps only `Grappa.IRC` (does not reference
`Grappa.Scrollback`).

```elixir
# lib/grappa/scrollback.ex — Boundary deps line
use Boundary,
  top_level?: true,
  deps: [Grappa.Accounts, Grappa.IRC, Grappa.Repo, Grappa.Visitors],
  dirty_xrefs: [Grappa.Networks.Network],
  exports: [Message, Wire]
```

A pre-existing test in `scrollback_test.exs` ("rejects missing required
fields (user_id/network_id/channel/server_time/kind/sender)") asserts
`"can't be blank" in errors.user_id` — that error no longer fires
because `user_id` was dropped from `validate_required`. Update the test
name + the assertion to reflect the new contract:

```elixir
test "rejects missing required fields (network_id/channel/server_time/kind/sender) and XOR subject" do
  assert {:error, %Ecto.Changeset{} = cs} =
           ScrollbackHelpers.insert(%{channel: "#x"})

  errors = errors_on(cs)
  # user_id is no longer validate_required — XOR validation fires instead
  assert "must set user_id or visitor_id" in errors.user_id
  assert "can't be blank" in errors.network_id
  # ... rest of the assertion list unchanged
end
```

This is an honest update — the contract genuinely changed. NOT a
test-weakened-to-make-it-pass case (CLAUDE.md "Never weaken production
code to make tests pass" applies the other direction too: never
weaken a test to mask a contract change; rewrite the test to assert
the new contract precisely).

- [ ] **Step 4.5: Test extension**

The codebase uses fixture-style helpers in `test/support/auth_fixtures.ex`,
NOT ExMachina factories. Tests use `visitor_fixture/1` + `network_fixture/1`
(both added in Step 4.5a) plus direct attribute maps. `server_time`
is an integer (epoch ms via `System.system_time(:millisecond)` —
matches the sibling pattern at `scrollback_test.exs` line ~93);
`meta` defaults to `%{}`.

```elixir
# test/grappa/scrollback_test.exs — add visitor branch
describe "persist_event/1 with visitor_id" do
  test "persists with visitor_id, no user_id" do
    visitor = visitor_fixture()
    network = network_fixture()

    attrs = %{
      visitor_id: visitor.id,
      network_id: network.id,
      channel: "#italia",
      kind: :privmsg,
      sender: "vjt",
      body: "ciao",
      server_time: System.system_time(:millisecond),
      meta: %{}
    }

    assert {:ok, msg} = Scrollback.persist_event(attrs)
    assert msg.visitor_id == visitor.id
    assert is_nil(msg.user_id)
  end

  test "rejects when both user_id and visitor_id set" do
    user = user_fixture()
    visitor = visitor_fixture()
    network = network_fixture()

    attrs = %{
      user_id: user.id,
      visitor_id: visitor.id,
      network_id: network.id,
      channel: "#italia",
      kind: :privmsg,
      sender: "vjt",
      body: "ciao",
      server_time: System.system_time(:millisecond),
      meta: %{}
    }

    assert {:error, changeset} = Scrollback.persist_event(attrs)
    assert "mutually exclusive" in errors_on(changeset).user_id
  end

  test "rejects when neither user_id nor visitor_id set" do
    network = network_fixture()
    attrs = %{
      network_id: network.id,
      channel: "#italia",
      kind: :privmsg,
      sender: "vjt",
      body: "ciao",
      server_time: System.system_time(:millisecond),
      meta: %{}
    }

    assert {:error, changeset} = Scrollback.persist_event(attrs)
    assert "must set user_id or visitor_id" in errors_on(changeset).user_id
  end
end
```

The test module already imports `Grappa.AuthFixtures` (or should — add
the import if missing). `errors_on/1` comes from `Grappa.DataCase`.

- [ ] **Step 4.5a: Add visitor + network fixtures**

Extend `test/support/auth_fixtures.ex` (NOT a new `factories.ex` —
codebase has no ExMachina dep, sibling pattern is keyword-arg fixture
fns). Boundary `deps` grows `Grappa.Visitors`; alias chain grows
`Grappa.Visitors.Visitor`.

```elixir
# test/support/auth_fixtures.ex — additions

# In the alias block:
alias Grappa.Visitors.Visitor

# Boundary deps line — add Grappa.Visitors:
use Boundary,
  top_level?: true,
  deps: [Grappa.Accounts, Grappa.Networks, Grappa.Repo, Grappa.Session, Grappa.Visitors]

@doc """
Inserts a `%Visitor{}` directly via `Visitor.create_changeset/1` —
exercises the canonical-validator path so a malformed nick/slug
default would surface here rather than in the test that uses it.
"""
@spec visitor_fixture(keyword()) :: Visitor.t()
def visitor_fixture(attrs \\ []) do
  nick = Keyword.get(attrs, :nick, "v#{System.unique_integer([:positive])}")
  network_slug = Keyword.get(attrs, :network_slug, "azzurra")
  expires_at = Keyword.get(attrs, :expires_at, DateTime.utc_now() |> DateTime.add(48, :hour))
  ip = Keyword.get(attrs, :ip)

  {:ok, visitor} =
    %{nick: nick, network_slug: network_slug, expires_at: expires_at, ip: ip}
    |> Visitor.create_changeset()
    |> Repo.insert()

  visitor
end

@doc """
Inserts a `%Network{}` row (no servers attached). For tests that
need a `network_id` FK target without spinning up an `IRCServer`
fake (`network_with_server/1` is the with-server variant).
"""
@spec network_fixture(keyword()) :: Network.t()
def network_fixture(attrs \\ []) do
  slug = Keyword.get(attrs, :slug, "net-#{System.unique_integer([:positive])}")
  {:ok, network} = Networks.find_or_create_network(%{slug: slug})
  network
end
```

- [ ] **Step 4.6: Run all tests**

```bash
scripts/check.sh
```

Expected: green. Existing scrollback tests unaffected (user_id branch
unchanged); new XOR tests pass; doctor + dialyzer + sobelow + format
all pass.

- [ ] **Step 4.7: Commit**

```bash
git add priv/repo/migrations/*_add_visitor_id_to_messages.exs \
        lib/grappa/scrollback/message.ex lib/grappa/scrollback.ex \
        test/grappa/scrollback_test.exs test/support/auth_fixtures.ex
git commit -m "$(cat <<'EOF'
feat(scrollback): add visitor_id XOR user_id on messages

Additive nullable visitor_id FK + sqlite CHECK constraint
((user_id IS NULL) <> (visitor_id IS NULL)) per W2. Scrollback.persist_event/1
accepts either FK; Message.changeset enforces XOR at the application
boundary as well. assoc_constraint(:visitor) catches FK violations at
insert time. Scrollback wire shape unchanged for user_id path.

Visitor + network fixtures land in auth_fixtures.ex (sibling pattern),
not a new factories.ex — codebase has no ExMachina dep.
EOF
)"
```

---

### Task 5: sessions.visitor_id additive migration

**Files:**
- Create: `priv/repo/migrations/<ts>_add_visitor_id_to_sessions.exs`
- Modify: `lib/grappa/accounts/session.ex`
- Modify: `lib/grappa/accounts.ex` (boundary `deps:` + `create_session/3` contract)
- Modify: `test/support/auth_fixtures.ex` (`session_fixture/1` callsite)
- Modify: `test/grappa_web/plugs/authn_test.exs` (1 callsite)
- Modify: `test/grappa/accounts/sessions_test.exs` (5 callsites + add visitor cases)
- Modify: `lib/grappa_web/controllers/auth_controller.ex` (1 callsite — temporary; full dispatch lands in Task 10)

**Drift notes (caught pre-dispatch — original plan body had drift on every dimension):**
1. Real table name is `:sessions`, NOT `:accounts_sessions` (per
   `priv/repo/migrations/20260426000001_create_sessions.exs` and
   `Grappa.Accounts.Session` `schema "sessions"`).
2. ecto_sqlite3 supports neither `alter table ... modify` nor
   `create constraint` (ALTER TABLE in sqlite only supports ADD COLUMN).
   Use the rename → recreate → copy → drop pattern from Task 4
   (`priv/repo/migrations/20260502085339_add_visitor_id_to_messages.exs`).
3. Existing `Session` schema has `created_at`, `last_seen_at`,
   `revoked_at`, `user_agent`, `ip` fields the recreated `CREATE TABLE`
   must preserve. Existing indexes are `[:user_id]` and `[:last_seen_at]`.
4. `Grappa.Accounts` Boundary on `lib/grappa/accounts.ex:47` lists
   `deps: [Grappa.Repo]` only. Adding `Grappa.Visitors` is required so
   `assoc_constraint(:visitor)` and any pre-flight FK check resolve.
5. Plan's original `validate_subject_xor` body was tangled. Mirror
   Task 4's `Scrollback.Message.validate_subject_xor/1` shape exactly
   — clean tuple pattern match, three clauses, placed BEFORE
   per-field validators in the changeset pipeline.
6. Plan's `validate_user_exists/1` pre-flight already exists in
   `Accounts` (s29 H4) — generalize to `validate_subject_exists/1`
   that branches on whichever side of the XOR is set.
7. Test scenarios live in `test/grappa/accounts/sessions_test.exs`,
   NOT `test/grappa/accounts_test.exs` (the latter has user CRUD only).
8. No ExMachina `insert(:visitor)` — use `visitor_fixture/0` from
   `test/support/auth_fixtures.ex`. No `insert(:user)` — use the
   inline `Repo.insert(%User{name: ..., password_hash: "x"})` pattern
   the existing sessions tests already use.
9. Three XOR test cases per Task 4 precedent: user-only (positive),
   visitor-only (positive), both-set (rejected), neither-set (rejected).

- [ ] **Step 5.1: Migration**

```bash
scripts/mix.sh ecto.gen.migration add_visitor_id_to_sessions
```

Migration body — full rename+recreate+copy dance (mirror of Task 4).
The XOR CHECK is table-level so it must live in the `CREATE TABLE`
body; `user_id` becomes nullable; `visitor_id` is a new nullable FK.

```elixir
defmodule Grappa.Repo.Migrations.AddVisitorIdToSessions do
  @moduledoc """
  visitor_id additive migration on sessions (cluster visitor-auth Q-A).

  Adds a nullable `visitor_id` FK to `Grappa.Visitors.Visitor` and makes
  `user_id` nullable so a session row binds to either an authenticated
  user OR a visitor — never both, never neither. The XOR invariant is
  enforced at the DB level (CHECK constraint) and at the application
  layer (`Session.changeset/2` calls `validate_subject_xor/1`).

  ## SQLite limitations

  ecto_sqlite3 does not support `modify` (ALTER COLUMN) or
  `create constraint` (ALTER TABLE ADD CONSTRAINT). Making `user_id`
  nullable and adding a table-level XOR CHECK requires a full
  table-recreate via raw SQL — same pattern as Task 4's messages
  migration (20260502085339).
  """
  use Ecto.Migration

  def up do
    execute("ALTER TABLE sessions RENAME TO sessions_old")

    execute("""
    CREATE TABLE "sessions" (
      "id" TEXT PRIMARY KEY,
      "user_id" TEXT NULL CONSTRAINT "sessions_user_id_fkey" REFERENCES "users"("id") ON DELETE CASCADE,
      "visitor_id" TEXT NULL CONSTRAINT "sessions_visitor_id_fkey" REFERENCES "visitors"("id") ON DELETE CASCADE,
      "created_at" TEXT NOT NULL,
      "last_seen_at" TEXT NOT NULL,
      "revoked_at" TEXT NULL,
      "user_agent" TEXT NULL,
      "ip" TEXT NULL,
      CONSTRAINT "sessions_subject_xor" CHECK ((user_id IS NULL) <> (visitor_id IS NULL))
    )
    """)

    # Existing rows are all user-bound (visitor_id NULL satisfies XOR).
    execute("""
    INSERT INTO sessions (id, user_id, created_at, last_seen_at, revoked_at, user_agent, ip)
    SELECT id, user_id, created_at, last_seen_at, revoked_at, user_agent, ip
    FROM sessions_old
    """)

    execute("DROP TABLE sessions_old")

    create index(:sessions, [:user_id])
    create index(:sessions, [:last_seen_at])
    create index(:sessions, [:visitor_id])
  end

  def down do
    execute("ALTER TABLE sessions RENAME TO sessions_new")

    execute("""
    CREATE TABLE "sessions" (
      "id" TEXT PRIMARY KEY,
      "user_id" TEXT NOT NULL CONSTRAINT "sessions_user_id_fkey" REFERENCES "users"("id") ON DELETE CASCADE,
      "created_at" TEXT NOT NULL,
      "last_seen_at" TEXT NOT NULL,
      "revoked_at" TEXT NULL,
      "user_agent" TEXT NULL,
      "ip" TEXT NULL
    )
    """)

    # Visitor-bound sessions are dropped on rollback (no user_id to project to).
    execute("""
    INSERT INTO sessions (id, user_id, created_at, last_seen_at, revoked_at, user_agent, ip)
    SELECT id, user_id, created_at, last_seen_at, revoked_at, user_agent, ip
    FROM sessions_new
    WHERE user_id IS NOT NULL
    """)

    execute("DROP TABLE sessions_new")

    create index(:sessions, [:user_id])
    create index(:sessions, [:last_seen_at])
  end
end
```

- [ ] **Step 5.2: Run migration**

```bash
scripts/mix.sh ecto.migrate
```

- [ ] **Step 5.3: Update Accounts.Session schema**

```elixir
# lib/grappa/accounts/session.ex
alias Grappa.Accounts.User
alias Grappa.Visitors.Visitor

@type t :: %__MODULE__{
        id: Ecto.UUID.t() | nil,
        user_id: Ecto.UUID.t() | nil,
        user: User.t() | Ecto.Association.NotLoaded.t() | nil,
        visitor_id: Ecto.UUID.t() | nil,
        visitor: Visitor.t() | Ecto.Association.NotLoaded.t() | nil,
        created_at: DateTime.t() | nil,
        last_seen_at: DateTime.t() | nil,
        revoked_at: DateTime.t() | nil,
        user_agent: String.t() | nil,
        ip: String.t() | nil
      }

@primary_key {:id, :binary_id, autogenerate: true}
schema "sessions" do
  belongs_to :user, User, type: :binary_id
  belongs_to :visitor, Visitor, type: :binary_id

  field :created_at, :utc_datetime_usec
  field :last_seen_at, :utc_datetime_usec
  field :revoked_at, :utc_datetime_usec
  field :user_agent, :string
  field :ip, :string
end

@cast_fields [:user_id, :visitor_id, :created_at, :last_seen_at, :ip, :user_agent]
@required_fields [:created_at, :last_seen_at]

@spec changeset(t(), map()) :: Ecto.Changeset.t()
def changeset(session, attrs) do
  session
  |> cast(attrs, @cast_fields)
  |> validate_required(@required_fields)
  |> validate_subject_xor()
  |> assoc_constraint(:user)
  |> assoc_constraint(:visitor)
end

# Mirror of Grappa.Scrollback.Message.validate_subject_xor/1.
# Run BEFORE per-field validators so the XOR error surfaces first.
defp validate_subject_xor(changeset) do
  case {get_field(changeset, :user_id), get_field(changeset, :visitor_id)} do
    {nil, nil} ->
      add_error(changeset, :user_id, "must set user_id or visitor_id")

    {uid, vid} when not is_nil(uid) and not is_nil(vid) ->
      add_error(changeset, :user_id, "user_id and visitor_id are mutually exclusive")

    _ ->
      changeset
  end
end
```

The moduledoc / `assoc_constraint(:user)` rationale paragraph that
was already in the file extends to `:visitor` — same sqlite-FK-quirk
backstop story; update the moduledoc text to mention both sides.

- [ ] **Step 5.4: Update Accounts.create_session/3 contract**

Arity stays `/3` — the first argument changes from a raw `user_id`
binary to a tagged subject tuple. `validate_user_exists/1` is
generalized to `validate_subject_exists/1` that branches on whichever
side is set.

```elixir
# lib/grappa/accounts.ex
use Boundary,
  top_level?: true,
  deps: [Grappa.Repo, Grappa.Visitors],
  exports: [User, Session, Wire]

alias Grappa.Accounts.{Session, User}
alias Grappa.Repo
alias Grappa.Visitors.Visitor

@type subject :: {:user, Ecto.UUID.t()} | {:visitor, Ecto.UUID.t()}

@spec create_session(subject(), String.t() | nil, String.t() | nil) ::
        {:ok, Session.t()} | {:error, Ecto.Changeset.t()}
def create_session({:user, user_id}, ip, user_agent) when is_binary(user_id) do
  do_create_session(%{user_id: user_id, ip: ip, user_agent: user_agent})
end

def create_session({:visitor, visitor_id}, ip, user_agent) when is_binary(visitor_id) do
  do_create_session(%{visitor_id: visitor_id, ip: ip, user_agent: user_agent})
end

defp do_create_session(attrs) do
  now = DateTime.utc_now()

  %Session{}
  |> Session.changeset(Map.merge(attrs, %{created_at: now, last_seen_at: now}))
  |> validate_subject_exists()
  |> Repo.insert()
end

# Pre-flight FK existence check — sqlite-quirk backstop. Generalized
# from S29 H4's `validate_user_exists/1` to branch on whichever side
# of the subject XOR is set.
defp validate_subject_exists(changeset) do
  cond do
    user_id = Ecto.Changeset.get_change(changeset, :user_id) ->
      check_exists(changeset, User, user_id, :user)

    visitor_id = Ecto.Changeset.get_change(changeset, :visitor_id) ->
      check_exists(changeset, Visitor, visitor_id, :visitor)

    true ->
      changeset
  end
end

defp check_exists(changeset, schema, id, field) do
  query = from(row in schema, where: row.id == ^id)

  if Repo.exists?(query) do
    changeset
  else
    Ecto.Changeset.add_error(changeset, field, "does not exist")
  end
end
```

- [ ] **Step 5.5: Update Accounts.authenticate/1**

No code change. The returned `Session.t()` now exposes `visitor_id`
alongside `user_id`; downstream callers (`Plugs.Authn` in Task 11)
branch on whichever FK is set.

- [ ] **Step 5.6: Update existing callsites (5 sites + 1 fixture)**

The signature change cascades. Update each callsite to pass the
tagged subject:

- `lib/grappa_web/controllers/auth_controller.ex:46` —
  `Accounts.create_session({:user, user.id}, format_ip(conn), user_agent(conn))`.
  Temporary; Task 10 replaces this with classifier-based dispatch.
- `test/support/auth_fixtures.ex:64` (`session_fixture/1`) —
  `Accounts.create_session({:user, user.id}, nil, nil)`.
- `test/grappa/accounts/sessions_test.exs` — 5 sites at lines 23,
  41, 56, 65, 129. Each becomes `{:user, user.id}` (or
  `{:user, stale_uuid}` at line 56 for the FK-miss test).
- `test/grappa_web/plugs/authn_test.exs:22` —
  `Accounts.create_session({:user, user.id}, "127.0.0.1", "test-ua")`.

- [ ] **Step 5.7: Add visitor session test cases**

Append to `test/grappa/accounts/sessions_test.exs` — same file,
new `describe` blocks. Use `Grappa.AuthFixtures.visitor_fixture/0`
(already exists; created by Task 4):

```elixir
import Grappa.AuthFixtures, only: [visitor_fixture: 0]

describe "create_session/3 with visitor subject" do
  test "creates session bound to visitor (no user_id)" do
    visitor = visitor_fixture()

    assert {:ok, %Session{} = s} =
             Accounts.create_session({:visitor, visitor.id}, "1.2.3.4", "ua")

    assert s.visitor_id == visitor.id
    assert is_nil(s.user_id)
    assert s.ip == "1.2.3.4"
    assert s.user_agent == "ua"
  end

  test "returns {:error, %Ecto.Changeset{}} for a stale visitor_id (FK miss)" do
    stale_uuid = Ecto.UUID.generate()

    assert {:error, %Ecto.Changeset{} = cs} =
             Accounts.create_session({:visitor, stale_uuid}, nil, nil)

    refute cs.valid?
    assert {"does not exist", _} = cs.errors[:visitor]
  end
end

describe "Session.changeset/2 XOR enforcement" do
  test "rejects neither user_id nor visitor_id set" do
    now = DateTime.utc_now()

    cs =
      Session.changeset(%Session{}, %{
        created_at: now,
        last_seen_at: now
      })

    refute cs.valid?
    assert "must set user_id or visitor_id" in errors_on(cs).user_id
  end

  test "rejects both user_id and visitor_id set", %{user: user} do
    visitor = visitor_fixture()
    now = DateTime.utc_now()

    cs =
      Session.changeset(%Session{}, %{
        user_id: user.id,
        visitor_id: visitor.id,
        created_at: now,
        last_seen_at: now
      })

    refute cs.valid?
    assert "user_id and visitor_id are mutually exclusive" in errors_on(cs).user_id
  end
end

describe "authenticate/1 visitor-bound sessions" do
  test "returns visitor-bound session with visitor_id, no user_id" do
    visitor = visitor_fixture()
    {:ok, session} = Accounts.create_session({:visitor, visitor.id}, nil, nil)

    assert {:ok, %Session{visitor_id: vid, user_id: nil}} =
             Accounts.authenticate(session.id)

    assert vid == visitor.id
  end
end
```

The existing user-bound `authenticate/1` tests already cover the
positive user case; no need to duplicate.

- [ ] **Step 5.8: Run full check.sh**

```bash
scripts/check.sh
```

Expected: green modulo the known sqlite-busy ~20% flake. If any
failure is NEW (not user-row-busy), HALT.

- [ ] **Step 5.9: Commit**

```bash
git add priv/repo/migrations/*_add_visitor_id_to_sessions.exs \
        lib/grappa/accounts/session.ex \
        lib/grappa/accounts.ex \
        lib/grappa_web/controllers/auth_controller.ex \
        test/support/auth_fixtures.ex \
        test/grappa/accounts/sessions_test.exs \
        test/grappa_web/plugs/authn_test.exs
git commit -m "$(cat <<'EOF'
feat(accounts): sessions table accepts visitor subject (XOR with user)

Additive nullable visitor_id FK + sqlite CHECK constraint
((user_id IS NULL) <> (visitor_id IS NULL)). create_session/3 now
takes a subject :: {:user, id} | {:visitor, id} tuple — single auth
scheme per cluster decision Q-A/C, single token namespace.
authenticate/1 returns the Session struct with whichever FK is set;
Plugs.Authn (Task 11) will branch.

Migration uses the sqlite rename+recreate+copy pattern (Task 4
precedent) since ecto_sqlite3 supports neither `modify` nor
`create constraint`. validate_subject_exists/1 generalizes the S29
H4 sqlite-FK pre-flight to either subject side.

AuthController updated to pass {:user, id} explicitly; full visitor
dispatch lands in Task 10. Test fixtures + 5 existing test sites +
authn_test.exs follow the same shape change.
EOF
)"
```

---

## Phase 2 — Visitors context (CRUD)

### Task 6: Visitors context core CRUD

**Files:**
- Create: `lib/grappa/visitors.ex`
- Test: `test/grappa/visitors_test.exs`

- [ ] **Step 6.1: Failing tests**

```elixir
# test/grappa/visitors_test.exs
defmodule Grappa.VisitorsTest do
  use Grappa.DataCase, async: true

  import Ecto.Query

  alias Grappa.Accounts
  alias Grappa.Accounts.Session
  alias Grappa.Visitors
  alias Grappa.Visitors.Visitor

  @network "azzurra"
  @ttl_anon 48 * 3600
  @ttl_registered 7 * 24 * 3600

  describe "find_or_provision_anon/3" do
    test "creates new anon visitor with 48h expires_at" do
      assert {:ok, %Visitor{} = v} = Visitors.find_or_provision_anon("vjt", @network, "1.2.3.4")
      assert v.nick == "vjt"
      assert v.network_slug == @network
      assert is_nil(v.password_encrypted)
      assert DateTime.diff(v.expires_at, DateTime.utc_now()) in (@ttl_anon - 5)..(@ttl_anon + 5)
    end

    test "returns existing visitor if (nick, network) match" do
      {:ok, v1} = Visitors.find_or_provision_anon("vjt", @network, "1.2.3.4")
      {:ok, v2} = Visitors.find_or_provision_anon("vjt", @network, "5.6.7.8")
      assert v1.id == v2.id
    end
  end

  describe "commit_password/2" do
    test "atomically writes password + bumps expires_at to 7d" do
      {:ok, v} = Visitors.find_or_provision_anon("vjt", @network, "1.2.3.4")
      before = v.expires_at

      assert {:ok, committed} = Visitors.commit_password(v.id, "s3cret")
      assert is_binary(committed.password_encrypted)
      assert committed.password_encrypted != "s3cret" # encrypted at rest
      assert DateTime.compare(committed.expires_at, before) == :gt
      assert DateTime.diff(committed.expires_at, DateTime.utc_now()) in (@ttl_registered - 5)..(@ttl_registered + 5)
    end
  end

  describe "touch/1" do
    test "bumps expires_at if ≥1h since last bump" do
      {:ok, v} = Visitors.find_or_provision_anon("vjt", @network, "1.2.3.4")
      old_expires = v.expires_at

      # Force expires_at backward
      one_hour_ago = DateTime.utc_now() |> DateTime.add(@ttl_anon - 3601, :second)
      Repo.update_all(from(x in Visitor, where: x.id == ^v.id), set: [expires_at: one_hour_ago])

      assert {:ok, touched} = Visitors.touch(v.id)
      assert DateTime.compare(touched.expires_at, one_hour_ago) == :gt
    end

    test "no-op if <1h since last bump" do
      {:ok, v} = Visitors.find_or_provision_anon("vjt", @network, "1.2.3.4")
      old_expires = v.expires_at

      assert {:ok, touched} = Visitors.touch(v.id)
      assert DateTime.compare(touched.expires_at, old_expires) == :eq
    end
  end

  describe "count_active_for_ip/1" do
    test "counts visitors with expires_at > now() per IP" do
      {:ok, _} = Visitors.find_or_provision_anon("a", @network, "1.2.3.4")
      {:ok, _} = Visitors.find_or_provision_anon("b", @network, "1.2.3.4")
      {:ok, _} = Visitors.find_or_provision_anon("c", @network, "9.9.9.9")

      assert Visitors.count_active_for_ip("1.2.3.4") == 2
      assert Visitors.count_active_for_ip("9.9.9.9") == 1
    end
  end

  describe "list_active/0" do
    test "returns only non-expired visitors" do
      {:ok, alive} = Visitors.find_or_provision_anon("alive", @network, "1.2.3.4")
      {:ok, dead} = Visitors.find_or_provision_anon("dead", @network, "1.2.3.4")
      Repo.update_all(from(x in Visitor, where: x.id == ^dead.id),
                      set: [expires_at: DateTime.utc_now() |> DateTime.add(-1, :hour)])

      ids = Visitors.list_active() |> Enum.map(& &1.id)
      assert alive.id in ids
      refute dead.id in ids
    end
  end

  describe "list_expired/0" do
    test "returns only expired visitors" do
      {:ok, alive} = Visitors.find_or_provision_anon("alive", @network, "1.2.3.4")
      {:ok, dead} = Visitors.find_or_provision_anon("dead", @network, "1.2.3.4")
      Repo.update_all(from(x in Visitor, where: x.id == ^dead.id),
                      set: [expires_at: DateTime.utc_now() |> DateTime.add(-1, :hour)])

      ids = Visitors.list_expired() |> Enum.map(& &1.id)
      refute alive.id in ids
      assert dead.id in ids
    end
  end

  describe "delete/1" do
    test "removes visitor row + CASCADE wipes accounts_sessions + visitor_channels + messages" do
      {:ok, v} = Visitors.find_or_provision_anon("vjt", @network, "1.2.3.4")
      {:ok, session} = Accounts.create_session({:visitor, v.id}, "1.2.3.4", "ua")

      assert :ok = Visitors.delete(v.id)
      assert is_nil(Repo.get(Visitor, v.id))
      assert is_nil(Repo.get(Session, session.id))
    end
  end
end
```

- [ ] **Step 6.2: Run tests, expect fail (Visitors module doesn't exist)**

```bash
scripts/test.sh test/grappa/visitors_test.exs
```

- [ ] **Step 6.3: Implement Visitors context**

`Grappa.Visitors` already exists as a stub created in Task 2 (it
hosts the Boundary annotation that the `Grappa.Visitors.Visitor`
schema's cross-call to `Grappa.IRC.Identifier` requires). Task 6
**expands** the stub — replace the moduledoc + deps + add the
function bodies. Resulting shape:

```elixir
# lib/grappa/visitors.ex (expanded from Task 2 stub)
defmodule Grappa.Visitors do
  @moduledoc """
  Self-service visitor identity context — collapsed M2 (NickServ-as-IDP)
  + M3a (anon) per cluster/visitor-auth.

  Public surface:

    * `find_or_provision_anon/3` — entry point at `POST /auth/login`
      no-`@` branch. Idempotent — returns existing row if (nick, network)
      already exists; creates fresh anon row otherwise.
    * `commit_password/2` — atomic password+nick write triggered ONLY by
      +r MODE observation in Session.Server. Bumps expires_at to now+7d.
    * `touch/1` — sliding-TTL bump on user-initiated REST/WS verbs,
      ≥1h cadence. No-op if <1h since last bump.
    * `count_active_for_ip/1` — per-IP cap enforcement (W3).
    * `list_active/0` — Bootstrap respawn enumeration.
    * `list_expired/0` — Reaper sweep enumeration.
    * `delete/1` — Reaper + operator path. CASCADE wipes session rows,
      visitor_channels, messages.

  Boundary deps: `Grappa.IRC` (Identifier validators on the child
  schema) + `Grappa.Repo` (CRUD). `Grappa.Accounts` is NOT a dep —
  CASCADE wipes session rows at the DB level (FK ON DELETE CASCADE
  per Task 5 migration), no application-layer call needed.
  `Grappa.Networks` is NOT a dep — slug existence checks at boot
  live in `Grappa.Bootstrap`, not in this context.
  """

  use Boundary,
    top_level?: true,
    deps: [Grappa.IRC, Grappa.Repo],
    exports: [Visitor, VisitorChannel]

  import Ecto.Query

  alias Grappa.Repo
  alias Grappa.Visitors.Visitor

  @anon_ttl_seconds 48 * 3600
  @registered_ttl_seconds 7 * 24 * 3600
  @touch_cadence_seconds 3600

  @spec find_or_provision_anon(String.t(), String.t(), String.t() | nil) ::
          {:ok, Visitor.t()} | {:error, Ecto.Changeset.t()}
  def find_or_provision_anon(nick, network_slug, ip)
      when is_binary(nick) and is_binary(network_slug) do
    case Repo.get_by(Visitor, nick: nick, network_slug: network_slug) do
      %Visitor{} = existing -> {:ok, existing}
      nil -> create_anon(nick, network_slug, ip)
    end
  end

  defp create_anon(nick, network_slug, ip) do
    expires_at = DateTime.utc_now() |> DateTime.add(@anon_ttl_seconds, :second) |> DateTime.truncate(:second)

    %{nick: nick, network_slug: network_slug, expires_at: expires_at, ip: ip}
    |> Visitor.create_changeset()
    |> Repo.insert()
  end

  @spec commit_password(Ecto.UUID.t(), String.t()) ::
          {:ok, Visitor.t()} | {:error, :not_found | Ecto.Changeset.t()}
  def commit_password(visitor_id, password)
      when is_binary(visitor_id) and is_binary(password) and password != "" do
    expires_at = DateTime.utc_now() |> DateTime.add(@registered_ttl_seconds, :second) |> DateTime.truncate(:second)

    case Repo.get(Visitor, visitor_id) do
      nil -> {:error, :not_found}
      visitor ->
        visitor
        |> Visitor.commit_password_changeset(password, expires_at)
        |> Repo.update()
    end
  end

  @spec touch(Ecto.UUID.t()) ::
          {:ok, Visitor.t()} | {:error, :not_found | Ecto.Changeset.t()}
  def touch(visitor_id) when is_binary(visitor_id) do
    case Repo.get(Visitor, visitor_id) do
      nil -> {:error, :not_found}
      visitor -> maybe_bump(visitor)
    end
  end

  defp maybe_bump(%Visitor{password_encrypted: pwd} = visitor) do
    now = DateTime.utc_now()
    extension = if is_nil(pwd), do: @anon_ttl_seconds, else: @registered_ttl_seconds
    target_expires_at = now |> DateTime.add(extension, :second) |> DateTime.truncate(:second)

    delta_to_target = DateTime.diff(target_expires_at, visitor.expires_at, :second)

    if delta_to_target >= @touch_cadence_seconds do
      visitor
      |> Visitor.touch_changeset(target_expires_at)
      |> Repo.update()
    else
      {:ok, visitor}
    end
  end

  @spec count_active_for_ip(String.t()) :: non_neg_integer()
  def count_active_for_ip(ip) when is_binary(ip) do
    now = DateTime.utc_now()
    Repo.aggregate(from(v in Visitor, where: v.ip == ^ip and v.expires_at > ^now), :count, :id)
  end

  @spec list_active() :: [Visitor.t()]
  def list_active do
    now = DateTime.utc_now()
    Repo.all(from v in Visitor, where: v.expires_at > ^now)
  end

  @spec list_expired() :: [Visitor.t()]
  def list_expired do
    now = DateTime.utc_now()
    Repo.all(from v in Visitor, where: v.expires_at <= ^now)
  end

  @spec delete(Ecto.UUID.t()) :: :ok | {:error, :not_found}
  def delete(visitor_id) when is_binary(visitor_id) do
    case Repo.get(Visitor, visitor_id) do
      nil -> {:error, :not_found}
      visitor -> {:ok, _} = Repo.delete(visitor); :ok
    end
  end

  @spec get!(Ecto.UUID.t()) :: Visitor.t()
  def get!(visitor_id) when is_binary(visitor_id), do: Repo.get!(Visitor, visitor_id)
end
```

- [ ] **Step 6.4: Run tests**

```bash
scripts/test.sh test/grappa/visitors_test.exs
```

Expected: all green. Fix any factory/import issues as they arise.

- [ ] **Step 6.5: Run check.sh**

```bash
scripts/check.sh
```

Expected: green. Boundary deps may need adjustment based on import detection.

- [ ] **Step 6.6: Commit**

```bash
git add lib/grappa/visitors.ex test/grappa/visitors_test.exs
git commit -m "$(cat <<'EOF'
feat(visitors): add Visitors context with CRUD + sliding TTL

Public surface: find_or_provision_anon, commit_password (atomic
password+expires_at write on +r observation), touch (≥1h cadence
sliding refresh), count_active_for_ip (per-IP cap enforcement),
list_active/list_expired (Bootstrap + Reaper enumeration), delete
(CASCADE-driven cleanup).

Anon TTL 48h, registered TTL 7d. touch/1 is the sole sliding-refresh
verb per W9 — called from Plugs.Authn on user-initiated REST/WS only.
EOF
)"
```

---

### Task 6.5: Session subject-tuple refactor (prereq for Task 7)

**Why this exists:** Task 7's plan body assumed `Session.start_opts/0`
already carried a `subject:` tagged tuple. It does not — the existing
shape is keyed on `user_id` (UUID) + `user_name` (PubSub topic root +
Logger metadata). Q-A's downstream consequence: visitors and users
share the `sessions` table (XOR FK) AND the SessionRegistry AND the
PubSub topology, so the Session boundary needs subject-aware
identifiers BEFORE either visitor SessionPlan (Task 7) or visitor
Session.Server wiring (Task 8) can land.

This is a pure mechanical rename + signature-shape change. Zero new
behavior. Existing test suite green after the refactor = done.

**Files:**

| File | Why |
|---|---|
| `lib/grappa/session.ex` | facade signatures + `start_opts` type |
| `lib/grappa/session/server.ex` | `state` + `via` + `init_opts` shape |
| `lib/grappa/networks/session_plan.ex` | emit subject in `build_plan` |
| `lib/grappa/networks/credentials.ex` | `stop_session` call site |
| `lib/grappa/bootstrap.ex` | `start_session` call site |
| `lib/grappa_web/controllers/channels_controller.ex` | derive subject from `current_user` |
| `lib/grappa_web/controllers/nick_controller.ex` | same |
| `lib/grappa_web/controllers/messages_controller.ex` (or wherever PRIVMSG lives) | same |
| `test/support/auth_fixtures.ex` | `start_session_for/2` produces subject |
| `test/grappa/bootstrap_test.exs` | `whereis` calls |
| `test/grappa/session/server_test.exs` | `whereis` / `stop_session` calls |
| `test/grappa_web/controllers/*` | as needed |

~14-16 files. Mechanical translation. NO new visitor logic.

**Shape decisions (from S3 design discussion):**

- **`subject` type**: `{:user, Ecto.UUID.t()} | {:visitor, Ecto.UUID.t()}`.
  Defined on `Grappa.Session` as the canonical type — the Session
  boundary owns "who can spawn an IRC session" semantically.
- **`subject_label` derivation** (W-decision Q1=a):
    - `{:user, _}` → pass `user.name` verbatim from the User row.
    - `{:visitor, vid}` → `"visitor:" <> vid` (UUID stable, never
      drifts on NickServ rename, can't collide with a real user.name
      since `:` is invalid in user names per `Accounts.User`'s slug
      validator).
- **`sasl_user` for visitors** (W-decision Q2=c): pass `visitor.nick`.
  Field stays required-but-non-nullable. SASL never fires for
  visitors (their `auth_method` is `:none | :nickserv_identify`),
  but keeping the field populated avoids changing the type from
  required to optional and matches the convention "sasl_user is the
  SASL identity, even if SASL isn't selected by `auth_method`".
- **`Session.start_opts/0` type changes:**
    - REMOVE `user_name: String.t()`
    - ADD `subject: subject()`
    - ADD `subject_label: String.t()`
    - Other fields unchanged
- **Public facade signature changes** (first param tagged tuple
  instead of bare UUID):
    - `start_session(subject, network_id, opts)` — was `(user_id, …)`
    - `whereis(subject, network_id)` — same
    - `stop_session(subject, network_id)` — same
    - `send_privmsg(subject, network_id, target, body)` — same
    - `send_join(subject, network_id, channel)` — same
    - `send_part(subject, network_id, channel)` — same
    - `send_topic(subject, network_id, channel, body)` — same
    - `send_nick(subject, network_id, new_nick)` — same
    - `list_channels(subject, network_id)` — same
    - `list_members(subject, network_id, channel)` — same
- **`Server.registry_key/2`** returns `{:session, subject, network_id}`.
  Subject tuple as discriminator means user-side and visitor-side
  sessions share one registry without key collision (different first
  element of the tuple guarantees uniqueness even if `network_id` and
  the two UUIDs happen to coincide in some adversarial test).
- **`Session.Server.state` changes:**
    - REMOVE `user_id: UUID`
    - ADD `subject: subject()`
    - RENAME `user_name` → `subject_label`
- **`Session.Server.init_opts` type** mirrors `start_opts/0` plus
  `network_id` (already merged by `start_session/3` — `subject` is
  ALREADY in `start_opts`, so `init_opts` no longer needs to merge
  any subject identifier in. Simplify `start_session/3` to
  `Map.merge(opts, %{network_id: network_id})` — the `subject` field
  comes pre-set in `opts`, the second positional param is just the
  network FK.

  Actually re-think: `start_session(subject, network_id, opts)` —
  the `subject` positional is redundant with `opts.subject`. Two
  options:
    - (i) Drop the positional, take only `(network_id, opts)` —
      caller must put subject in opts. Cleaner, but breaks the
      symmetry with all the `whereis(subject, network_id)` /
      `send_*(subject, network_id, ...)` callers that don't have
      an opts map.
    - (ii) Keep `(subject, network_id, opts)` and validate
      `opts.subject == subject` in a `match?/2` guard. Defensive,
      catches caller bugs at the boundary.

  Pick (ii) — symmetry with the rest of the facade beats one-time
  positional cleanliness, and the `match?` is a free runtime check.
  `Networks.SessionPlan.resolve/1` produces opts WITH the subject
  embedded; `Bootstrap` extracts and passes both.

- **`Grappa.PubSub.Topic` — NO API change.**
  All `Topic.user/1` / `Topic.network/2` / `Topic.channel/3` keep
  their current signatures. The string parameter is renamed from
  `user_name` to `subject_label` in the moduledoc + arg names but
  the value is opaque — for users it's `user.name`, for visitors
  it's `"visitor:" <> uuid`. `Topic.user_of/1` still returns the
  opaque label. GrappaChannel's cross-subject authz check
  (`Topic.user_of(parsed) == conn.assigns.subject_label`) stays a
  one-line predicate.

  Why this works: existing topic shape `grappa:user:<label>/...`
  doesn't care what `<label>` looks like as long as it's
  collision-free. `:` in `"visitor:<uuid>"` is fine — `:` isn't
  valid in user.name (Accounts.User's name validator rejects it),
  so a visitor topic can never collide with a user topic even if
  some adversarial test crafted a user named "visitor".

- [ ] **Step 6.5.1: Type + Server scaffolding (no callers updated yet)**

Update `lib/grappa/session.ex` `@type start_opts` to add `subject` +
`subject_label`, REMOVE `user_name`. Define `@type subject` at
top of module. Update facade `@spec`s to take `subject()` instead of
`Ecto.UUID.t()` as first positional arg.

Update `lib/grappa/session/server.ex`:
- Add `@type subject` aliased from `Grappa.Session.subject` if
  Boundary allows (else duplicate the typedef).
- Update `init_opts` type: drop `user_id`, drop `user_name`, add
  `subject`, add `subject_label`. (The `network_id` stays — that's
  the second positional.)
- Update `state` type: drop `user_id`, drop `user_name`, add
  `subject`, add `subject_label` (stored verbatim from opts; never
  re-derived since the topic root is fixed at session start).
- Update `start_link/1` `is_binary(user_id)` guard → `is_tuple(subject)`
  + `match?({:user, <<_::288>>} or {:visitor, <<_::288>>}, subject)`
  pattern (UUID is 36 chars; do this with explicit `is_binary` after
  pattern match).
- Update `registry_key(subject, network_id)` signature.
- Update `via/2` signature.
- Inside `init/1`:
    - Replace `state.user_name` reads with `state.subject_label` (5
      sites: PubSub topic builds in `handle_call({:send_privmsg, …})`,
      `handle_call({:send_topic, …})`, `EventRouter` event broadcasts;
      Logger metadata at the top of `init/1`).

Run targeted test that compiles `Grappa.Session` + `Grappa.Session.Server`
without warnings, no existing test runs yet:
```bash
scripts/mix.sh compile --warnings-as-errors
```
Expect: success.

- [ ] **Step 6.5.2: Cascade callers + tests in atomic edit pass**

In one focused edit pass (don't try to compile partway — the
intermediate states are red):

1. `lib/grappa/networks/session_plan.ex` `build_plan/4`:
   - REMOVE `user_name: user.name`
   - ADD `subject: {:user, user.id}`
   - ADD `subject_label: user.name`

2. `lib/grappa/bootstrap.ex` line 140:
   - `Session.start_session(user_id, network_id, plan)` →
     `Session.start_session({:user, user_id}, network_id, plan)`.
     The `plan` already carries the matching `subject` field from
     SessionPlan; the positional is redundant-but-validated per
     decision (ii) above.

3. `lib/grappa/networks/credentials.ex` line 147:
   - `Session.stop_session(user_id, network_id)` →
     `Session.stop_session({:user, user_id}, network_id)`.

4. Each REST controller that calls `Session.send_*` /
   `Session.list_*`: replace `current_user.id` first param with
   `{:user, current_user.id}` second-arg shape. Today
   `current_user` is the only auth subject; visitor branching lands
   in Tasks 10/11. So this is purely the rename:
   - `lib/grappa_web/controllers/channels_controller.ex`
   - `lib/grappa_web/controllers/nick_controller.ex`
   - any other `Session.send_*` call site

5. `lib/grappa_web/channels/grappa_channel.ex` (if it uses
   `Session.whereis` or similar) — same translation.

6. `test/support/auth_fixtures.ex` `start_session_for/2`:
   - Build subject as `{:user, user.id}`
   - Build subject_label as `user.name`
   - Inject into the plan map BEFORE
     `Grappa.Session.start_session/3`
   - Pass `{:user, user.id}` as first positional

7. `test/grappa/session/server_test.exs`:
   - `Session.whereis(user.id, …)` → `Session.whereis({:user, user.id}, …)`
   - `Session.stop_session(user.id, …)` → `Session.stop_session({:user, user.id}, …)`
   - `Session.whereis(Ecto.UUID.generate(), …)` → `Session.whereis({:user, Ecto.UUID.generate()}, …)`
   - All ~10 sites

8. `test/grappa/bootstrap_test.exs`:
   - All `Session.whereis(user_id, network_id)` → `Session.whereis({:user, user_id}, network_id)`
   - All ~6 sites

9. `test/grappa_web/controllers/channels_controller_test.exs`,
   `test/grappa_web/controllers/nick_controller_test.exs`,
   `test/grappa_web/controllers/messages_controller_test.exs` (if any
   touches `Session.whereis` directly) — same translation.

10. Run full test:
    ```bash
    scripts/test.sh
    ```
    Expect: GREEN. Same suite, same behavior, just new signatures.

- [ ] **Step 6.5.3: Add one new test for subject-tuple isolation**

In `test/grappa/session/server_test.exs`, add:

```elixir
test "two sessions for the same network_id but different subject kinds coexist" do
  user = user_fixture()
  network = network_with_server(slug: "test-net")

  user_pid = start_session_for(user, network)

  # Spawn a synthetic visitor session by hand-crafting opts (since
  # Visitors.SessionPlan lands in Task 7). Production callers will
  # use the resolver — this test is just isolating the registry-key
  # behavior at the Session boundary level.
  visitor_id = Ecto.UUID.generate()
  visitor_subject = {:visitor, visitor_id}

  visitor_plan = %{
    subject: visitor_subject,
    subject_label: "visitor:" <> visitor_id,
    network_slug: network.slug,
    nick: "vsh",
    realname: "Grappa Visitor",
    sasl_user: "vsh",
    auth_method: :none,
    password: nil,
    autojoin_channels: [],
    host: "127.0.0.1",
    port: 6667,
    tls: false
  }

  # No real upstream — Session.Server's IRC.Client will fail to
  # connect, but that's fine for this test: we just need both
  # registry entries to coexist briefly. Trap exits to avoid
  # killing the test process.
  Process.flag(:trap_exit, true)
  {:ok, visitor_pid} = Grappa.Session.start_session(visitor_subject, network.id, visitor_plan)

  assert Grappa.Session.whereis({:user, user.id}, network.id) == user_pid
  assert Grappa.Session.whereis(visitor_subject, network.id) == visitor_pid
  assert user_pid != visitor_pid

  Grappa.Session.stop_session(visitor_subject, network.id)
end
```

Run + see green:
```bash
scripts/test.sh test/grappa/session/server_test.exs
```

- [ ] **Step 6.5.4: Type-check + format + credo + commit**

```bash
scripts/format.sh
scripts/credo.sh --strict
scripts/dialyzer.sh
scripts/check.sh
```

Expect: all green (modulo known sqlite-busy flake on Users INSERTs
~20% rate per CP11 S2/S3 notes). Re-run flake-failed test once.

- [ ] **Step 6.5.5: Commit on cluster branch**

```bash
cd ~/code/IRC/grappa-task-visitor-auth
git add lib/grappa/session.ex lib/grappa/session/server.ex \
        lib/grappa/networks/session_plan.ex \
        lib/grappa/networks/credentials.ex \
        lib/grappa/bootstrap.ex \
        lib/grappa_web/controllers/ \
        lib/grappa_web/channels/ \
        test/support/auth_fixtures.ex \
        test/grappa/session/server_test.exs \
        test/grappa/bootstrap_test.exs \
        test/grappa_web/
git commit -m "$(cat <<'EOF'
refactor(session): subject-tuple identifier (user|visitor)

Prereq for visitor-auth cluster Tasks 7+8. Replaces the bare
user_id (UUID) keying scheme on Grappa.Session with a tagged-tuple
subject — {:user, uuid} | {:visitor, uuid}. SessionRegistry,
Session.Server.state, all facade signatures (start_session/3,
whereis/2, stop_session/2, send_*/N, list_*/N), and
Networks.SessionPlan all updated to thread the subject. PubSub
topic root is generalized via subject_label (user.name for users,
"visitor:<uuid>" for visitors); Topic module API unchanged.

Pure mechanical rename, zero new behavior. Q-A's downstream
consequence — visitors and users share the sessions table (XOR
FK), SessionRegistry, and PubSub topology, so subject-aware
identifiers must exist before visitor-side SessionPlan (Task 7)
or visitor-side Server wiring (Task 8) can land.

Decisions captured in plan §Task 6.5:
- subject_label for visitors: "visitor:" <> visitor.id (Q1=a)
- sasl_user for visitors: visitor.nick (Q2=c)
EOF
)"
```

Done. Task 7's plan body now references real types. Resume Task 7
implementation.

---

### Task 7: Visitors.SessionPlan (mirror of Networks.SessionPlan for visitor input)

**Prereq landed:** Task 6.5 — `Grappa.Session.subject` type +
`subject_label` field exist on `start_opts`. Visitors.SessionPlan
emits both verbatim. `Networks.SessionPlan` is the canonical sibling
to mirror; rescue-on-NoServerError pattern is reused.

**Files:**
- Create: `lib/grappa/visitors/session_plan.ex`
- Test: `test/grappa/visitors/session_plan_test.exs`
- Modify: `lib/grappa/visitors.ex` — Boundary `deps` adds
  `Grappa.Networks`, `exports` adds `SessionPlan`.

- [ ] **Step 7.1: Failing tests**

```elixir
# test/grappa/visitors/session_plan_test.exs
defmodule Grappa.Visitors.SessionPlanTest do
  # async: false — visitor INSERTs + network INSERTs + sqlite
  # contention behavior under full-suite parallelism observed in
  # CP11 S3 (visitors_test.exs same mitigation). Per-test cost
  # negligible (~300ms total).
  use Grappa.DataCase, async: false

  import Grappa.AuthFixtures

  alias Grappa.Visitors
  alias Grappa.Visitors.SessionPlan

  describe "resolve/1" do
    test "anon visitor → opts with auth_method=:none + visitor subject" do
      _network = network_with_server(slug: "azzurra")
      {:ok, visitor} = Visitors.find_or_provision_anon("vjt", "azzurra", "1.2.3.4")

      assert {:ok, opts} = SessionPlan.resolve(visitor)
      assert opts.subject == {:visitor, visitor.id}
      assert opts.subject_label == "visitor:" <> visitor.id
      assert opts.nick == "vjt"
      assert opts.realname == "Grappa Visitor"
      assert opts.sasl_user == "vjt"
      assert opts.auth_method == :none
      assert is_nil(opts.password)
      assert opts.network_slug == "azzurra"
      assert opts.autojoin_channels == []
    end

    test "registered visitor → opts with auth_method=:nickserv_identify + plaintext password" do
      _network = network_with_server(slug: "azzurra")
      {:ok, visitor} = Visitors.find_or_provision_anon("vjt", "azzurra", "1.2.3.4")
      {:ok, registered} = Visitors.commit_password(visitor.id, "s3cret")

      assert {:ok, opts} = SessionPlan.resolve(registered)
      assert opts.nick == "vjt"
      assert opts.auth_method == :nickserv_identify
      # Cloak EncryptedBinary roundtrip is symmetric — in-memory value
      # after Repo.update is plaintext (the cipher only applies to the
      # bytes on disk in the column). Encryption-at-rest verified via
      # the EncryptedBinary property test, not here.
      assert opts.password == "s3cret"
    end

    test "no enabled server → {:error, :no_server}" do
      _network = network_fixture(slug: "azzurra")
      {:ok, visitor} = Visitors.find_or_provision_anon("vjt", "azzurra", "1.2.3.4")

      assert {:error, :no_server} = SessionPlan.resolve(visitor)
    end

    test "network slug not configured → {:error, :network_unconfigured}" do
      {:ok, visitor} = Visitors.find_or_provision_anon("vjt", "ghosted", "1.2.3.4")

      assert {:error, :network_unconfigured} = SessionPlan.resolve(visitor)
    end
  end
end
```

- [ ] **Step 7.2: Implement**

Two amendments vs S2 plan body:

1. **No `use Boundary` line.** `Grappa.Visitors.SessionPlan` is INSIDE
   the `Grappa.Visitors` boundary (mirror of `Grappa.Networks.SessionPlan`
   inside `Grappa.Networks` — sibling has no own boundary either).
   Visitors umbrella's boundary `deps` grows by `Grappa.Networks` +
   `exports` grows by `SessionPlan` instead.

2. **No `decrypt_password/1` defp.** Both clauses just return the
   field. Cloak's `EncryptedBinary` returns plaintext on Repo load —
   the field IS the decrypted value. Inline as `visitor.password_encrypted`
   in the resolve body.

```elixir
# lib/grappa/visitors/session_plan.ex
defmodule Grappa.Visitors.SessionPlan do
  @moduledoc """
  Mirror of `Grappa.Networks.SessionPlan` for visitor-row input.
  Resolves a `%Visitor{}` + the matching network's lowest-priority
  enabled server into the primitive `Grappa.Session.start_opts/0`
  map for `Grappa.Session.start_session/3`.

  Visitor-specific shape:

    * `subject = {:visitor, visitor.id}`
    * `subject_label = "visitor:" <> visitor.id` (Q1=a — UUID stable
      across NickServ rename, no collision with user.name since `:`
      is invalid in user names)
    * `sasl_user = visitor.nick` (Q2=c — populated even though SASL
      never fires for visitors)
    * `auth_method = :none` if `password_encrypted` is nil (anon)
    * `auth_method = :nickserv_identify` + plaintext password from
      EncryptedBinary roundtrip if registered

  Used by `Grappa.Bootstrap` (visitor respawn at boot) and
  `Grappa.Visitors.Login` (synchronous login probe-connect, Task 9).
  """

  import Ecto.Query

  alias Grappa.Networks
  alias Grappa.Networks.NoServerError
  alias Grappa.Networks.Servers
  alias Grappa.Repo
  alias Grappa.Session
  alias Grappa.Visitors.{Visitor, VisitorChannel}

  @spec resolve(Visitor.t()) ::
          {:ok, Session.start_opts()} | {:error, :network_unconfigured | :no_server}
  def resolve(%Visitor{} = visitor) do
    with {:ok, network} <- fetch_network(visitor.network_slug) do
      network = Repo.preload(network, :servers)

      try do
        server = Servers.pick_server!(network)
        {:ok, build_plan(visitor, network, server)}
      rescue
        NoServerError -> {:error, :no_server}
      end
    end
  end

  defp fetch_network(slug) do
    case Networks.get_network_by_slug(slug) do
      {:ok, network} -> {:ok, network}
      {:error, :not_found} -> {:error, :network_unconfigured}
    end
  end

  defp build_plan(%Visitor{} = visitor, network, server) do
    autojoin =
      Repo.all(
        from c in VisitorChannel,
          where: c.visitor_id == ^visitor.id and c.network_slug == ^visitor.network_slug,
          select: c.name
      )

    %{
      subject: {:visitor, visitor.id},
      subject_label: "visitor:" <> visitor.id,
      network_slug: network.slug,
      nick: visitor.nick,
      realname: "Grappa Visitor",
      sasl_user: visitor.nick,
      auth_method: auth_method(visitor),
      password: visitor.password_encrypted,
      autojoin_channels: autojoin,
      host: server.host,
      port: server.port,
      tls: server.tls
    }
  end

  defp auth_method(%Visitor{password_encrypted: nil}), do: :none
  defp auth_method(%Visitor{password_encrypted: _}), do: :nickserv_identify
end
```

Visitors umbrella update — `lib/grappa/visitors.ex`:

```elixir
use Boundary,
  top_level?: true,
  deps: [Grappa.IRC, Grappa.Networks, Grappa.Repo],
  exports: [SessionPlan, Visitor, VisitorChannel]
```

- [ ] **Step 7.3: Run tests**

```bash
scripts/test.sh test/grappa/visitors/session_plan_test.exs
```

Expect: 4 tests pass.

`Networks.get_network_by_slug/1` already exists. `Networks.Servers.pick_server!/1`
already exists (raises `NoServerError`); the rescue mirrors
`Networks.SessionPlan.resolve/1`'s pattern.

- [ ] **Step 7.4: Commit**

```bash
git add lib/grappa/visitors.ex \
        lib/grappa/visitors/session_plan.ex \
        test/grappa/visitors/session_plan_test.exs
git commit -m "$(cat <<'EOF'
feat(visitors): add SessionPlan.resolve/1 for visitor input

Mirrors Networks.SessionPlan shape — resolves visitor row + lowest-
priority enabled server of pinned network into Session.start_opts.
auth_method :none for anon, :nickserv_identify for registered.
EncryptedBinary roundtrip yields plaintext on Repo load, no separate
decrypt step. NoServerError rescued at the boundary, mirror of
Networks.SessionPlan precedent.

Used by Bootstrap visitor-respawn (Task 19) + Visitors.Login
synchronous probe-connect (Task 9).
EOF
)"
```

---

## Phase 3 — Synchronous login + dispatch

### Task 8: Session.Server — synchronous login readiness signal

**Files:**
- Modify: `lib/grappa/session/server.ex`
- Test: extend `test/grappa/session/server_test.exs`

The login flow needs a way to await `001 RPL_WELCOME` synchronously. Add a `notify_pid` start_opt — when set, Session.Server sends `{:session_ready, ref}` on first 001 from upstream.

- [ ] **Step 8.1: Failing test**

```elixir
# test/grappa/session/server_test.exs — add describe
describe "notify_pid wakes caller on 001 RPL_WELCOME" do
  test "caller receives :session_ready when 001 arrives" do
    # Use IRCServer test helper
    {:ok, fake_server} = IRCServer.start_link()
    IRCServer.expect_register(fake_server)

    parent = self()
    ref = make_ref()

    {:ok, _pid} = Session.start_session(insert(:user).id, insert(:network).id,
      Map.merge(plan_opts_for(fake_server), %{notify_pid: parent, notify_ref: ref}))

    IRCServer.send_001(fake_server)

    assert_receive {:session_ready, ^ref}, 5_000
  end
end
```

- [ ] **Step 8.2: Add notify state field + 001 hook**

```elixir
# lib/grappa/session/server.ex — extend state struct
defmodule State do
  @type t :: %__MODULE__{
    # ... existing fields
    notify_pid: pid() | nil,
    notify_ref: reference() | nil,
    # ... existing
  }
end

# In init/1, accept the new opts
def init(%{notify_pid: nil, notify_ref: nil} = opts), do: # passthrough
def init(%{notify_pid: pid, notify_ref: ref} = opts) when is_pid(pid) and is_reference(ref) do
  # ... existing init logic
  {:ok, %State{state | notify_pid: pid, notify_ref: ref}, {:continue, {:start_client, client_opts}}}
end

# In handle_info for 001:
def handle_info({:irc, %Message{command: :"001", _rest_}}, %State{notify_pid: pid, notify_ref: ref} = state)
    when is_pid(pid) do
  send(pid, {:session_ready, ref})
  {:noreply, %State{state | notify_pid: nil, notify_ref: nil}}  # one-shot
end
```

(Requires existing IRC parser to surface `:001` command. Verify in `Grappa.IRC.Parser`. If not surfaced today, add the numeric → `:welcome` mapping.)

- [ ] **Step 8.3: Run tests**

```bash
scripts/test.sh test/grappa/session/server_test.exs
```

- [ ] **Step 8.4: Commit**

```bash
git add lib/grappa/session/server.ex test/grappa/session/server_test.exs
git commit -m "$(cat <<'EOF'
feat(session): add notify_pid/notify_ref opts for synchronous login wait

When set, Session.Server sends {:session_ready, ref} to caller on
first 001 RPL_WELCOME from upstream. One-shot — clears the notify
fields after firing. Used by Visitors.Login to block the synchronous
POST /auth/login until upstream registration completes (8s budget,
W5).
EOF
)"
```

---

### Task 9: Visitors.Login — synchronous probe-connect orchestrator

**Files:**
- Create: `lib/grappa/visitors/login.ex`
- Test: `test/grappa/visitors/login_test.exs`

- [ ] **Step 9.1: Failing tests**

```elixir
# test/grappa/visitors/login_test.exs
defmodule Grappa.Visitors.LoginTest do
  use Grappa.DataCase, async: false  # IRCServer is shared TCP — keep serial

  alias Grappa.Visitors

  setup do
    # IRCServer test helper provides in-process fake IRC server
    {:ok, server} = IRCServer.start_link()
    network = insert(:network, slug: "azzurra")
    insert(:network_server, network: network, host: "127.0.0.1",
                            port: IRCServer.port(server), tls: false, enabled: true)

    Application.put_env(:grappa, :visitor_network, "azzurra")
    on_exit(fn -> Application.delete_env(:grappa, :visitor_network) end)

    {:ok, server: server, network: network}
  end

  describe "login/4 happy path" do
    test "anon login spawns session, awaits 001, returns {:ok, visitor, token}", %{server: server} do
      IRCServer.auto_accept(server)

      assert {:ok, %{visitor: v, token: token}} = Visitors.Login.login("vjt", nil, "1.2.3.4", "ua")
      assert v.nick == "vjt"
      assert is_nil(v.password_encrypted)
      assert is_binary(token)
    end

    test "registered login (with NickServ password) spawns session and stores password as pending", %{server: server} do
      IRCServer.auto_accept(server)

      assert {:ok, %{visitor: v}} = Visitors.Login.login("vjt", "s3cret", "1.2.3.4", "ua")

      # Password is NOT yet committed — only pending in Session.Server
      assert is_nil(Repo.reload!(v).password_encrypted)
    end
  end

  describe "login/4 sad paths" do
    test "connect refused → {:error, :upstream_unreachable} (502)", %{network: network} do
      Repo.update_all(from(s in NetworkServer, where: s.network_id == ^network.id),
                      set: [port: 1])  # port 1 = refused

      assert {:error, :upstream_unreachable} = Visitors.Login.login("vjt", nil, "1.2.3.4", "ua")
    end

    test "no 001 within 8s → {:error, :timeout}", %{server: server} do
      IRCServer.accept_but_silent(server)  # accepts TCP but never sends 001

      assert {:error, :timeout} = Visitors.Login.login("vjt", nil, "1.2.3.4", "ua")
    end

    test "ip cap exceeded → {:error, :ip_cap_exceeded}" do
      Application.put_env(:grappa, :max_visitors_per_ip, 1)
      on_exit(fn -> Application.delete_env(:grappa, :max_visitors_per_ip) end)

      {:ok, _} = Visitors.find_or_provision_anon("a", "azzurra", "1.2.3.4")
      assert {:error, :ip_cap_exceeded} = Visitors.Login.login("b", nil, "1.2.3.4", "ua")
    end

    test "malformed nick → {:error, :malformed_nick}" do
      assert {:error, :malformed_nick} = Visitors.Login.login("9bad", nil, "1.2.3.4", "ua")
    end

    test "no visitor network configured → {:error, :visitor_network_unconfigured}" do
      Application.delete_env(:grappa, :visitor_network)
      assert {:error, :visitor_network_unconfigured} = Visitors.Login.login("vjt", nil, "1.2.3.4", "ua")
    end
  end
end
```

- [ ] **Step 9.2: Implement Visitors.Login**

```elixir
# lib/grappa/visitors/login.ex
defmodule Grappa.Visitors.Login do
  @moduledoc """
  Synchronous login orchestrator for visitor self-service.

  Flow:
  1. Validate nick shape (RFC2812).
  2. Check per-IP cap (W3).
  3. find_or_provision_anon — DB row for the visitor (no password yet).
  4. Resolve SessionPlan from visitor row.
  5. Spawn Session.Server with notify_pid: self() + notify_ref: ref.
  6. If `password` arg non-nil, queue an outbound `PRIVMSG NickServ
     :IDENTIFY <pwd>` AFTER 001 — Session.Server will capture it via
     NSInterceptor into `pending_auth`. Atomic commit happens only on
     +r MODE observation (not in this fn).
  7. Receive {:session_ready, ref} OR :timeout (8s).
  8. On success: Accounts.create_session({:visitor, visitor.id}, ip, ua).
  9. Return {:ok, %{visitor: v, token: session_id}} or appropriate error.

  On any failure post-spawn, terminate the spawned session.
  """

  alias Grappa.{Accounts, Session, Visitors}
  alias Grappa.Auth.IdentifierClassifier
  alias Grappa.Visitors.SessionPlan

  require Logger

  @login_timeout_ms 8_000

  @type login_result :: %{visitor: Visitors.Visitor.t(), token: Ecto.UUID.t()}
  @type login_error ::
          :malformed_nick
          | :visitor_network_unconfigured
          | :ip_cap_exceeded
          | :upstream_unreachable
          | :timeout
          | :no_server
          | :network_unconfigured

  @spec login(String.t(), String.t() | nil, String.t() | nil, String.t() | nil) ::
          {:ok, login_result()} | {:error, login_error()}
  def login(nick, password, ip, user_agent)
      when is_binary(nick) and (is_binary(password) or is_nil(password)) do
    with :ok <- validate_nick(nick),
         {:ok, network_slug} <- visitor_network(),
         :ok <- check_ip_cap(ip),
         {:ok, visitor} <- Visitors.find_or_provision_anon(nick, network_slug, ip),
         {:ok, plan} <- SessionPlan.resolve(visitor),
         {:ok, _pid} <- spawn_and_await(visitor, plan, password) do
      {:ok, session} = Accounts.create_session({:visitor, visitor.id}, ip, user_agent)
      {:ok, %{visitor: visitor, token: session.id}}
    end
  end

  defp validate_nick(nick) do
    case IdentifierClassifier.classify(nick) do
      {:nick, _} -> :ok
      _ -> {:error, :malformed_nick}
    end
  end

  defp visitor_network do
    case Application.get_env(:grappa, :visitor_network) do
      slug when is_binary(slug) -> {:ok, slug}
      _ -> {:error, :visitor_network_unconfigured}
    end
  end

  defp check_ip_cap(nil), do: :ok
  defp check_ip_cap(ip) do
    cap = Application.get_env(:grappa, :max_visitors_per_ip, 5)
    if Visitors.count_active_for_ip(ip) >= cap, do: {:error, :ip_cap_exceeded}, else: :ok
  end

  defp spawn_and_await(visitor, plan, password) do
    ref = make_ref()
    plan_with_notify = Map.merge(plan, %{notify_pid: self(), notify_ref: ref, pending_password: password})

    case Session.start_session({:visitor, visitor.id}, plan.network_id, plan_with_notify) do
      {:ok, pid} ->
        receive do
          {:session_ready, ^ref} -> {:ok, pid}
        after
          @login_timeout_ms ->
            Session.stop_session({:visitor, visitor.id}, plan.network_id)
            {:error, :timeout}
        end

      {:error, {:already_started, pid}} ->
        # Session already alive (existing visitor reattaching). Receive 001-already-seen
        # state via Session.Server reply.
        case Session.connection_status({:visitor, visitor.id}, plan.network_id) do
          :ready -> {:ok, pid}
          _ -> {:error, :upstream_unreachable}
        end

      {:error, _reason} ->
        {:error, :upstream_unreachable}
    end
  end
end
```

(Note: `Session.start_session/3` and `Session.connection_status/2` need adapting to accept the `{:visitor, id}` subject tuple — these adjustments land here.)

- [ ] **Step 9.3: Run tests**

```bash
scripts/test.sh test/grappa/visitors/login_test.exs
```

Iterate until green. The IRCServer test helper may need a few new modes (`auto_accept`, `accept_but_silent`).

- [ ] **Step 9.4: Commit**

```bash
git add lib/grappa/visitors/login.ex test/grappa/visitors/login_test.exs lib/grappa/session.ex
git commit -m "$(cat <<'EOF'
feat(visitors): add synchronous Login orchestrator with 8s budget

Validates nick → checks per-IP cap → provisions visitor row → resolves
SessionPlan → spawns Session.Server with notify_ref → blocks on
{:session_ready, ref} or 8s timeout → on success creates accounts.session
with subject {:visitor, id} and returns {:ok, %{visitor, token}}.

Connect-refused → :upstream_unreachable (502).
8s elapsed without 001 → :timeout (504), spawned session torn down.
Per-IP cap exceeded → :ip_cap_exceeded (429).
Malformed nick → :malformed_nick (400).

Pending-password (from cicchetto's NickServ password field) is passed
through plan.pending_password; Session.Server queues an outbound
IDENTIFY post-001 which NSInterceptor captures into pending_auth —
atomic commit happens only on +r MODE observation in a later task.
EOF
)"
```

---

### Task 10: AuthController dispatch by classifier

**Files:**
- Modify: `lib/grappa_web/controllers/auth_controller.ex`
- Modify: `lib/grappa_web/controllers/auth_json.ex`
- Test: extend `test/grappa_web/controllers/auth_controller_test.exs`

- [ ] **Step 10.1: Failing tests**

```elixir
# test/grappa_web/controllers/auth_controller_test.exs — add describes
describe "POST /auth/login dispatches by IdentifierClassifier" do
  setup do
    {:ok, fake_irc} = IRCServer.start_link()

    network = insert(:network, slug: "azzurra")

    insert(:network_server,
      network: network,
      host: "127.0.0.1",
      port: IRCServer.port(fake_irc),
      tls: false,
      enabled: true,
      priority: 0
    )

    # `:visitor_network` + `:max_visitors_per_ip` are read at compile time
    # (Application.compile_env) by the controller; per-test overrides go
    # through the test-only Application.put_env shim that the controller's
    # @visitor_network module attribute reads as a fallback. See
    # `lib/grappa_web/controllers/auth_controller.ex` test-config branch.
    Application.put_env(:grappa, :visitor_network, "azzurra")
    Application.put_env(:grappa, :max_visitors_per_ip, 5)

    on_exit(fn ->
      Application.delete_env(:grappa, :visitor_network)
      Application.delete_env(:grappa, :max_visitors_per_ip)
    end)

    {:ok, fake_irc: fake_irc, network: network}
  end

  test "email identifier → mode-1 path → {token, subject: {kind: :user, ...}}",
       %{conn: conn} do
    # Mode-1 today is name-keyed. The `@` discriminator routes here but
    # Accounts.get_user_by_credentials still looks up BY name (local-part).
    # Phase 5 adds a proper email column; for now the test uses a name-only
    # account whose `name` happens to match the local-part of the identifier.
    insert(:user, name: "vjt", password: "secret")

    conn =
      post(conn, ~p"/auth/login", %{"identifier" => "vjt@bad.ass", "password" => "secret"})

    body = json_response(conn, 200)
    assert is_binary(body["token"])
    assert body["subject"]["kind"] == "user"
    assert body["subject"]["name"] == "vjt"
  end

  test "nick identifier → visitor path → {token, subject: {kind: :visitor, ...}}",
       %{conn: conn, fake_irc: fake_irc} do
    IRCServer.auto_accept(fake_irc)

    conn = post(conn, ~p"/auth/login", %{"identifier" => "vjt"})

    body = json_response(conn, 200)
    assert is_binary(body["token"])
    assert body["subject"]["kind"] == "visitor"
    assert body["subject"]["nick"] == "vjt"
    assert body["subject"]["network_slug"] == "azzurra"
  end

  test "malformed identifier → 400", %{conn: conn} do
    conn = post(conn, ~p"/auth/login", %{"identifier" => "9bad nick"})
    assert json_response(conn, 400)["error"] == "bad_request"
  end

  test "ip cap exceeded → 429", %{conn: conn, fake_irc: fake_irc} do
    IRCServer.auto_accept(fake_irc)
    Application.put_env(:grappa, :max_visitors_per_ip, 1)

    {:ok, _first} = Visitors.find_or_provision_anon("first", "azzurra", "1.2.3.4")

    conn =
      %{conn | remote_ip: {1, 2, 3, 4}}
      |> post(~p"/auth/login", %{"identifier" => "second"})

    assert json_response(conn, 429)["error"] == "ip_cap_exceeded"
  end

  test "upstream unreachable → 502", %{conn: conn, network: network} do
    # Repoint the network's enabled server to a refused port (1) so connect
    # fails fast. The fake IRC server in setup is unused for this test.
    Repo.update_all(
      from(s in Grappa.Networks.Server, where: s.network_id == ^network.id),
      set: [port: 1]
    )

    conn = post(conn, ~p"/auth/login", %{"identifier" => "vjt"})

    assert json_response(conn, 502)["error"] == "upstream_unreachable"
  end

  # NOTE: 504 timeout (no 001 within budget) is exercised in
  # `test/grappa/visitors/login_test.exs` against `Visitors.Login.login/5`
  # directly with a compressed `:timeout_ms` opt — the controller-level
  # roundtrip would burn the full 8s production budget per run.
end
```

**Important:** The wire shape changes from `{name, password}` to `{identifier, password?}`. cicchetto must be updated in Task 26. Existing mode-1 callers using `{name, password}` need a transition path — recommend: support both for one release, deprecate `name`. **For this cluster: hard cutover** (cicchetto is the only mode-1 client today, updated in same cluster). Keep new shape only.

- [ ] **Step 10.2: Update controller**

```elixir
# lib/grappa_web/controllers/auth_controller.ex
defmodule GrappaWeb.AuthController do
  @moduledoc """
  REST authentication endpoints.

  POST /auth/login — `{identifier, password?}` → `{token, subject}`.
    The identifier is dispatched by `Grappa.Auth.IdentifierClassifier`:
    - `@` present → mode-1 admin path → `Accounts.get_user_by_credentials/2`
      (password REQUIRED).
    - else → visitor path → `Visitors.Login.login/4` (password OPTIONAL).
  """

  use GrappaWeb, :controller

  alias Grappa.Accounts
  alias Grappa.Auth.IdentifierClassifier
  alias Grappa.Visitors.Login, as: VisitorLogin

  require Logger

  @spec login(Plug.Conn.t(), map()) :: Plug.Conn.t()
  def login(conn, %{"identifier" => id} = params) when is_binary(id) do
    password = Map.get(params, "password")

    case IdentifierClassifier.classify(id) do
      {:email, _email} -> mode1_login(conn, id, password)
      {:nick, nick} -> visitor_login(conn, nick, password)
      {:error, :malformed} -> send_error(conn, 400, "bad_request")
    end
  end

  def login(conn, _), do: send_error(conn, 400, "bad_request")

  defp mode1_login(conn, _email, nil), do: send_error(conn, 400, "password_required")

  defp mode1_login(conn, email, password) when is_binary(password) do
    # Mode-1 today is name-keyed. Email-keyed lookup is Phase 5 hardening.
    # For now the dispatch routes by `@` presence but the actual lookup
    # uses the local-part as the user `name`. Adjust as Accounts gains
    # `get_user_by_email/1`.
    case Accounts.get_user_by_credentials(email, password) do
      {:ok, user} ->
        {:ok, session} = Accounts.create_session({:user, user.id}, format_ip(conn), user_agent(conn))
        render_login(conn, session.id, %{kind: :user, id: user.id, name: user.name})

      {:error, :invalid_credentials} ->
        send_error(conn, 401, "invalid_credentials")
    end
  end

  defp visitor_login(conn, nick, password) do
    case VisitorLogin.login(nick, password, format_ip(conn), user_agent(conn)) do
      {:ok, %{visitor: v, token: token}} ->
        render_login(conn, token, %{
          kind: :visitor,
          id: v.id,
          nick: v.nick,
          network_slug: v.network_slug
        })

      {:error, :malformed_nick} -> send_error(conn, 400, "malformed_nick")
      {:error, :ip_cap_exceeded} -> send_error(conn, 429, "ip_cap_exceeded")
      {:error, :upstream_unreachable} -> send_error(conn, 502, "upstream_unreachable")
      {:error, :timeout} -> send_error(conn, 504, "timeout")
      {:error, :visitor_network_unconfigured} -> send_error(conn, 503, "visitor_disabled")
      {:error, _other} -> send_error(conn, 500, "internal")
    end
  end

  defp render_login(conn, token, subject) do
    conn
    |> put_status(:ok)
    |> render(:login, token: token, subject: subject)
  end

  defp send_error(conn, status, code) do
    conn |> put_status(status) |> json(%{error: code})
  end

  # ... existing logout/2 unchanged ...
  # ... existing format_ip/1, user_agent/1 unchanged ...
end
```

- [ ] **Step 10.3: Update auth_json.ex**

```elixir
# lib/grappa_web/controllers/auth_json.ex
defmodule GrappaWeb.AuthJSON do
  @spec login(map()) :: map()
  def login(%{token: token, subject: subject}) do
    %{token: token, subject: subject_to_wire(subject)}
  end

  defp subject_to_wire(%{kind: :user, id: id, name: name}) do
    %{kind: "user", id: id, name: name}
  end

  defp subject_to_wire(%{kind: :visitor, id: id, nick: nick, network_slug: slug}) do
    %{kind: "visitor", id: id, nick: nick, network_slug: slug}
  end
end
```

- [ ] **Step 10.4: Run tests**

```bash
scripts/test.sh test/grappa_web/controllers/auth_controller_test.exs
```

- [ ] **Step 10.5: Commit**

```bash
git add lib/grappa_web/controllers/auth_controller.ex \
        lib/grappa_web/controllers/auth_json.ex \
        test/grappa_web/controllers/auth_controller_test.exs
git commit -m "$(cat <<'EOF'
feat(auth): dispatch POST /auth/login by IdentifierClassifier

Hybrid email/nick discriminator routes mode-1 (admin, requires password)
vs visitor (NickServ-as-IDP or anon, password optional). Single response
shape: {token, subject: {kind: :user|:visitor, ...}} per Q-E.

Wire-shape change: request body now {identifier, password?} (was
{name, password}). cicchetto updated in same cluster.

Error mapping:
- malformed identifier → 400
- ip cap exceeded     → 429
- visitor disabled    → 503
- upstream refused    → 502
- 8s timeout no 001   → 504
EOF
)"
```

---

### Task 11: Plugs.Authn — visitor session branch + touch/1

**Files:**
- Modify: `lib/grappa_web/plugs/authn.ex`
- Test: extend `test/grappa_web/plugs/authn_test.exs`

- [ ] **Step 11.1: Failing tests**

```elixir
# test/grappa_web/plugs/authn_test.exs — add describes
describe "visitor session branch" do
  test "valid visitor token assigns :current_visitor (not :current_user)", %{conn: conn} do
    visitor = insert(:visitor)
    {:ok, session} = Accounts.create_session({:visitor, visitor.id}, "1.2.3.4", "ua")

    conn = conn |> put_req_header("authorization", "Bearer #{session.id}") |> Authn.call([])

    assert conn.assigns[:current_visitor].id == visitor.id
    refute Map.has_key?(conn.assigns, :current_user)
    assert conn.assigns[:current_session_id] == session.id
  end

  test "visitor token bumps expires_at via Visitors.touch/1", %{conn: conn} do
    visitor = insert(:visitor, expires_at: DateTime.utc_now() |> DateTime.add(46, :hour))
    {:ok, session} = Accounts.create_session({:visitor, visitor.id}, "1.2.3.4", "ua")

    conn |> put_req_header("authorization", "Bearer #{session.id}") |> Authn.call([])

    bumped = Repo.reload!(visitor)
    assert DateTime.compare(bumped.expires_at, visitor.expires_at) == :gt
  end

  test "expired visitor returns 401 (touch checks expires_at)", %{conn: conn} do
    visitor = insert(:visitor, expires_at: DateTime.utc_now() |> DateTime.add(-1, :hour))
    {:ok, session} = Accounts.create_session({:visitor, visitor.id}, "1.2.3.4", "ua")

    conn = conn |> put_req_header("authorization", "Bearer #{session.id}") |> Authn.call([])

    assert conn.status == 401
    assert conn.halted
  end
end
```

- [ ] **Step 11.2: Update plug**

```elixir
# lib/grappa_web/plugs/authn.ex — replace call/2 body
@impl Plug
def call(conn, _) do
  with {:ok, token} <- get_token(conn),
       {:ok, session} <- Accounts.authenticate(token),
       {:ok, conn} <- assign_subject(conn, session) do
    conn
    |> assign(:current_session_id, session.id)
  else
    {:error, reason} ->
      Logger.info("authn rejected", authn_failure: reason)
      unauthorized(conn)

    :error ->
      Logger.info("authn rejected", authn_failure: :no_bearer)
      unauthorized(conn)
  end
end

defp assign_subject(conn, %Accounts.Session{user_id: user_id, visitor_id: nil}) when is_binary(user_id) do
  user = Accounts.get_user!(user_id)
  {:ok, conn |> assign(:current_user_id, user_id) |> assign(:current_user, user)}
end

defp assign_subject(conn, %Accounts.Session{user_id: nil, visitor_id: visitor_id}) when is_binary(visitor_id) do
  case Visitors.touch(visitor_id) do
    {:ok, %{expires_at: exp} = visitor} ->
      now = DateTime.utc_now()
      if DateTime.compare(exp, now) == :gt do
        {:ok, conn |> assign(:current_visitor_id, visitor_id) |> assign(:current_visitor, visitor)}
      else
        {:error, :expired_visitor}
      end

    {:error, reason} ->
      {:error, {:visitor_load_failed, reason}}
  end
end
```

- [ ] **Step 11.3: Run tests**

```bash
scripts/test.sh test/grappa_web/plugs/authn_test.exs
```

- [ ] **Step 11.4: Commit**

```bash
git add lib/grappa_web/plugs/authn.ex test/grappa_web/plugs/authn_test.exs
git commit -m "$(cat <<'EOF'
feat(authn): branch on session FK to assign current_user xor current_visitor

Single Authorization-bearer transport per Q-A/C. Plug calls
Accounts.authenticate/1 unchanged, then dispatches on session.user_id
vs session.visitor_id presence. Visitor branch invokes Visitors.touch/1
for sliding-TTL refresh (W9 — ≥1h cadence handled inside touch/1).

Expired visitor → 401 (touch returns row but expires_at < now).
EOF
)"
```

---

### Task 12: UserSocket visitor branch

**Files:**
- Modify: `lib/grappa_web/channels/user_socket.ex`
- Test: extend `test/grappa_web/channels/user_socket_test.exs`

- [ ] **Step 12.1: Failing test**

```elixir
# test/grappa_web/channels/user_socket_test.exs
describe "connect/3 visitor token path" do
  test "visitor session token connects + assigns visitor_id" do
    visitor = insert(:visitor)
    {:ok, session} = Accounts.create_session({:visitor, visitor.id}, "1.2.3.4", "ua")

    assert {:ok, socket} = connect(GrappaWeb.UserSocket, %{"token" => session.id})
    assert socket.assigns.current_visitor_id == visitor.id
    refute Map.has_key?(socket.assigns, :current_user_id)
  end
end
```

- [ ] **Step 12.2: Update connect/3**

```elixir
# lib/grappa_web/channels/user_socket.ex
def connect(%{"token" => token}, socket, _connect_info) do
  with {:ok, session} <- Accounts.authenticate(token) do
    {:ok, assign_subject(socket, session)}
  else
    _ -> :error
  end
end

defp assign_subject(socket, %{user_id: user_id, visitor_id: nil}) when is_binary(user_id) do
  socket
  |> assign(:current_user_id, user_id)
  |> assign(:current_session_id, socket.assigns[:current_session_id] || nil)
end

defp assign_subject(socket, %{user_id: nil, visitor_id: visitor_id}) when is_binary(visitor_id) do
  case Visitors.touch(visitor_id) do
    {:ok, _} ->
      assign(socket, :current_visitor_id, visitor_id)
    _ ->
      socket  # connect proceeds; channel join can fail later if needed
  end
end
```

- [ ] **Step 12.3: Run tests**

```bash
scripts/test.sh test/grappa_web/channels/user_socket_test.exs
```

- [ ] **Step 12.4: Commit**

```bash
git add lib/grappa_web/channels/user_socket.ex test/grappa_web/channels/user_socket_test.exs
git commit -m "$(cat <<'EOF'
feat(channels): UserSocket connect branches on session FK

Visitor token assigns :current_visitor_id (not :current_user_id).
Touches sliding TTL on connect; subsequent handle_in callbacks rely on
authenticated socket without re-touching (handle_in is the user-initiated
verb that bumps — added in next task on per-channel handlers if needed).
EOF
)"
```

---

## Phase 4 — Session integration (NSInterceptor + +r watcher)

### Task 13: NSInterceptor pure module

**Files:**
- Create: `lib/grappa/session/ns_interceptor.ex`
- Test: `test/grappa/session/ns_interceptor_test.exs`

- [ ] **Step 13.1: Failing tests**

```elixir
# test/grappa/session/ns_interceptor_test.exs
defmodule Grappa.Session.NSInterceptorTest do
  use ExUnit.Case, async: true

  alias Grappa.Session.NSInterceptor

  describe "intercept/1" do
    test "PRIVMSG NickServ :IDENTIFY pwd → {:capture, pwd}" do
      assert {:capture, "s3cret"} =
               NSInterceptor.intercept("PRIVMSG NickServ :IDENTIFY s3cret")
    end

    test "PRIVMSG NickServ :IDENTIFY account pwd → {:capture, pwd}" do
      assert {:capture, "s3cret"} =
               NSInterceptor.intercept("PRIVMSG NickServ :IDENTIFY vjt s3cret")
    end

    test "PRIVMSG NickServ :GHOST nick pwd → {:capture, pwd}" do
      assert {:capture, "s3cret"} =
               NSInterceptor.intercept("PRIVMSG NickServ :GHOST vjt s3cret")
    end

    test "PRIVMSG NickServ :REGISTER pwd email → {:capture, pwd}" do
      assert {:capture, "s3cret"} =
               NSInterceptor.intercept("PRIVMSG NickServ :REGISTER s3cret vjt@bad.ass")
    end

    test "case-insensitive verb match" do
      assert {:capture, "s3cret"} = NSInterceptor.intercept("privmsg nickserv :identify s3cret")
    end

    test "unrelated PRIVMSG → :passthrough" do
      assert :passthrough = NSInterceptor.intercept("PRIVMSG #italia :ciao")
    end

    test "PRIVMSG to non-NickServ → :passthrough" do
      assert :passthrough = NSInterceptor.intercept("PRIVMSG vjt :hello")
    end

    test "non-PRIVMSG → :passthrough" do
      assert :passthrough = NSInterceptor.intercept("JOIN #italia")
      assert :passthrough = NSInterceptor.intercept("PING :foo")
    end
  end
end
```

- [ ] **Step 13.2: Implement**

```elixir
# lib/grappa/session/ns_interceptor.ex
defmodule Grappa.Session.NSInterceptor do
  @moduledoc """
  Pure module: matches outbound IRC lines for NickServ identity verbs
  that carry a password, captures the password into a staging buffer.

  Used by `Grappa.Session.Server`'s outbound send path. Captures land
  in `state.pending_auth = {password, deadline}` and are committed to
  the visitor row ONLY on +r MODE observation (or discarded on 10s
  timeout). Wrong passwords never touch the DB.

  Per W8: same Session.Server mailbox is FIFO, so two concurrent
  IDENTIFY commands serialize and the second overwrites pending_auth —
  latest-wins for free.

  Verbs handled (case-insensitive):
  - `PRIVMSG NickServ :IDENTIFY <pwd>`
  - `PRIVMSG NickServ :IDENTIFY <account> <pwd>`
  - `PRIVMSG NickServ :GHOST <nick> <pwd>`
  - `PRIVMSG NickServ :REGISTER <pwd> <email>`

  Mirrors `Grappa.IRC.AuthFSM` shape: pure step function, no side
  effects, host GenServer applies the capture.
  """

  use Boundary, top_level?: true, deps: []

  @type result :: :passthrough | {:capture, String.t()}

  @ns_re ~r/^PRIVMSG\s+NickServ\s+:(IDENTIFY|GHOST|REGISTER)\s+(.+?)\s*$/i

  @spec intercept(String.t()) :: result()
  def intercept(line) when is_binary(line) do
    case Regex.run(@ns_re, line, capture: :all_but_first) do
      ["IDENTIFY", rest] -> {:capture, identify_password(rest)}
      ["GHOST", rest] -> {:capture, ghost_password(rest)}
      ["REGISTER", rest] -> {:capture, register_password(rest)}
      nil -> :passthrough
    end
  end

  # IDENTIFY [account] password — last whitespace-delimited token is the password
  defp identify_password(rest) do
    rest |> String.split() |> List.last()
  end

  # GHOST nick password — second token is the password
  defp ghost_password(rest) do
    case String.split(rest, " ", parts: 2) do
      [_nick, pwd] -> pwd
      [pwd] -> pwd
    end
  end

  # REGISTER password email — first token is the password
  defp register_password(rest) do
    rest |> String.split() |> List.first()
  end
end
```

- [ ] **Step 13.3: Run tests**

```bash
scripts/test.sh test/grappa/session/ns_interceptor_test.exs
```

- [ ] **Step 13.4: Commit**

```bash
git add lib/grappa/session/ns_interceptor.ex test/grappa/session/ns_interceptor_test.exs
git commit -m "$(cat <<'EOF'
feat(session): add NSInterceptor pure module for outbound NS-verb capture

Pattern-matches outbound PRIVMSG NickServ :IDENTIFY|GHOST|REGISTER
lines, returns {:capture, password} or :passthrough. Used by
Session.Server's outbound send path to stage passwords into pending_auth.
Wrong passwords never reach the DB — atomic commit happens only on +r
MODE observation in a later task.

Pure module — mirrors AuthFSM shape (pure step, no I/O). Latest-wins
serialization is automatic via Session.Server mailbox FIFO (W8).
EOF
)"
```

---

### Task 14: Session.Server — wire NSInterceptor + pending_auth state + 10s timeout

**Files:**
- Modify: `lib/grappa/session/server.ex`
- Test: extend `test/grappa/session/server_test.exs`

- [ ] **Step 14.1: Failing tests**

```elixir
# test/grappa/session/server_test.exs — add describe
describe "outbound NS verb capture into pending_auth" do
  test "send_privmsg NickServ IDENTIFY stages password", %{session_pid: pid} do
    GenServer.call(pid, {:send_privmsg, "NickServ", "IDENTIFY s3cret"})

    state = :sys.get_state(pid)
    assert match?({"s3cret", _deadline}, state.pending_auth)
  end

  test "10s timeout discards pending_auth without commit", %{session_pid: pid} do
    GenServer.call(pid, {:send_privmsg, "NickServ", "IDENTIFY s3cret"})

    Process.send(pid, :pending_auth_timeout, [])
    Process.sleep(50)

    state = :sys.get_state(pid)
    assert is_nil(state.pending_auth)
  end

  test "second IDENTIFY overwrites first (latest-wins via mailbox FIFO)", %{session_pid: pid} do
    GenServer.call(pid, {:send_privmsg, "NickServ", "IDENTIFY old"})
    GenServer.call(pid, {:send_privmsg, "NickServ", "IDENTIFY new"})

    state = :sys.get_state(pid)
    assert match?({"new", _}, state.pending_auth)
  end

  test "non-NS PRIVMSG does not stage", %{session_pid: pid} do
    GenServer.call(pid, {:send_privmsg, "#italia", "ciao"})

    state = :sys.get_state(pid)
    assert is_nil(state.pending_auth)
  end
end
```

- [ ] **Step 14.2: Implement**

```elixir
# lib/grappa/session/server.ex — modify state struct, add pending_auth field
defmodule State do
  @type t :: %__MODULE__{
    # ... existing fields
    pending_auth: nil | {String.t(), integer()},  # {password, monotonic_deadline_ms}
    pending_auth_timer: reference() | nil
  }
end

# In handle_call({:send_privmsg, target, body}, _, state):
def handle_call({:send_privmsg, target, body}, _from, state) do
  line = "PRIVMSG #{target} :#{body}"

  state =
    case Grappa.Session.NSInterceptor.intercept(line) do
      {:capture, password} -> stage_pending_auth(state, password)
      :passthrough -> state
    end

  Client.send_line(state.client_pid, line)
  # ... existing reply path
  {:reply, :ok, state}
end

@pending_auth_timeout_ms 10_000

defp stage_pending_auth(state, password) do
  if state.pending_auth_timer, do: Process.cancel_timer(state.pending_auth_timer)

  timer = Process.send_after(self(), :pending_auth_timeout, @pending_auth_timeout_ms)
  deadline = System.monotonic_time(:millisecond) + @pending_auth_timeout_ms

  %{state | pending_auth: {password, deadline}, pending_auth_timer: timer}
end

def handle_info(:pending_auth_timeout, state) do
  Logger.debug("pending_auth discarded after #{@pending_auth_timeout_ms}ms without +r")
  {:noreply, %{state | pending_auth: nil, pending_auth_timer: nil}}
end
```

- [ ] **Step 14.3: Run tests**

```bash
scripts/test.sh test/grappa/session/server_test.exs
```

- [ ] **Step 14.4: Commit**

```bash
git add lib/grappa/session/server.ex test/grappa/session/server_test.exs
git commit -m "$(cat <<'EOF'
feat(session): wire NSInterceptor on send_privmsg, stage pending_auth

State gains pending_auth :: nil | {pwd, deadline_ms} + a 10s
Process.send_after timer that sends :pending_auth_timeout to clear.

Send path: every outbound PRIVMSG runs through NSInterceptor; capture
overwrites pending_auth (latest-wins via mailbox FIFO per W8). Wrong
passwords never reach the DB — atomic commit lands in next task on +r
MODE observation.
EOF
)"
```

---

### Task 15: +r MODE observer in EventRouter — atomic commit

**Files:**
- Modify: `lib/grappa/session/event_router.ex`
- Modify: `lib/grappa/session/server.ex`
- Test: `test/grappa/session/event_router_test.exs`, `test/grappa/session/server_test.exs`

- [ ] **Step 15.1: Failing test (EventRouter)**

```elixir
# test/grappa/session/event_router_test.exs — add describe
describe "+r MODE on session's own nick → :visitor_r_observed" do
  test "MODE <my_nick> +r emits :visitor_r_observed effect" do
    state = %Session.Server.State{
      nick: "vjt",
      subject: {:visitor, "uuid-1"},
      pending_auth: {"s3cret", System.monotonic_time(:millisecond) + 10_000}
    }

    msg = parse_irc("MODE vjt +r")

    {effects, _next_state} = EventRouter.route(msg, state)
    assert {:visitor_r_observed, "s3cret"} in effects
  end

  test "MODE <my_nick> +r without pending_auth → no effect" do
    state = %Session.Server.State{
      nick: "vjt",
      subject: {:visitor, "uuid-1"},
      pending_auth: nil
    }

    msg = parse_irc("MODE vjt +r")
    {effects, _} = EventRouter.route(msg, state)
    refute Enum.any?(effects, &match?({:visitor_r_observed, _}, &1))
  end

  test "MODE on different nick → no effect" do
    state = %Session.Server.State{nick: "vjt", subject: {:visitor, "uuid-1"}, pending_auth: {"x", 0}}

    msg = parse_irc("MODE other +r")
    {effects, _} = EventRouter.route(msg, state)
    refute Enum.any?(effects, &match?({:visitor_r_observed, _}, &1))
  end

  test "user-mode without +r → no effect" do
    state = %Session.Server.State{nick: "vjt", subject: {:visitor, "uuid-1"}, pending_auth: {"x", 0}}

    msg = parse_irc("MODE vjt +i")
    {effects, _} = EventRouter.route(msg, state)
    refute Enum.any?(effects, &match?({:visitor_r_observed, _}, &1))
  end
end
```

- [ ] **Step 15.2: EventRouter wiring**

```elixir
# lib/grappa/session/event_router.ex — extend :mode handler
defp handle_mode(%Message{params: [target, modes_str | _]}, state)
     when target == state.nick do
  effects =
    if String.contains?(modes_str, "+r") and not is_nil(state.pending_auth) do
      {pwd, _deadline} = state.pending_auth
      [{:visitor_r_observed, pwd}]
    else
      []
    end

  # ... fold existing mode-tracking effects
  {effects, state}
end
```

- [ ] **Step 15.3: Session.Server applies the effect → Visitors.commit_password/2**

```elixir
# lib/grappa/session/server.ex — extend apply_effects/2
defp apply_effects([{:visitor_r_observed, password} | rest], state) do
  case state.subject do
    {:visitor, visitor_id} ->
      case Grappa.Visitors.commit_password(visitor_id, password) do
        {:ok, _visitor} ->
          Logger.info("visitor +r observed, password committed", visitor: visitor_id)

        {:error, reason} ->
          Logger.error("visitor +r observed but commit failed", visitor: visitor_id, reason: inspect(reason))
      end

    _ ->
      :ok  # mode-1 sessions ignore visitor commit
  end

  if state.pending_auth_timer, do: Process.cancel_timer(state.pending_auth_timer)
  apply_effects(rest, %{state | pending_auth: nil, pending_auth_timer: nil})
end
```

- [ ] **Step 15.4: Integration test (full path)**

```elixir
# test/grappa/session/server_test.exs
describe "full path: outbound IDENTIFY → +r observation → visitor row updated" do
  test "happy path commits password atomically", %{session_pid: pid, visitor: visitor} do
    GenServer.call(pid, {:send_privmsg, "NickServ", "IDENTIFY s3cret"})

    # Simulate upstream sending MODE +r on our nick
    Process.send(pid, {:irc, parse_irc("MODE #{visitor.nick} +r")}, [])

    eventually(fn ->
      reloaded = Repo.reload!(visitor)
      assert reloaded.password_encrypted != nil
      assert DateTime.compare(reloaded.expires_at, visitor.expires_at) == :gt
    end)
  end

  test "wrong password (no +r in 10s) does NOT commit", %{session_pid: pid, visitor: visitor} do
    GenServer.call(pid, {:send_privmsg, "NickServ", "IDENTIFY wrong"})

    # Simulate timeout
    Process.send(pid, :pending_auth_timeout, [])
    Process.sleep(100)

    reloaded = Repo.reload!(visitor)
    assert is_nil(reloaded.password_encrypted)
  end
end
```

- [ ] **Step 15.5: Run all tests**

```bash
scripts/test.sh test/grappa/session/event_router_test.exs test/grappa/session/server_test.exs
```

- [ ] **Step 15.6: Commit**

```bash
git add lib/grappa/session/event_router.ex lib/grappa/session/server.ex \
        test/grappa/session/event_router_test.exs test/grappa/session/server_test.exs
git commit -m "$(cat <<'EOF'
feat(session): observe +r MODE → atomic visitor password+TTL commit

EventRouter detects +r in MODE on session's own nick when pending_auth
is staged → emits {:visitor_r_observed, pwd} effect. Session.Server's
apply_effects calls Visitors.commit_password/2 which atomically writes
encrypted password and bumps expires_at to now+7d.

Wrong passwords + 10s timeout → pending_auth discarded, no commit.
Mode-1 sessions ignore the effect (subject != visitor).

Closes the wrong-password-stays-anon design (memory pin) — DB only sees
verified-against-NickServ passwords.
EOF
)"
```

---

### Task 16: Session.Server — auto-issue IDENTIFY post-001 if pending_password set

**Files:**
- Modify: `lib/grappa/session/server.ex`

When Visitors.Login passed `pending_password` in plan opts, Session.Server queues an outbound `PRIVMSG NickServ :IDENTIFY <pwd>` immediately after 001. NSInterceptor stages it; +r observation commits.

- [ ] **Step 16.1: Failing test**

```elixir
describe "pending_password from plan auto-issues IDENTIFY post-001" do
  test "session sends NickServ IDENTIFY after 001", %{server: fake} do
    plan = plan_opts_for(fake) |> Map.put(:pending_password, "s3cret")

    {:ok, _pid} = Session.start_session({:visitor, "uuid-1"}, network_id, plan)
    IRCServer.send_001(fake)

    assert_receive {:ircserver_received, "PRIVMSG NickServ :IDENTIFY s3cret"}, 1_000
  end
end
```

- [ ] **Step 16.2: Implement**

```elixir
# lib/grappa/session/server.ex — handle_info for 001 already in Task 8
def handle_info({:irc, %Message{command: :"001"} = msg}, state) do
  state = maybe_notify_ready(state)
  state = maybe_issue_pending_identify(state)
  # ... existing 001 handling
  {:noreply, state}
end

defp maybe_issue_pending_identify(%State{pending_password: nil} = state), do: state

defp maybe_issue_pending_identify(%State{pending_password: pwd, client_pid: client} = state)
     when is_binary(pwd) do
  Client.send_line(client, "PRIVMSG NickServ :IDENTIFY #{pwd}")
  # NSInterceptor will fire on the send path and stage pending_auth.
  # Actually — Client.send_line bypasses our handle_call(:send_privmsg);
  # call NSInterceptor.intercept directly here OR route through
  # GenServer.call(self(), {:send_privmsg, ...}).
  # Cleanest: route through self-call:
  GenServer.call(self(), {:send_privmsg, "NickServ", "IDENTIFY #{pwd}"})
  # NB: self-call from handle_info is generally fine in OTP — same process,
  # but message queue ordering matters. Alternative: stage pending_auth
  # inline + direct Client.send_line:
  state = stage_pending_auth(state, pwd)
  Client.send_line(state.client_pid, "PRIVMSG NickServ :IDENTIFY #{pwd}")

  %{state | pending_password: nil}
end
```

(Self-call from `handle_info` is a code smell — go with the inline `stage_pending_auth` + direct `Client.send_line` path. Single place: NSInterceptor stages either via the public `:send_privmsg` API path or directly via `stage_pending_auth/2`.)

- [ ] **Step 16.3: Run tests + commit**

```bash
scripts/test.sh test/grappa/session/server_test.exs
git add lib/grappa/session/server.ex test/grappa/session/server_test.exs
git commit -m "$(cat <<'EOF'
feat(session): auto-issue NickServ IDENTIFY post-001 when pending_password set

Plan opts can carry pending_password (from Visitors.Login). On 001
RPL_WELCOME, Session.Server stages the password via stage_pending_auth/2
and emits PRIVMSG NickServ :IDENTIFY <pwd>. Atomic commit follows on +r
MODE observation per Task 15.

Same code path as cicchetto-typed `/ns identify` — one feature, one code
path per CLAUDE.md.
EOF
)"
```

---

## Phase 5 — Reconnect resilience (GhostRecovery + Bootstrap)

### Task 17: GhostRecovery pure FSM

**Files:**
- Create: `lib/grappa/session/ghost_recovery.ex`
- Test: `test/grappa/session/ghost_recovery_test.exs`

- [ ] **Step 17.1: Failing tests**

```elixir
defmodule Grappa.Session.GhostRecoveryTest do
  use ExUnit.Case, async: true

  alias Grappa.Session.GhostRecovery

  describe "step/2 state transitions" do
    test ":idle on 433 with cached password → :awaiting_ghost_notice + GHOST emitted" do
      state = GhostRecovery.init("vjt", "s3cret")

      assert {:cont, next, lines} =
               GhostRecovery.step(state, {:numeric, "433", ["*", "vjt"]})

      assert next.phase == :awaiting_ghost_notice
      assert next.try_nick == "vjt_"
      assert "NICK vjt_" in lines
      assert "PRIVMSG NickServ :GHOST vjt s3cret" in lines
    end

    test ":idle on 433 without cached password → :failed + only NICK underscore" do
      state = GhostRecovery.init("vjt", nil)

      assert {:cont, next, lines} =
               GhostRecovery.step(state, {:numeric, "433", ["*", "vjt"]})

      assert next.phase == :failed
      assert "NICK vjt_" in lines
      refute Enum.any?(lines, &String.starts_with?(&1, "PRIVMSG NickServ :GHOST"))
    end

    test ":awaiting_ghost_notice on NickServ NOTICE → :awaiting_whois + WHOIS emitted" do
      state = %GhostRecovery{phase: :awaiting_ghost_notice, orig_nick: "vjt", try_nick: "vjt_", password: "s3cret"}

      assert {:cont, next, lines} =
               GhostRecovery.step(state, {:nickserv_notice, "Ghost killed."})

      assert next.phase == :awaiting_whois
      assert "WHOIS vjt" in lines
    end

    test ":awaiting_whois on 401 (no such nick) → :succeeded + NICK + IDENTIFY emitted" do
      state = %GhostRecovery{phase: :awaiting_whois, orig_nick: "vjt", try_nick: "vjt_", password: "s3cret"}

      assert {:stop, next, lines} =
               GhostRecovery.step(state, {:numeric, "401", ["vjt_", "vjt", "No such nick"]})

      assert next.phase == :succeeded
      assert "NICK vjt" in lines
      assert "PRIVMSG NickServ :IDENTIFY s3cret" in lines
    end

    test ":awaiting_whois on 311 (still there) → :failed" do
      state = %GhostRecovery{phase: :awaiting_whois, orig_nick: "vjt"}

      assert {:stop, next, lines} =
               GhostRecovery.step(state, {:numeric, "311", ["vjt_", "vjt", "user", "host", "*", "Real"]})

      assert next.phase == :failed
      assert lines == []
    end

    test "8s timeout in any phase → :failed" do
      state = %GhostRecovery{phase: :awaiting_ghost_notice}
      assert {:stop, %{phase: :failed}, []} = GhostRecovery.step(state, :timeout)
    end
  end
end
```

- [ ] **Step 17.2: Implement**

```elixir
# lib/grappa/session/ghost_recovery.ex
defmodule Grappa.Session.GhostRecovery do
  @moduledoc """
  Pure FSM: handles NICK 433 collision recovery on reconnect for
  visitors with a cached NickServ password.

  Mirrors `Grappa.IRC.AuthFSM` shape — pure step function returning
  `{:cont | :stop, state, [lines]}`. Host (`Session.Server`) wraps the
  FSM, owns I/O, applies an 8s timeout via `Process.send_after`.

  Flow:
  1. NICK 433 received → if cached pwd, append `_` to nick + send GHOST
     to original nick, transition to :awaiting_ghost_notice.
  2. NickServ NOTICE received → send WHOIS on original nick, transition
     to :awaiting_whois.
  3. WHOIS 401 (no such nick) → original nick is gone → /nick back +
     IDENTIFY, transition to :succeeded.
  4. WHOIS 311 (still there) → bail, transition to :failed.
  5. 8s timeout in any non-terminal phase → :failed.

  No cached password OR :failed terminal = visitor stays on `<nick>_`
  (anon-shape until next session restart).
  """

  use Boundary, top_level?: true, deps: []

  defstruct phase: :idle, orig_nick: nil, try_nick: nil, password: nil

  @type phase :: :idle | :awaiting_ghost_notice | :awaiting_whois | :succeeded | :failed

  @type t :: %__MODULE__{
          phase: phase(),
          orig_nick: String.t() | nil,
          try_nick: String.t() | nil,
          password: String.t() | nil
        }

  @type input ::
          {:numeric, String.t(), [String.t()]}
          | {:nickserv_notice, String.t()}
          | :timeout

  @spec init(String.t(), String.t() | nil) :: t()
  def init(orig_nick, password) when is_binary(orig_nick) do
    %__MODULE__{phase: :idle, orig_nick: orig_nick, password: password}
  end

  @spec step(t(), input()) :: {:cont, t(), [String.t()]} | {:stop, t(), [String.t()]}

  # 433 + cached password → GHOST + try underscore-appended nick
  def step(%__MODULE__{phase: :idle, orig_nick: orig, password: pwd} = s, {:numeric, "433", _})
      when is_binary(pwd) do
    try_nick = orig <> "_"
    {:cont, %{s | phase: :awaiting_ghost_notice, try_nick: try_nick},
     ["NICK #{try_nick}", "PRIVMSG NickServ :GHOST #{orig} #{pwd}"]}
  end

  # 433 + no cached password → just append underscore, give up on ghost
  def step(%__MODULE__{phase: :idle, orig_nick: orig, password: nil} = s, {:numeric, "433", _}) do
    try_nick = orig <> "_"
    {:cont, %{s | phase: :failed, try_nick: try_nick}, ["NICK #{try_nick}"]}
  end

  # GHOST sent → wait for NickServ NOTICE → WHOIS original
  def step(%__MODULE__{phase: :awaiting_ghost_notice, orig_nick: orig} = s, {:nickserv_notice, _}) do
    {:cont, %{s | phase: :awaiting_whois}, ["WHOIS #{orig}"]}
  end

  # WHOIS 401 (no such nick) → original is gone → /nick + IDENTIFY
  def step(%__MODULE__{phase: :awaiting_whois, orig_nick: orig, password: pwd} = s,
           {:numeric, "401", _}) do
    {:stop, %{s | phase: :succeeded},
     ["NICK #{orig}", "PRIVMSG NickServ :IDENTIFY #{pwd}"]}
  end

  # WHOIS 311 (still there) → bail
  def step(%__MODULE__{phase: :awaiting_whois} = s, {:numeric, "311", _}) do
    {:stop, %{s | phase: :failed}, []}
  end

  # Timeout in any non-terminal phase
  def step(%__MODULE__{phase: phase} = s, :timeout)
      when phase in [:idle, :awaiting_ghost_notice, :awaiting_whois] do
    {:stop, %{s | phase: :failed}, []}
  end

  # No-op fallthrough for unrelated input
  def step(state, _), do: {:cont, state, []}
end
```

- [ ] **Step 17.3: Tests + commit**

```bash
scripts/test.sh test/grappa/session/ghost_recovery_test.exs
git add lib/grappa/session/ghost_recovery.ex test/grappa/session/ghost_recovery_test.exs
git commit -m "$(cat <<'EOF'
feat(session): add GhostRecovery pure FSM for nick-collision reconnect

Pure step function mirroring AuthFSM shape — no I/O, no GenServer.
Handles NICK 433 → underscore-append → GHOST → NickServ NOTICE →
WHOIS → 401-vs-311 dispatch → /nick + IDENTIFY (succeeded) or stay
on underscore (failed).

Host Session.Server wires step/2 invocations + 8s timeout in next task.
EOF
)"
```

---

### Task 18: Session.Server wires GhostRecovery hooks

**Files:**
- Modify: `lib/grappa/session/server.ex`
- Test: extend integration tests

- [ ] **Step 18.1: Failing test**

```elixir
describe "GhostRecovery integration" do
  test "433 with cached password → GHOST sent → 401 → /nick + IDENTIFY", %{server: fake, visitor: visitor} do
    {:ok, registered} = Visitors.commit_password(visitor.id, "s3cret")
    plan = plan_opts_for(fake) |> Map.put(:nick, registered.nick) |> Map.put(:auth_method, :nickserv_identify) |> Map.put(:password, "s3cret")

    {:ok, _pid} = Session.start_session({:visitor, registered.id}, plan.network_id, plan)

    # Server returns 433 (nick in use) on initial NICK
    IRCServer.send_433(fake, registered.nick)

    # Expect GHOST + underscore-NICK
    assert_receive {:ircserver_received, "NICK " <> _underscore_variant}, 1_000
    assert_receive {:ircserver_received, "PRIVMSG NickServ :GHOST " <> _}, 1_000

    # Server replies with NickServ NOTICE
    IRCServer.send_nickserv_notice(fake, "Ghost killed.")
    assert_receive {:ircserver_received, "WHOIS " <> _}, 1_000

    # Server replies with 401 (no such nick — ghost succeeded)
    IRCServer.send_401(fake, registered.nick)
    assert_receive {:ircserver_received, "NICK " <> nick}, 1_000
    assert nick == registered.nick
    assert_receive {:ircserver_received, "PRIVMSG NickServ :IDENTIFY s3cret"}, 1_000
  end
end
```

- [ ] **Step 18.2: Implement**

```elixir
# lib/grappa/session/server.ex — add ghost_recovery field to State
# State :: %State{..., ghost_recovery: GhostRecovery.t() | nil, ghost_timer: ref | nil}

# In handle_info({:irc, %Message{command: :"433", ...}}, state):
def handle_info({:irc, %Message{command: :"433", params: params}}, state) do
  case state.subject do
    {:visitor, _} ->
      pwd = state.cached_password  # set from plan.password during init
      gr = GhostRecovery.init(state.nick, pwd)
      {next, lines} = GhostRecovery.step(gr, {:numeric, "433", params})
      send_lines(state.client_pid, lines)
      timer = Process.send_after(self(), :ghost_timeout, 8_000)
      {:noreply, %{state | ghost_recovery: extract_state(next), ghost_timer: timer}}

    _ ->
      # mode-1 keeps existing 433 behavior (currently: log + sit on _ nick)
      # ... existing handling
      {:noreply, state}
  end
end

# Wire NickServ NOTICE / 401 / 311 / timeout into ghost_recovery if non-nil
def handle_info({:irc, %Message{command: :notice, prefix: prefix, params: [_target, body]}}, state)
    when not is_nil(state.ghost_recovery) do
  if String.starts_with?(prefix || "", "NickServ!") do
    advance_ghost(state, {:nickserv_notice, body})
  else
    delegate(msg, state)
  end
end

def handle_info({:irc, %Message{command: cmd, params: params}}, state)
    when not is_nil(state.ghost_recovery) and cmd in [:"401", :"311"] do
  advance_ghost(state, {:numeric, to_string(cmd), params})
end

def handle_info(:ghost_timeout, %State{ghost_recovery: gr} = state) when not is_nil(gr) do
  {next, lines} = GhostRecovery.step(gr, :timeout)
  send_lines(state.client_pid, lines)
  {:noreply, %{state | ghost_recovery: nil, ghost_timer: nil}}
end

defp advance_ghost(state, input) do
  {next, lines} = GhostRecovery.step(state.ghost_recovery, input)
  send_lines(state.client_pid, lines)

  case next do
    %{phase: :succeeded} -> {:noreply, %{state | ghost_recovery: nil, ghost_timer: nil}}
    %{phase: :failed} -> {:noreply, %{state | ghost_recovery: nil, ghost_timer: nil}}
    cont -> {:noreply, %{state | ghost_recovery: cont}}
  end
end

defp send_lines(client_pid, lines) do
  Enum.each(lines, &Client.send_line(client_pid, &1))
end
```

- [ ] **Step 18.3: Tests + commit**

```bash
scripts/test.sh test/grappa/session/server_test.exs
git add lib/grappa/session/server.ex test/grappa/session/server_test.exs
git commit -m "$(cat <<'EOF'
feat(session): wire GhostRecovery FSM for visitor nick-collision reconnect

Visitor sessions with cached password run GhostRecovery on 433. State
field :ghost_recovery holds the FSM struct; 8s timeout via
Process.send_after sends :ghost_timeout. NickServ NOTICE / 401 / 311 are
fed into step/2; emitted lines are flushed via Client.send_line.

Mode-1 sessions keep existing 433 behavior unchanged. The IDENTIFY
emitted on success goes through NSInterceptor (latest-wins) and
participates in +r MODE observation just like a cicchetto-typed
/ns identify — one feature, one code path.
EOF
)"
```

---

### Task 19: Bootstrap visitor respawn

**Files:**
- Modify: `lib/grappa/bootstrap.ex`
- Test: extend `test/grappa/bootstrap_test.exs`

- [ ] **Step 19.1: Failing test**

```elixir
describe "Bootstrap respawns active visitors" do
  test "spawns Session.Server per active visitor with cached password" do
    network = insert(:network, slug: "azzurra")
    insert(:network_server, network: network, enabled: true)
    {:ok, v} = Visitors.find_or_provision_anon("vjt", "azzurra", nil)
    {:ok, _} = Visitors.commit_password(v.id, "s3cret")
    {:ok, _} = %Visitors.VisitorChannel{}
                 |> Visitors.VisitorChannel.changeset(%{visitor_id: v.id, network_slug: "azzurra", name: "#italia"})
                 |> Repo.insert()

    Application.put_env(:grappa, :visitor_network, "azzurra")

    Bootstrap.run()

    eventually(fn ->
      assert {:ok, _pid} = Session.lookup({:visitor, v.id}, network.id)
    end)
  end

  test "skips expired visitors" do
    insert(:visitor, expires_at: DateTime.utc_now() |> DateTime.add(-1, :hour))
    Bootstrap.run()
    # ... assert no spawn
  end
end
```

- [ ] **Step 19.2: Extend Bootstrap.run/0**

```elixir
# lib/grappa/bootstrap.ex
def run do
  validate_visitor_networks!()  # W7 hard-error path — Task 20
  spawn_credentials()
  spawn_visitors()
  :ok
end

defp spawn_visitors do
  Visitors.list_active()
  |> Enum.each(&spawn_visitor/1)
end

defp spawn_visitor(visitor) do
  case Grappa.Visitors.SessionPlan.resolve(visitor) do
    {:ok, plan} ->
      case Session.start_session({:visitor, visitor.id}, plan.network_id, plan) do
        {:ok, _pid} -> Logger.info("visitor session started", visitor: visitor.id, network: plan.network_slug)
        {:error, {:already_started, _}} -> :ok
        {:error, reason} -> Logger.error("visitor session start failed", visitor: visitor.id, error: inspect(reason))
      end

    {:error, reason} ->
      Logger.error("visitor session plan unresolvable", visitor: visitor.id, error: inspect(reason))
  end
end
```

- [ ] **Step 19.3: Tests + commit**

```bash
scripts/test.sh test/grappa/bootstrap_test.exs
git add lib/grappa/bootstrap.ex test/grappa/bootstrap_test.exs
git commit -m "$(cat <<'EOF'
feat(bootstrap): respawn active visitor sessions at boot

After mode-1 credentials, enumerate Visitors.list_active and spawn one
Session.Server per visitor via Visitors.SessionPlan.resolve. Cached
NickServ passwords trigger auto-IDENTIFY post-001; cached visitor_channels
trigger autojoin via existing AuthFSM/Session.Server connect path.

Expired visitors are skipped (Reaper sweeps separately). Best-effort
shape — failed spawns log + continue, mirroring Bootstrap.spawn_one for
mode-1.
EOF
)"
```

---

### Task 20: Bootstrap W7 hard-error on missing network

**Files:**
- Modify: `lib/grappa/bootstrap.ex`
- Test: extend `test/grappa/bootstrap_test.exs`

- [ ] **Step 20.1: Failing test**

```elixir
describe "W7 hard-error on visitor pinned to unconfigured network" do
  test "raises with operator instructions when visitor.network_slug not configured" do
    {:ok, _} = Visitors.find_or_provision_anon("orphan", "ghosted_network", nil)

    assert_raise RuntimeError, ~r/visitor rows pinned to .*ghosted_network.*reap_visitors/, fn ->
      Bootstrap.run()
    end
  end
end
```

- [ ] **Step 20.2: Implement**

```elixir
# lib/grappa/bootstrap.ex
defp validate_visitor_networks! do
  visitor_slugs = Visitors.list_active() |> Enum.map(& &1.network_slug) |> Enum.uniq()
  configured_slugs = Networks.list() |> Enum.map(& &1.slug) |> MapSet.new()

  orphans = Enum.reject(visitor_slugs, &MapSet.member?(configured_slugs, &1))

  case orphans do
    [] ->
      :ok

    slugs ->
      msg =
        "visitor rows pinned to network(s) not in current config: #{inspect(slugs)}. " <>
          "Either restore the network in DB or run: " <>
          Enum.map_join(slugs, " ; ", &"mix grappa.reap_visitors --network=#{&1}")

      raise RuntimeError, msg
  end
end
```

- [ ] **Step 20.3: Tests + commit**

```bash
scripts/test.sh test/grappa/bootstrap_test.exs
git add lib/grappa/bootstrap.ex test/grappa/bootstrap_test.exs
git commit -m "$(cat <<'EOF'
feat(bootstrap): hard-error on visitor rows pinned to unconfigured network

W7 implementation: pre-flight check at boot — visitor.network_slug must
exist in Networks.list. Mismatch raises with operator-actionable
recovery instructions:

  mix grappa.reap_visitors --network=<slug>

This deliberately blocks app start: silent reap of visitor data on
config change is too destructive (operator config mistake = user data
loss). Better to surface loud and require explicit reap.
EOF
)"
```

---

### Task 21: mix grappa.reap_visitors task

**Files:**
- Create: `lib/mix/tasks/grappa.reap_visitors.ex`
- Test: `test/mix/tasks/grappa.reap_visitors_test.exs`

- [ ] **Step 21.1: Failing test**

```elixir
defmodule Mix.Tasks.Grappa.ReapVisitorsTest do
  use Grappa.DataCase, async: false
  alias Mix.Tasks.Grappa.ReapVisitors

  test "deletes visitors matching --network=<slug>" do
    {:ok, keep} = Visitors.find_or_provision_anon("a", "azzurra", nil)
    {:ok, drop} = Visitors.find_or_provision_anon("b", "ghosted", nil)

    capture_io(fn -> ReapVisitors.run(["--network=ghosted"]) end)

    assert Repo.reload(keep)
    refute Repo.reload(drop)
  end

  test "rejects --network missing" do
    assert_raise Mix.Error, ~r/--network=<slug>/, fn -> ReapVisitors.run([]) end
  end
end
```

- [ ] **Step 21.2: Implement**

```elixir
defmodule Mix.Tasks.Grappa.ReapVisitors do
  @moduledoc """
  Operator task — deletes all visitor rows pinned to a given network slug.

  Used when a network is removed from the DB and Bootstrap raises W7
  hard-error. This task is the unblocker.

  Usage: `scripts/mix.sh grappa.reap_visitors --network=azzurra`

  CASCADE wipes visitor_channels + accounts_sessions + messages.
  """
  use Mix.Task
  import Ecto.Query

  alias Grappa.Repo
  alias Grappa.Visitors.Visitor

  @shortdoc "Reap visitors pinned to a given network slug"

  @impl Mix.Task
  def run(args) do
    {opts, _, _} = OptionParser.parse(args, strict: [network: :string])

    slug = opts[:network] || Mix.raise("--network=<slug> required")

    Application.ensure_all_started(:grappa, :temporary)

    {count, _} = Repo.delete_all(from v in Visitor, where: v.network_slug == ^slug)
    Mix.shell().info("Reaped #{count} visitor(s) pinned to '#{slug}' (CASCADE wiped sessions + channels + messages).")
  end
end
```

- [ ] **Step 21.3: Tests + commit**

```bash
scripts/test.sh test/mix/tasks/grappa.reap_visitors_test.exs
git add lib/mix/tasks/grappa.reap_visitors.ex test/mix/tasks/grappa.reap_visitors_test.exs
git commit -m "$(cat <<'EOF'
feat(visitors): add mix grappa.reap_visitors operator recovery task

Unblocks Bootstrap W7 hard-error path: when a network is removed from
DB and orphaned visitor rows remain, this task deletes them by slug.
CASCADE wipes related rows in visitor_channels + accounts_sessions +
messages.

Argument validation: --network=<slug> required, raises Mix.Error otherwise.
EOF
)"
```

---

## Phase 6 — Lifecycle (Reaper)

### Task 22: Visitors.Reaper GenServer

**Files:**
- Create: `lib/grappa/visitors/reaper.ex`
- Modify: `lib/grappa/application.ex` (add to supervision tree)
- Test: `test/grappa/visitors/reaper_test.exs`

- [ ] **Step 22.1: Failing tests**

```elixir
defmodule Grappa.Visitors.ReaperTest do
  use Grappa.DataCase, async: false
  alias Grappa.Visitors
  alias Grappa.Visitors.{Reaper, Visitor}

  test "sweep/0 deletes expired visitors" do
    {:ok, alive} = Visitors.find_or_provision_anon("alive", "azzurra", nil)
    {:ok, dead} = Visitors.find_or_provision_anon("dead", "azzurra", nil)
    Repo.update_all(from(v in Visitor, where: v.id == ^dead.id),
                    set: [expires_at: DateTime.utc_now() |> DateTime.add(-1, :hour)])

    assert {:ok, 1} = Reaper.sweep()
    assert Repo.reload(alive)
    refute Repo.reload(dead)
  end

  test "sweep/0 returns {:ok, 0} when nothing to reap" do
    assert {:ok, 0} = Reaper.sweep()
  end

  test "GenServer ticks every interval" do
    {:ok, dead} = Visitors.find_or_provision_anon("dead", "azzurra", nil)
    Repo.update_all(from(v in Visitor, where: v.id == ^dead.id),
                    set: [expires_at: DateTime.utc_now() |> DateTime.add(-1, :hour)])

    {:ok, _pid} = Reaper.start_link(interval_ms: 100, name: TestReaper)
    Process.sleep(150)

    refute Repo.reload(dead)
  end
end
```

- [ ] **Step 22.2: Implement**

```elixir
defmodule Grappa.Visitors.Reaper do
  @moduledoc """
  GenServer that periodically sweeps expired visitors. Runs as a
  `:permanent` child under the main application supervision tree.

  Default interval 60s — configurable via `interval_ms` start_opt for
  tests. Each sweep enumerates `Visitors.list_expired/0` and deletes
  each row; CASCADE wipes related rows in `visitor_channels`,
  `accounts_sessions`, and `messages`.

  Per-sweep failures (single visitor delete failing) log + continue;
  one bad row does not stop the sweep.
  """

  use GenServer
  use Boundary, top_level?: true, deps: [Grappa.Visitors]

  alias Grappa.Visitors

  require Logger

  @default_interval_ms 60_000

  @type opts :: [interval_ms: pos_integer(), name: GenServer.name()]

  @spec start_link(opts()) :: GenServer.on_start()
  def start_link(opts) do
    {name, opts} = Keyword.pop(opts, :name, __MODULE__)
    GenServer.start_link(__MODULE__, opts, name: name)
  end

  @spec sweep() :: {:ok, non_neg_integer()}
  def sweep do
    expired = Visitors.list_expired()

    Enum.each(expired, fn v ->
      case Visitors.delete(v.id) do
        :ok -> :ok
        {:error, reason} -> Logger.error("reaper delete failed", visitor: v.id, error: inspect(reason))
      end
    end)

    {:ok, length(expired)}
  end

  @impl true
  def init(opts) do
    interval = Keyword.get(opts, :interval_ms, @default_interval_ms)
    schedule_tick(interval)
    {:ok, %{interval_ms: interval}}
  end

  @impl true
  def handle_info(:tick, state) do
    {:ok, n} = sweep()
    if n > 0, do: Logger.info("reaper swept #{n} expired visitor(s)")
    schedule_tick(state.interval_ms)
    {:noreply, state}
  end

  defp schedule_tick(interval), do: Process.send_after(self(), :tick, interval)
end
```

- [ ] **Step 22.3: Wire into supervision tree**

```elixir
# lib/grappa/application.ex — add to children list, AFTER Repo + Bootstrap
children = [
  # ... existing
  Grappa.Repo,
  # ...
  Grappa.Visitors.Reaper,
  # ...
  Grappa.Bootstrap
]
```

- [ ] **Step 22.4: Tests + commit**

```bash
scripts/test.sh test/grappa/visitors/reaper_test.exs
git add lib/grappa/visitors/reaper.ex lib/grappa/application.ex test/grappa/visitors/reaper_test.exs
git commit -m "$(cat <<'EOF'
feat(visitors): add Reaper GenServer for expired-visitor sweep

:permanent supervised child — sweeps every 60s. Calls Visitors.delete/1
per expired row; CASCADE handles visitor_channels + accounts_sessions +
messages cleanup.

Per-row failures log + continue. Tests inject interval_ms for fast
sweep verification.
EOF
)"
```

---

### Task 23: Per-IP cap configuration wiring

**Files:**
- Modify: `config/config.exs`
- Modify: `config/runtime.exs`

- [ ] **Step 23.1: Add config keys**

```elixir
# config/config.exs — add
config :grappa,
  visitor_network: nil,
  max_visitors_per_ip: 5
```

```elixir
# config/runtime.exs — add at runtime block
if config_env() == :prod do
  config :grappa,
    visitor_network: System.get_env("GRAPPA_VISITOR_NETWORK"),
    max_visitors_per_ip: String.to_integer(System.get_env("GRAPPA_MAX_VISITORS_PER_IP", "5"))
end
```

- [ ] **Step 23.2: Run tests**

```bash
scripts/check.sh
```

Note: `Visitors.Login` already reads `:visitor_network` and `:max_visitors_per_ip` from `Application.get_env`. CLAUDE.md says runtime `Application.get_env` is banned BUT visitor-network + max-per-IP are configuration values, read once at request time. Pin: keep these as `Application.get_env` reads — they're config, not state, and `start_link` wiring is overkill for two config values that don't change post-boot. **EXCEPTION**: if Boundary or test infra forces injection, lift to module-attribute reads via `Application.compile_env/2` for compile-time config.

Actually re-reading CLAUDE.md: "`Application.{put,get}_env/2`: boot-time only, runtime banned. ... Banned at runtime — neither read nor written from any GenServer callback, controller, context function, plug body, or release task. Pass config via `start_link/1` opts; the supervisor reads env at boot and injects."

This binds. Refactor:
- `Visitors.Login` reads config at module-attribute level via `Application.compile_env/2` — this is allowed (compile-time, not runtime).
- Test override pattern: `Application.put_env` in test setup is allowed (`:start_bootstrap` exception precedent), but reads from `Application.get_env` are runtime → banned.

Rewrite Login config access:

```elixir
# lib/grappa/visitors/login.ex (top of module)
@visitor_network Application.compile_env(:grappa, :visitor_network)
@max_per_ip Application.compile_env(:grappa, :max_visitors_per_ip, 5)
```

But `compile_env` is fixed at compile time — tests can't change it per-test. Alternative: pass network_slug + cap_per_ip into `Visitors.Login.login/4` via start_opts, OR have a `Visitors.Config` GenServer holding env at boot.

Cleanest pattern: Visitors.Config (Agent or named GenServer) holds `:visitor_network` + `:max_per_ip`, read at boot from `Application.get_env` (boot-time = allowed), public API is `Visitors.Config.get/1`. Tests reset via direct GenServer.cast.

This is a non-trivial detour. **Pin alternate**: use `Application.compile_env` and accept that tests use `Application.put_env` only in setup-once shape (boot-time semantics). For multi-config-state per test: spin up a per-test Visitors.Config instance.

Actually — re-reading CLAUDE.md more carefully: "Banned at runtime — neither read nor written from any GenServer callback, controller, context function, plug body, or release task."

`Visitors.Login.login/4` is a context function. `Application.get_env` from inside it is banned. Must use start_link injection or compile_env.

**Decision:** Visitors.Login takes `visitor_network` + `max_per_ip` as opts in a per-call shape, OR the controller threads them in. The controller in turn reads from a module-level `compile_env`. Tests override via `Application.put_env` BEFORE module compile (test harness setup) OR pass explicit overrides at call site.

For this plan: **lift to function arguments, controller reads compile_env, tests use Application.put_env only for boot-time shape.** Adjust:

```elixir
# lib/grappa_web/controllers/auth_controller.ex
@visitor_network_default Application.compile_env(:grappa, :visitor_network)
@max_per_ip_default Application.compile_env(:grappa, :max_visitors_per_ip, 5)

defp visitor_login(conn, nick, password) do
  case VisitorLogin.login(nick, password, format_ip(conn), user_agent(conn),
                          network_slug: @visitor_network_default,
                          max_per_ip: @max_per_ip_default) do
    # ...
  end
end
```

```elixir
# lib/grappa/visitors/login.ex
@spec login(String.t(), String.t() | nil, String.t() | nil, String.t() | nil, keyword()) ::
        {:ok, login_result()} | {:error, login_error()}
def login(nick, password, ip, user_agent, opts) when is_list(opts) do
  network_slug = Keyword.fetch!(opts, :network_slug)
  max_per_ip = Keyword.fetch!(opts, :max_per_ip)
  # ... rest reads from these locals
end
```

This is mechanically intrusive — touches every test that calls `Visitors.Login.login/4`. Worth the rule compliance.

- [ ] **Step 23.3: Refactor Login.login signature + commit**

```bash
git add config/config.exs config/runtime.exs lib/grappa_web/controllers/auth_controller.ex \
        lib/grappa/visitors/login.ex test/grappa/visitors/login_test.exs \
        test/grappa_web/controllers/auth_controller_test.exs
git commit -m "$(cat <<'EOF'
chore(config): wire :visitor_network + :max_visitors_per_ip via env

Per CLAUDE.md "Application.get_env is boot-time only, runtime banned":
- compile_env reads at controller module level
- Login.login/5 takes :network_slug + :max_per_ip as opts
- Tests setup via Application.put_env at boot-time (init compile pass)
EOF
)"
```

---

## Phase 7 — UI

### Task 24: cicchetto Login.tsx — single identifier + optional password

**Files:**
- Modify: `cicchetto/src/Login.tsx`
- Modify: `cicchetto/src/lib/auth.ts`

- [ ] **Step 24.1: Update Login.tsx**

```tsx
// cicchetto/src/Login.tsx
import { Component, createSignal } from "solid-js";
import { login as performLogin } from "./lib/auth";

const Login: Component = () => {
  const [identifier, setIdentifier] = createSignal("");
  const [password, setPassword] = createSignal("");
  const [error, setError] = createSignal<string | null>(null);
  const [pending, setPending] = createSignal(false);

  const submit = async (e: Event) => {
    e.preventDefault();
    setError(null);
    setPending(true);

    const result = await performLogin(identifier(), password() || null);

    setPending(false);

    if (result.ok) {
      // post-login navigation handled by App via subject.kind
    } else {
      setError(result.error);
    }
  };

  return (
    <form onSubmit={submit} class="login-form">
      <label>
        Nick or email:
        <input
          type="text"
          value={identifier()}
          onInput={(e) => setIdentifier(e.currentTarget.value)}
          autocomplete="username"
          required
        />
      </label>
      <label>
        Password (optional for visitors):
        <input
          type="password"
          value={password()}
          onInput={(e) => setPassword(e.currentTarget.value)}
          autocomplete="current-password"
        />
      </label>
      <button type="submit" disabled={pending()}>
        {pending() ? "Connecting…" : "Login"}
      </button>
      {error() && <div class="error" role="alert">{error()}</div>}
    </form>
  );
};

export default Login;
```

- [ ] **Step 24.2: Update auth.ts**

```typescript
// cicchetto/src/lib/auth.ts
type Subject = { kind: "user"; id: string; name: string }
              | { kind: "visitor"; id: string; nick: string; network_slug: string };

type LoginResponse = { token: string; subject: Subject };
type LoginResult = { ok: true; token: string; subject: Subject } | { ok: false; error: string };

export async function login(identifier: string, password: string | null): Promise<LoginResult> {
  const body: Record<string, string> = { identifier };
  if (password) body.password = password;

  const r = await fetch("/auth/login", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body)
  });

  if (!r.ok) {
    const errBody = await r.json().catch(() => ({ error: "unknown" }));
    return { ok: false, error: errBody.error || `HTTP ${r.status}` };
  }

  const data: LoginResponse = await r.json();
  localStorage.setItem("token", data.token);
  localStorage.setItem("subject", JSON.stringify(data.subject));
  return { ok: true, token: data.token, subject: data.subject };
}

export function getSubject(): Subject | null {
  const raw = localStorage.getItem("subject");
  return raw ? JSON.parse(raw) : null;
}

export function logout() {
  localStorage.removeItem("token");
  localStorage.removeItem("subject");
}
```

- [ ] **Step 24.3: Build + smoke**

```bash
scripts/bun.sh build
```

Expected: clean build.

- [ ] **Step 24.4: Commit**

```bash
git add cicchetto/src/Login.tsx cicchetto/src/lib/auth.ts
git commit -m "$(cat <<'EOF'
feat(cicchetto): single-field Login + subject-aware auth state

Login.tsx renders one identifier field + optional password — no mode
tabs. auth.ts sends {identifier, password?} matching new server wire
shape; stores token + subject in localStorage. getSubject() exposes
{kind, ...} for App-level routing (visitor-only UI elements, etc.).
EOF
)"
```

---

### Task 25: cicchetto subject-aware UI elements (visitor expires_at badge optional)

**Files:**
- Modify: `cicchetto/src/App.tsx` (only if visitor-specific UI is in scope)

**Decision pin:** v1 of this cluster does NOT add a visitor expires_at countdown badge. The sliding-TTL is invisible to the user — server bumps on every authenticated request, so practical UX is "session never expires while you're using it." Defer visible expiry-badge to a polish PR if user testing surfaces a need.

- [ ] **Step 25.1: Add subject branching for /me redirect**

App boot reads `getSubject()` and routes accordingly:

```tsx
// cicchetto/src/App.tsx — add at app entry
import { getSubject } from "./lib/auth";

const App: Component = () => {
  const subject = getSubject();
  if (!subject) return <Login />;
  // ... existing app shell
};
```

- [ ] **Step 25.2: Commit**

```bash
git add cicchetto/src/App.tsx
git commit -m "$(cat <<'EOF'
feat(cicchetto): boot routes to Login when no subject in localStorage

Subject-aware boot — hydrates from localStorage, routes to login on
empty. Subject kind not yet branched on UI shape (deferred to polish
PR if visitor expiry-badge or per-mode UI hints become needed).
EOF
)"
```

---

### Task 25.5: Visitor logout terminates Session.Server

**Files:**
- Modify: `lib/grappa_web/controllers/auth_controller.ex` (extend `logout/2`)
- Test: extend `test/grappa_web/controllers/auth_controller_test.exs`

Memory pin: "Visitor logout: clear cookie + kill Session.Server. Visitor row STAYS for scrollback preservation." Cookie part is moot (Reading C — no cookies). Kill-Session.Server part lands here. Visitor row deletion remains Reaper-only — re-login with same nick reattaches existing scrollback within sliding TTL.

- [ ] **Step 25.5.1: Failing test**

```elixir
# test/grappa_web/controllers/auth_controller_test.exs — add describe
describe "DELETE /auth/logout for visitor" do
  setup do
    {:ok, fake_irc} = IRCServer.start_link()
    network = insert(:network, slug: "azzurra")

    insert(:network_server,
      network: network,
      host: "127.0.0.1",
      port: IRCServer.port(fake_irc),
      tls: false,
      enabled: true,
      priority: 0
    )

    Application.put_env(:grappa, :visitor_network, "azzurra")
    on_exit(fn -> Application.delete_env(:grappa, :visitor_network) end)

    {:ok, fake_irc: fake_irc, network: network}
  end

  test "kills Session.Server but visitor row stays for scrollback",
       %{conn: conn, fake_irc: fake_irc, network: network} do
    IRCServer.auto_accept(fake_irc)

    {:ok, %{visitor: visitor, token: token}} =
      Visitors.Login.login("vjt", nil, "1.2.3.4", "ua",
        network_slug: "azzurra",
        max_per_ip: 5,
        timeout_ms: 5_000
      )

    assert {:ok, pid} = Session.lookup({:visitor, visitor.id}, network.id)
    assert Process.alive?(pid)

    conn
    |> put_req_header("authorization", "Bearer #{token}")
    |> delete(~p"/auth/logout")
    |> response(:no_content)

    eventually(fn ->
      assert :error = Session.lookup({:visitor, visitor.id}, network.id)
    end)

    # Visitor row stays — scrollback preservation per memory pin.
    assert Repo.reload!(visitor)
  end

  test "mode-1 logout does NOT touch any Session.Server", %{conn: conn} do
    user = insert(:user)
    {:ok, session} = Accounts.create_session({:user, user.id}, "1.2.3.4", "ua")

    conn
    |> put_req_header("authorization", "Bearer #{session.id}")
    |> delete(~p"/auth/logout")
    |> response(:no_content)

    # Session row revoked.
    assert is_nil(Repo.get(Accounts.Session, session.id))
  end

  test "visitor logout when network slug no longer configured logs + 204",
       %{conn: conn, fake_irc: fake_irc, network: network} do
    IRCServer.auto_accept(fake_irc)

    {:ok, %{visitor: visitor, token: token}} =
      Visitors.Login.login("vjt", nil, "1.2.3.4", "ua",
        network_slug: "azzurra",
        max_per_ip: 5,
        timeout_ms: 5_000
      )

    # Drop the network row mid-session (degenerate case)
    Repo.delete!(network)

    log =
      ExUnit.CaptureLog.capture_log(fn ->
        conn
        |> put_req_header("authorization", "Bearer #{token}")
        |> delete(~p"/auth/logout")
        |> response(:no_content)
      end)

    assert log =~ "visitor logout but network not found"
    assert Repo.reload!(visitor)
  end
end
```

- [ ] **Step 25.5.2: Implement logout extension**

```elixir
# lib/grappa_web/controllers/auth_controller.ex
alias Grappa.{Networks, Session, Visitors}

@spec logout(Plug.Conn.t(), map()) :: Plug.Conn.t()
def logout(conn, _) do
  :ok = maybe_kill_visitor_session(conn.assigns)
  :ok = Accounts.revoke_session(conn.assigns.current_session_id)
  send_resp(conn, :no_content, "")
end

@spec maybe_kill_visitor_session(map()) :: :ok
defp maybe_kill_visitor_session(%{current_visitor: %Visitors.Visitor{} = visitor}) do
  case Networks.get_by_slug(visitor.network_slug) do
    %Networks.Network{id: network_id} ->
      _ = Session.stop_session({:visitor, visitor.id}, network_id)
      :ok

    nil ->
      Logger.warning("visitor logout but network not found",
        visitor: visitor.id,
        slug: visitor.network_slug
      )

      :ok
  end
end

defp maybe_kill_visitor_session(_assigns), do: :ok
```

`Session.stop_session/2` already exists (used by `Visitors.Login` for timeout teardown in Task 9). Verify return contract — should be `:ok | {:error, :not_found}`. The `_ =` discard is intentional: a stopped-or-already-gone session is fine; the visitor row stays regardless.

- [ ] **Step 25.5.3: Run tests**

```bash
scripts/test.sh test/grappa_web/controllers/auth_controller_test.exs
```

Expected: 3 passes for the new describe.

- [ ] **Step 25.5.4: Run all gates**

```bash
scripts/check.sh
```

- [ ] **Step 25.5.5: Commit**

```bash
git add lib/grappa_web/controllers/auth_controller.ex \
        test/grappa_web/controllers/auth_controller_test.exs
git commit -m "$(cat <<'EOF'
feat(auth): visitor logout terminates Session.Server

DELETE /auth/logout for a visitor session now also calls
Session.stop_session({:visitor, id}, network_id) so the upstream IRC
connection drops cleanly. The visitor row STAYS — scrollback
preservation per pinned design (re-login with same nick within sliding
TTL reattaches to existing scrollback).

Mode-1 logout unchanged — still revokes only the accounts.session row.
Degenerate case (network row deleted between login and logout) logs a
warning + still returns 204; the visitor row is left for the Reaper /
operator's `mix grappa.reap_visitors` recovery path.
EOF
)"
```

---

## Phase 8 — Smoke + ship

### Task 26: Browser smoke test (manual checklist)

**Worktree:** `~/code/IRC/grappa-task-visitor-auth`. Code merged to main BEFORE deploy.

- [ ] **Step 26.1: Local dev verify**

```bash
scripts/check.sh                    # all gates green
scripts/mix.sh ecto.migrate         # local migrations applied
scripts/observer.sh                 # confirm Reaper + Bootstrap children alive
```

- [ ] **Step 26.2: Browser smoke checklist**

In a real browser at `http://grappa.bad.ass`:

| # | Scenario | Expected |
|---|----------|----------|
| 1 | Anon login — type nick, no password → submit | Connects, joins no channels, scrollback empty, expires_at = now+48h |
| 2 | Registered login — type nick + correct password → submit | Connects, +r observed, password committed to DB, expires_at = now+7d |
| 3 | Wrong-password login — type nick + wrong password → submit | Connects (HTTP 200), stays anon (no +r ever), `password_encrypted` stays null in DB after 10s, no failure-path UX |
| 4 | Reconnect with cached password + nick collision | First /quit + reconnect path: NICK 433 → underscore-append + GHOST + WHOIS → 401 → /nick + IDENTIFY succeeds |
| 5 | Sliding TTL bump | Every HTTP request bumps expires_at if ≥1h since last bump (verify in DB) |
| 6 | Per-IP cap | Set `GRAPPA_MAX_VISITORS_PER_IP=2`, attempt 3rd login from same IP → 429 |
| 7 | `mix grappa.reap_visitors --network=ghosted` | Removes orphaned rows; Bootstrap stops complaining |
| 8 | Reaper sweep | Manually set a visitor's expires_at to past → wait 60s → row gone, scrollback wiped |
| 9 | Visitor logout | Click logout → DELETE /auth/logout returns 204 → Session.Server gone (verify via `scripts/observer.sh`) → visitor row STAYS in DB → re-login with same nick reattaches existing scrollback |

- [ ] **Step 26.3: Document any deviations as W-cluster wrinkles in this file**

Don't ship past a smoke-test failure. HALT.

---

### Task 27: Code review subagent

- [ ] **Step 27.1: Dispatch review per `docs/reviewing.md`**

```bash
# In another tmux pane / IDE
/review
```

- [ ] **Step 27.2: Address MUST + SHOULD findings**

Per orchestrate task HALT condition: any MUST or SHOULD finding = HALT for vjt input.

CONSIDER findings: address inline if cheap, log to todo if Phase 5 hardening shape.

- [ ] **Step 27.3: Re-review until clean**

---

### Task 28: Merge + deploy + push + checkpoint entry

- [ ] **Step 28.1: Rebase worktree onto main**

```bash
git fetch origin
git rebase main   # from inside the visitor-auth worktree
```

- [ ] **Step 28.2: Merge to main**

```bash
git checkout main
git merge --no-ff cluster/visitor-auth
```

- [ ] **Step 28.3: Deploy**

```bash
scripts/deploy.sh
```

- [ ] **Step 28.4: Health check (prod)**

```bash
GRAPPA_PROD=1 scripts/healthcheck.sh
```

- [ ] **Step 28.5: Browser re-verify in prod**

Re-run the 8-scenario smoke checklist on `http://grappa.bad.ass`.

- [ ] **Step 28.6: Push**

```bash
git push origin main
```

- [ ] **Step 28.7: CP entry (per S19 LANDED template)**

Append a new SXX entry to `docs/checkpoints/2026-04-27-cp10.md` (or rotate to CP11 if cp10 over 200 lines — likely rotate). Document:
- Cluster name + branch + LANDED date
- Commits enumerated
- Smoke-test outcomes
- Any defer-to-Phase-5 items added to todo.md
- Memory updates if any pinned designs need persisting

- [ ] **Step 28.8: Worktree cleanup**

```bash
git worktree remove ~/code/IRC/grappa-task-visitor-auth
git branch -d cluster/visitor-auth
```

- [ ] **Step 28.9: Update todo.md**

Remove visitor-auth entry from Immediate. Add Phase 5 hardening item: "HttpOnly cookie + CSRF retrofit if XSS posture deteriorates / untrusted-browser scenarios bite (per cluster/visitor-auth deferred-decision)."

- [ ] **Step 28.10: Final commit**

```bash
git add docs/checkpoints/<file>.md docs/todo.md
git commit -m "$(cat <<'EOF'
docs(cp10|cp11): visitor-auth cluster LANDED

[full LANDED template per S19 — commits enumerated, smoke verified,
todo updated, checkpoint rotated if needed]
EOF
)"
git push origin main
```

---

## Self-review checklist

After completing all tasks, the executing engineer (or a code-reviewer subagent) verifies:

- [ ] **Spec coverage:** Every pinned decision (W1-W9, Q-A through Q-H) has a corresponding task. Walk the table from "Pinned decisions" and point to the task that implements each.
- [ ] **Placeholder scan:** No "TBD", "fill in", "similar to Task N" without code, no error-handling bullets without code.
- [ ] **Type consistency:** `Visitors.commit_password/2` signature matches the EventRouter effect tuple `{:visitor_r_observed, password}`. `Visitors.SessionPlan.resolve/1` output shape matches `Session.start_session/3` opts. `Accounts.create_session/3` takes `subject` tuple consistently across all callsites.
- [ ] **Boundary deps:** `Grappa.Visitors`, `Grappa.Auth`, `Grappa.Session`, `Grappa.Accounts` Boundary annotations align with actual `import`/`alias` use.
- [ ] **No `\\` defaults** in any new function. Verified by `grep '\\\\\\\\\\b' lib/grappa/visitors/ lib/grappa/auth/ lib/grappa/session/`.
- [ ] **Tests use production code** — no hardcoded JSON in fixtures, no re-implementing `Visitors.commit_password` in tests.
- [ ] **CLAUDE.md "Application.get_env runtime banned"** — verified Visitors.Login + AuthController don't read env at runtime.

---

## Cluster exit criteria

Per orchestrate task, full LANDED requires:

1. ✅ Plan written, accepted by vjt, all wrinkles pinned (this document).
2. Implementation complete per all 29 tasks (1-25, 25.5, 26-28).
3. `scripts/check.sh` green (zero warnings, all gates).
4. Browser smoke 9-scenario checklist (Task 26) all green.
5. Code review PASS (no MUST or SHOULD findings).
6. Merged to main.
7. Deployed via `scripts/deploy.sh`.
8. CP entry on main per S19 LANDED template.
9. Origin pushed.
10. Worktree + branch cleaned up.
