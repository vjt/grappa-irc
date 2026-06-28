defmodule Grappa.Session.NSInterceptor do
  @moduledoc """
  Pure module: matches an outbound IRC wire line for any NickServ-account
  identify verb that carries a password, and lifts the password out for the
  host (`Grappa.Session.Server`) to stage. The result carries a `kind`
  (`:identify | :register`) so the host can pick the right retention slot:
  IDENTIFY-family captures stage the TIMED `pending_auth`; REGISTER captures
  stage the UNTIMED `pending_registration_secret` (#129 — register grants
  +r minutes-to-hours later, outside the 10s window). Captures are committed
  to the visitor row ONLY on +r MODE observation (the timed slot is also
  discarded on the `@pending_auth_timeout_ms` timeout). Wrong passwords never
  touch the DB.

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

  @typedoc """
  The captured verb's class. `:identify` covers IDENTIFY/ID/SIDENTIFY/
  GHOST/PASS — services grant +r synchronously (within the 10s window),
  so the host stages a TIMED `pending_auth`. `:register` is the
  register→auth-code flow (#129): services email an auth code and grant
  +r minutes-to-hours later, far outside that window, so the host stages
  an UNTIMED `pending_registration_secret`. The host maps verb → slot;
  the interceptor only reports which verb it saw.
  """
  @type kind :: :identify | :register

  @type result :: :passthrough | {:capture, kind(), String.t()}

  # PRIVMSG-to-NickServ / NS-NICKSERV command form. `(?:...)` groups are
  # non-capturing; capture groups are (verb, rest).
  @verb_re ~r/^(?:PRIVMSG\s+NickServ(?:@\S+)?\s+:|(?:NS|NICKSERV)\s+)(IDENTIFY|ID|SIDENTIFY|GHOST|REGISTER)\s+(\S.*?)\s*$/i

  # Bare ircd command form (m_identify).
  @bare_re ~r/^(IDENTIFY|ID|SIDENTIFY)\s+(\S.*?)\s*$/i

  # PASS post-connect identify (m_pass -> m_identify).
  @pass_re ~r/^PASS\s+(\S.*?)\s*$/i

  @doc """
  Inspects one outbound IRC wire line and returns either `:passthrough`
  (no NickServ identify verb detected) or `{:capture, kind, password}` with
  the cleartext password lifted out and the verb class (`:identify` vs
  `:register`) for the host to stage in the matching slot.

  Pure: no side effects. The host (`Grappa.Session.Server`) decides whether
  to commit (on `+r` MODE), discard on the pending-auth timeout, or
  overwrite on a subsequent capture.
  """
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
      [rest] -> {:capture, :identify, last_token(rest)}
      nil -> :passthrough
    end
  end

  # Catch-all: IDENTIFY / ID / SIDENTIFY / GHOST all take the password as
  # the last token AND grant +r synchronously → `:identify`. Only REGISTER
  # (password first, +r granted later via the auth-code) needs its own
  # clause AND its own `:register` kind (#129).
  defp dispatch("REGISTER", rest), do: {:capture, :register, first_token(rest)}
  defp dispatch(_, rest), do: {:capture, :identify, last_token(rest)}

  defp last_token(rest), do: rest |> String.split() |> List.last()
  defp first_token(rest), do: rest |> String.split() |> List.first()
end
