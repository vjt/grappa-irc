defmodule Grappa.Auth.IdentifierClassifier do
  @moduledoc """
  Classifies a login identifier as an email (mode-1 admin path) or an
  RFC2812 nick (visitor path), or rejects malformed input at the
  boundary.

  Single discriminator: `String.contains?(id, "@")`. RFC2812 forbids
  `@` in nicks → unambiguous. Email path requires minimal RFC5322-light
  shape (`x@y.z`); nick path requires full RFC2812 nick regex.

  Used by `GrappaWeb.AuthController.login/2` to dispatch to either
  `Grappa.Accounts.get_user_by_credentials/2` or `Grappa.Visitors.login/4`.
  """

  use Boundary, top_level?: true, deps: []

  @nick_re ~r/^[A-Za-z\[\]\\`_^{|}][A-Za-z0-9\[\]\\`_^{|}-]{0,29}$/
  @email_re ~r/^[^@\s]+@[^@\s]+\.[^@\s]+$/

  @type result :: {:email, String.t()} | {:nick, String.t()} | {:error, :malformed}

  @doc """
  Classifies a login identifier as an email or RFC2812 nick.

  Returns `{:email, id}` if the identifier contains `@` and matches a
  minimal RFC5322-light pattern (x@y.z). Returns `{:nick, id}` if the
  identifier is a valid RFC2812 nick. Returns `{:error, :malformed}`
  otherwise (leading digit, invalid email format, length > 30, etc.).

  ## Examples

      iex> Grappa.Auth.IdentifierClassifier.classify("user@example.com")
      {:email, "user@example.com"}

      iex> Grappa.Auth.IdentifierClassifier.classify("vjt")
      {:nick, "vjt"}

      iex> Grappa.Auth.IdentifierClassifier.classify("9invalid")
      {:error, :malformed}
  """
  @spec classify(String.t()) :: result()
  def classify(id) when is_binary(id) do
    cond do
      String.contains?(id, "@") and Regex.match?(@email_re, id) -> {:email, id}
      not String.contains?(id, "@") and Regex.match?(@nick_re, id) -> {:nick, id}
      true -> {:error, :malformed}
    end
  end
end
