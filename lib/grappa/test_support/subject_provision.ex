if Mix.env() in [:dev, :test] do
  defmodule Grappa.TestSupport.SubjectProvision do
    @moduledoc """
    Test-only orchestrator that CREATES a complete, isolated subject —
    user + network credential + seeded scrollback + settled
    `Session.Server` + bearer token — and tears it down again.
    Compile-gated to `:dev` and `:test` Mix envs; the module literally
    does not exist in the prod release.

    Wired via `POST /admin/test/subject` +
    `DELETE /admin/test/subject/:name`
    (`GrappaWeb.Admin.TestSubjectController`).

    ## Why this exists (GH #1078)

    Its predecessor, `Grappa.TestSupport.SubjectReset`, isolated specs
    by *restoring one shared subject to a baseline*: an enumerated list
    of surfaces to drain, plus a truncate-and-re-seed of an enumerated
    list of channels. That can only clean what somebody remembered to
    enumerate, and the list grew by accretion — #364 wired
    `Notify.clear_all_for_user/1` with the comment "dead code until
    now", i.e. a hole that existed until it bit. #1078 measured a second
    one: `$server`, the pseudo-channel the reset's OWN reconnect writes
    its notices into, is outside the baseline and so grew +14 rows per
    reset, ~5000 over a 375-spec suite.

    A fresh subject has no such list. Every surface the drain used to
    enumerate — read cursors, query windows, push subscriptions, user
    settings, uploads, notify entries, WS presence, scrollback, the
    credential's channel lists — is keyed by `user_id`, so a user
    created a millisecond ago is empty on all of them **by
    construction**, including the ones nobody has thought of yet.

    ## What "provisioned" means

    `provision!/1` returns only once the subject is usable the way the
    seeded one was: the credential's `Session.Server` has received
    RPL_WELCOME, every autojoin channel has reached `:joined`, the
    requested scrollback is in the DB, and a bearer token exists. The
    settle semantics are shared with the reset path via
    `Grappa.TestSupport.SubjectSession` — a provisioned subject and a
    reset subject are settled to the same definition, or they are not
    comparable.

    ## Failure leaves nothing behind

    A failure after the user row exists deletes it before returning the
    error. A half-provisioned subject would be worse than none: it
    would sit in `/admin/users` and `/admin/sessions` for the rest of
    the run and quietly change what every later spec observes there.
    The error itself is always returned — cleanup is not swallowing.
    """

    use Boundary,
      top_level?: true,
      deps: [
        Grappa.Accounts,
        Grappa.Networks,
        Grappa.TestSupport.SubjectSession
      ]

    import Grappa.TestSupport.SubjectSession, only: [measure: 1]

    alias Grappa.{Accounts, Networks, TestSupport.SubjectSession}

    require Logger

    @type channel_seed :: %{
            required(:name) => String.t(),
            required(:seed_count) => non_neg_integer(),
            required(:seed_sender) => String.t()
          }

    @type params :: %{
            required(:name) => String.t(),
            required(:password) => String.t(),
            required(:network_slug) => String.t(),
            required(:nick) => String.t(),
            required(:autojoin_channels) => [String.t()],
            required(:seed) => [channel_seed()]
          }

    @typedoc """
    Wall-clock of each span a provision spends time in, milliseconds.
    Same contract as the reset's: `total_ms` minus the parts is the
    unattributed remainder, so a slow provision always has somewhere to
    land.
    """
    @type phases :: %{
            create_ms: non_neg_integer(),
            bind_ms: non_neg_integer(),
            seed_ms: non_neg_integer(),
            settle_ms: non_neg_integer(),
            token_ms: non_neg_integer(),
            total_ms: non_neg_integer()
          }

    @type result :: %{user: Accounts.User.t(), token: String.t(), phases: phases()}

    @type provision_error ::
            {:network_not_found, String.t()}
            | {:user_invalid, Ecto.Changeset.t()}
            | {:credential_invalid, Ecto.Changeset.t()}
            | {:reconnect_timeout, String.t()}
            | {:reconnect_failed, String.t(), term()}
            | {:autojoin_timeout, String.t(), [String.t()]}
            | {:token_failed, term()}

    @doc """
    Creates and settles a complete subject.

    Returns `{:ok, result}` with the user row, its bearer token, and
    the per-span wall-clock, or `{:error, reason}` having already
    removed whatever it had created.

    The credential is bound with `auth_method: :none` — the e2e testnet
    upstreams take no upstream auth, and a provisioning verb that could
    carry a password would be a credential-minting surface, which this
    is not.
    """
    @spec provision!(params()) :: {:ok, result()} | {:error, provision_error()}
    def provision!(%{name: name, network_slug: slug} = params)
        when is_binary(name) and is_binary(slug) do
      started_at = System.monotonic_time(:millisecond)

      case Networks.get_network_by_slug(slug) do
        {:ok, network} -> create_then_settle(params, network, started_at)
        {:error, :not_found} -> {:error, {:network_not_found, slug}}
      end
    end

    defp create_then_settle(params, network, started_at) do
      {create_ms, created} =
        measure(fn ->
          Accounts.create_user(%{name: params.name, password: params.password})
        end)

      case created do
        {:ok, user} -> bind_then_settle(params, network, user, create_ms, started_at)
        {:error, changeset} -> {:error, {:user_invalid, changeset}}
      end
    end

    defp bind_then_settle(params, network, user, create_ms, started_at) do
      {bind_ms, bound} =
        measure(fn ->
          Networks.Credentials.bind_credential(user, network, %{
            nick: params.nick,
            auth_method: :none,
            autojoin_channels: params.autojoin_channels
          })
        end)

      case bound do
        {:ok, cred} ->
          seed_then_settle(params, user, cred, %{create_ms: create_ms, bind_ms: bind_ms}, started_at: started_at)

        {:error, changeset} ->
          rollback(user, {:credential_invalid, changeset})
      end
    end

    defp seed_then_settle(params, user, cred, acc, started_at: started_at) do
      {seed_ms, :ok} = measure(fn -> seed_all(user, cred, params.seed) end)
      {settle_ms, {settle, outcome}} = measure(fn -> SubjectSession.start_and_settle(user, cred) end)

      Logger.info(
        "subject provision settle",
        [user: user.name, network: cred.network.slug, outcome: outcome_tag(outcome)] ++
          Enum.sort(Map.to_list(settle))
      )

      case outcome do
        :ok ->
          mint_token(user, Map.merge(acc, %{seed_ms: seed_ms, settle_ms: settle_ms}), started_at)

        {:error, reason} ->
          rollback(user, reason)
      end
    end

    defp mint_token(user, acc, started_at) do
      {token_ms, minted} =
        measure(fn -> Accounts.create_session({:user, user.id}, nil, nil, []) end)

      case minted do
        {:ok, session} ->
          phases =
            acc
            |> Map.put(:token_ms, token_ms)
            |> Map.put(:total_ms, System.monotonic_time(:millisecond) - started_at)

          {:ok, %{user: user, token: session.id, phases: phases}}

        {:error, reason} ->
          rollback(user, {:token_failed, reason})
      end
    end

    defp seed_all(_, _, []), do: :ok

    defp seed_all(user, cred, [%{name: name, seed_count: count, seed_sender: sender} | rest]) do
      :ok = SubjectSession.seed_channel(user.id, cred.network_id, name, count, sender)
      seed_all(user, cred, rest)
    end

    @doc """
    Removes the subject named `name`: unbinds every credential (which
    stops the live `Session.Server` synchronously) and then deletes the
    user row, taking its scrollback, cursors, windows, settings,
    uploads, notify entries and bearer sessions with it by FK cascade.

    Unbind BEFORE delete on purpose. `Accounts.delete_user/1` does not
    stop the session — it relies on the child crashing on its next
    mailbox call and its init-gate then draining the registry, which is
    eventually-consistent. A test teardown must be done when it
    returns, or the next spec's `/admin/sessions` sees a ghost.

    Returns `{:error, :user_not_found}` for an unknown name — the
    caller asked to remove something that is not there, and a teardown
    that cannot find its subject is a bug worth surfacing, not a no-op.
    """
    @spec teardown!(String.t()) :: :ok | {:error, :user_not_found | :last_admin}
    def teardown!(name) when is_binary(name) do
      case Accounts.get_user_by_name(name) do
        nil ->
          {:error, :user_not_found}

        user ->
          user
          |> Networks.Credentials.list_credentials_for_user()
          |> Enum.each(fn cred -> :ok = Networks.Credentials.unbind_credential(user, cred.network) end)

          Accounts.delete_user(user)
      end
    end

    # A failed provision must not leave a user row behind: it would show
    # up in every later spec's /admin/users and /admin/sessions view.
    # The original error is what gets returned — the cleanup is silent,
    # the failure is not.
    defp rollback(user, reason) do
      _ = teardown!(user.name)
      {:error, reason}
    end

    defp outcome_tag(:ok), do: :ok
    defp outcome_tag({:error, reason}), do: inspect(reason)
  end
end
