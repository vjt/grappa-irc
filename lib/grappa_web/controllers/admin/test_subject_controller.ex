if Mix.env() in [:dev, :test] do
  defmodule GrappaWeb.Admin.TestSubjectController do
    @moduledoc """
    Test-only admin endpoints that create and destroy a complete,
    isolated subject (delegates to
    `Grappa.TestSupport.SubjectProvision`). Compile-gated to `:dev` and
    `:test` envs; module + routes literally do not exist in the prod
    release.

    Wired at `POST /admin/test/subject` and
    `DELETE /admin/test/subject/:name` under the
    `[:api, :authn, :admin_authn]` pipeline — an admin bearer is
    required, same as every other `/admin` route.

    This is the #1078 replacement for `POST /admin/test/reset-subject`:
    the e2e suite stops restoring one shared subject to a baseline and
    starts giving every spec its own. See
    `Grappa.TestSupport.SubjectProvision` for why.

    Create body:

        {"name": "s3f9a1", "password": "…", "network_slug": "bahamut-test",
         "nick": "s3f9a1", "autojoin_channels": ["#bofh"],
         "seed": [{"name": "#bofh", "seed_count": 200, "seed_sender": "seed-bot"}]}

    Every field is required. There is no default for any of them: a
    provisioning verb that silently substitutes a channel, a nick or a
    seed depth would hand the caller a subject that is not the one it
    asked for, and the spec would assert against the difference.

    201 body is `{token, subject: {kind, id, name}, phases}` — the same
    `subject` envelope `POST /auth/login` returns, so a caller can hand
    it to the client bootstrap unchanged, plus the per-span wall-clock
    (#934's contract, carried over from the reset).
    """
    use GrappaWeb, :controller

    alias Grappa.TestSupport.SubjectProvision

    # `use GrappaWeb, :controller` already installs
    # `GrappaWeb.FallbackController`; the changeset arms below return
    # `{:error, changeset}` into it.

    @spec create(Plug.Conn.t(), map()) :: Plug.Conn.t() | {:error, Ecto.Changeset.t()}
    @doc """
    `POST /admin/test/subject` — provision a fresh subject.

    Inline error dispatch for everything the FallbackController cannot
    name (network slug, reconnect timeout, autojoin timeout); changeset
    failures go through the fallback so their 422 shape matches the
    rest of the admin surface.
    """
    def create(conn, params) do
      case parse_create(params) do
        {:ok, parsed} -> dispatch_provision(conn, parsed)
        :error -> conn |> put_status(:unprocessable_entity) |> json(%{error: "invalid_params"})
      end
    end

    defp dispatch_provision(conn, parsed) do
      case SubjectProvision.provision!(parsed) do
        {:ok, %{user: user, token: token, phases: phases}} ->
          conn
          |> put_status(:created)
          |> json(%{
            token: token,
            subject: %{kind: "user", id: user.id, name: user.name},
            phases: phases
          })

        {:error, {:network_not_found, slug}} ->
          conn
          |> put_status(:not_found)
          |> json(%{error: "network_not_found", network_slug: slug})

        {:error, {:user_invalid, changeset}} ->
          {:error, changeset}

        {:error, {:credential_invalid, changeset}} ->
          {:error, changeset}

        {:error, {:reconnect_timeout, slug}} ->
          conn
          |> put_status(:gateway_timeout)
          |> json(%{error: "session_reconnect_timeout", network_slug: slug})

        {:error, {:autojoin_timeout, slug, channels}} ->
          conn
          |> put_status(:gateway_timeout)
          |> json(%{error: "autojoin_timeout", network_slug: slug, missing_channels: channels})

        {:error, {:reconnect_failed, slug, reason}} ->
          conn
          |> put_status(:internal_server_error)
          |> json(%{error: "session_reconnect_failed", network_slug: slug, reason: inspect(reason)})

        {:error, {:token_failed, reason}} ->
          conn
          |> put_status(:internal_server_error)
          |> json(%{error: "token_failed", reason: inspect(reason)})
      end
    end

    @spec delete(Plug.Conn.t(), map()) :: Plug.Conn.t()
    @doc """
    `DELETE /admin/test/subject/:name` — unbind every credential (which
    stops the live session) and delete the user with everything the FK
    cascade takes.

    404 on an unknown name rather than an idempotent 204: a teardown
    that cannot find the subject it provisioned is a bug in the
    fixture, and swallowing it hides the leak it is reporting.
    """
    def delete(conn, %{"name" => name}) when is_binary(name) do
      case SubjectProvision.teardown!(name) do
        :ok ->
          conn |> put_status(:no_content) |> text("")

        {:error, :user_not_found} ->
          conn |> put_status(:not_found) |> json(%{error: "user_not_found", name: name})

        {:error, :last_admin} ->
          conn |> put_status(:unprocessable_entity) |> json(%{error: "last_admin", name: name})
      end
    end

    # Every field required, no defaults — see the moduledoc. `seed` may
    # be an empty list (a spec that wants no scrollback says so), but it
    # may not be absent.
    defp parse_create(%{
           "name" => name,
           "password" => password,
           "network_slug" => slug,
           "nick" => nick,
           "autojoin_channels" => autojoin,
           "seed" => seed
         })
         when is_binary(name) and is_binary(password) and is_binary(slug) and is_binary(nick) and
                is_list(autojoin) and is_list(seed) do
      with true <- Enum.all?(autojoin, &is_binary/1),
           {:ok, parsed_seed} <- parse_seed(seed, []) do
        {:ok,
         %{
           name: name,
           password: password,
           network_slug: slug,
           nick: nick,
           autojoin_channels: autojoin,
           seed: parsed_seed
         }}
      else
        _ -> :error
      end
    end

    defp parse_create(_), do: :error

    defp parse_seed([], acc), do: {:ok, Enum.reverse(acc)}

    defp parse_seed(
           [%{"name" => name, "seed_count" => count, "seed_sender" => sender} = entry | rest],
           acc
         )
         when is_binary(name) and is_integer(count) and count >= 0 and is_binary(sender) and
                byte_size(sender) > 0 do
      with {:ok, gap} <- parse_seed_gap(entry) do
        seed = %{name: name, seed_count: count, seed_sender: sender}
        parse_seed(rest, [put_seed_gap(seed, gap) | acc])
      end
    end

    defp parse_seed(_, _), do: :error

    # #2311 — optional per-channel spacing. Absent keeps the ~20s default
    # every scroll spec is calibrated against; a value must be a positive
    # integer, so a typo is a 422 and not a silently dense corpus.
    defp parse_seed_gap(%{"seed_gap_ms" => gap}) when is_integer(gap) and gap > 0, do: {:ok, gap}
    defp parse_seed_gap(%{"seed_gap_ms" => _}), do: :error
    defp parse_seed_gap(_entry), do: {:ok, nil}

    defp put_seed_gap(seed, nil), do: seed
    defp put_seed_gap(seed, gap), do: Map.put(seed, :seed_gap_ms, gap)
  end
end
