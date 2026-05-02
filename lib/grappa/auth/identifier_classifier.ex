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
