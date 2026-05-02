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

  Boundary: inherits the parent `Grappa.Session` boundary — same pattern
  as sibling submodules (`Server`, `EventRouter`). No `use Boundary`
  here; consumed by `Session.Server` (same boundary), so no `exports:`
  entry needed in `Grappa.Session` either.
  """

  @type result :: :passthrough | {:capture, String.t()}

  @ns_re ~r/^PRIVMSG\s+NickServ\s+:(IDENTIFY|GHOST|REGISTER)\s+(.+?)\s*$/i

  @doc """
  Inspects one outbound IRC wire line and returns either `:passthrough`
  (no NickServ identity verb detected) or `{:capture, password}` with
  the cleartext password lifted out for the host to stage in
  `pending_auth`.

  Pure: no side effects. The host (`Grappa.Session.Server`) decides
  whether to commit, discard on +r-MODE-not-observed timeout, or
  overwrite on a subsequent capture.
  """
  @spec intercept(String.t()) :: result()
  def intercept(line) when is_binary(line) do
    case Regex.run(@ns_re, line, capture: :all_but_first) do
      nil -> :passthrough
      [verb, rest] -> dispatch(String.upcase(verb), rest)
    end
  end

  defp dispatch("IDENTIFY", rest), do: {:capture, identify_password(rest)}
  defp dispatch("GHOST", rest), do: {:capture, ghost_password(rest)}
  defp dispatch("REGISTER", rest), do: {:capture, register_password(rest)}

  defp identify_password(rest) do
    rest |> String.split() |> List.last()
  end

  defp ghost_password(rest) do
    case String.split(rest, " ", parts: 2) do
      [_, pwd] -> pwd
      [pwd] -> pwd
    end
  end

  defp register_password(rest) do
    rest |> String.split() |> List.first()
  end
end
