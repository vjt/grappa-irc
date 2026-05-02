defmodule Grappa.Visitors.SessionPlan do
  @moduledoc """
  Mirror of `Grappa.Networks.SessionPlan` for visitor-row input.
  Resolves a `%Visitor{}` + the matching network's lowest-priority
  enabled server into the primitive `t:Grappa.Session.start_opts/0`
  map for `Grappa.Session.start_session/3`.

  Visitor-specific shape:

    * `subject = {:visitor, visitor.id}`
    * `subject_label = "visitor:" <> visitor.id` (Q1=a — UUID stable
      across NickServ rename, no collision with user.name since `:`
      is invalid in user names)
    * `sasl_user = visitor.nick` (Q2=c — populated even though SASL
      never fires for visitors; visitor `auth_method` is always
      `:none | :nickserv_identify`)
    * `auth_method = :none` if `password_encrypted` is nil (anon)
    * `auth_method = :nickserv_identify` + plaintext password from
      EncryptedBinary roundtrip if registered

  Used by `Grappa.Bootstrap` (visitor respawn at boot, Task 19) and
  `Grappa.Visitors.Login` (synchronous login probe-connect, Task 9).

  Inside the `Grappa.Visitors` boundary — mirror of
  `Grappa.Networks.SessionPlan` inside `Grappa.Networks` (sibling has
  no own boundary either).
  """

  import Ecto.Query

  alias Grappa.{Networks, Repo, Session}
  alias Grappa.Networks.{NoServerError, Servers}
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
    query =
      from c in VisitorChannel,
        where: c.visitor_id == ^visitor.id and c.network_slug == ^visitor.network_slug,
        select: c.name

    autojoin = Repo.all(query)

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
