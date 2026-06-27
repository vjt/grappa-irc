defmodule Grappa.Session.NSInterceptor do
  @moduledoc """
  Pure module: matches an outbound IRC wire line for any NickServ-account
  identify verb that carries a password, and lifts the password out for the
  host (`Grappa.Session.Server`) to stage in `pending_auth`. Captures are
  committed to the visitor row ONLY on +r MODE observation (or discarded on
  the `@pending_auth_timeout_ms` timeout). Wrong passwords never touch the DB.

  Covers the full azzurra identify-channel set (source-verified against
  `bahamut-azzurra` ircd + azzurra `services`):

    * `PRIVMSG NickServ[@host] :IDENTIFY|ID|SIDENTIFY|GHOST|REGISTER <args>`
    * `NS|NICKSERV IDENTIFY|ID|SIDENTIFY|GHOST|REGISTER <args>`   (services command alias)
    * `IDENTIFY|ID|SIDENTIFY <args>`                    (ircd `m_identify`)
    * `PASS <args>`                                     (ircd `m_pass` -> `m_identify`, post-connect)

  Every pattern is ANCHORED at line start (`^`) so a channel PRIVMSG body that
  merely CONTAINS "identify"/"pass" is never captured — raw IRC frames start
  with the command verb, PRIVMSGs start with `PRIVMSG`.

  Password extraction: last whitespace token for IDENTIFY/ID/SIDENTIFY/GHOST/
  PASS (`IDENTIFY [account] <pass>`, `GHOST <nick> <pass>`, `PASS [nick] <pass>`);
  FIRST token for REGISTER (`REGISTER <pass> <email>`).

  Boundary: inherits the parent `Grappa.Session` boundary (no `use Boundary`).
  """

  @type result :: :passthrough | {:capture, String.t()}

  # PRIVMSG-to-NickServ / NS-NICKSERV command form. `(?:...)` groups are
  # non-capturing; capture groups are (verb, rest).
  @verb_re ~r/^(?:PRIVMSG\s+NickServ(?:@\S+)?\s+:|(?:NS|NICKSERV)\s+)(IDENTIFY|ID|SIDENTIFY|GHOST|REGISTER)\s+(\S.*?)\s*$/i

  # Bare ircd command form (m_identify).
  @bare_re ~r/^(IDENTIFY|ID|SIDENTIFY)\s+(\S.*?)\s*$/i

  # PASS post-connect identify (m_pass -> m_identify).
  @pass_re ~r/^PASS\s+(\S.*?)\s*$/i

  @spec intercept(String.t()) :: result()
  def intercept(line) when is_binary(line) do
    case Regex.run(@verb_re, line, capture: :all_but_first) do
      [verb, rest] -> dispatch(String.upcase(verb), rest)
      nil -> intercept_bare(line)
    end
  end

  defp intercept_bare(line) do
    case Regex.run(@bare_re, line, capture: :all_but_first) do
      [verb, rest] -> dispatch(String.upcase(verb), rest)
      nil -> intercept_pass(line)
    end
  end

  defp intercept_pass(line) do
    case Regex.run(@pass_re, line, capture: :all_but_first) do
      [rest] -> {:capture, last_token(rest)}
      nil -> :passthrough
    end
  end

  defp dispatch("REGISTER", rest), do: {:capture, first_token(rest)}
  defp dispatch(_verb, rest), do: {:capture, last_token(rest)}

  defp last_token(rest), do: rest |> String.split() |> List.last()
  defp first_token(rest), do: rest |> String.split() |> List.first()
end
