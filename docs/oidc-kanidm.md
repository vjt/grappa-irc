# Kanidm as the OIDC provider (#1911)

One page, copy-paste only. Kanidm 1.11 is the reference provider — every
command below was measured against it — but any provider with a discovery
document works; only the issuer URL changes.

## 1. The OAuth2 client

`-D idm_admin`, not `admin`: OAuth2 clients are IDM entries, and the domain
admin gets a bare `403 AccessDenied` on create (measured, 1.11.1).

```sh
kanidm login -D idm_admin
kanidm system oauth2 create grappa "Grappa" \
    "https://grappa.example.com/auth/oidc/callback" -D idm_admin
kanidm system oauth2 update-scope-map grappa idm_all_persons \
    openid profile email groups -D idm_admin
kanidm system oauth2 show-basic-secret grappa -D idm_admin   # → GRAPPA_OIDC_CLIENT_SECRET
```

The scope map on `idm_all_persons` is what lets every person reach the
consent screen; without it nobody can log in, with it nobody is admin
anywhere — see §3 and §6. `groups` is what makes Kanidm put the claim in
the `id_token` at all: leave it out and both gates of §3 read an empty
claim and refuse everyone. The client is confidential with PKCE S256 by
default, which is the posture grappa uses.

## 2. A person who can log in

```sh
kanidm person create alice "Alice" -D idm_admin
```

Finish the credential in the Kanidm web UI: password alone is refused,
because 1.11 requires MFA on person credentials by default — enroll a
TOTP too. A person without MFA cannot complete a login.

## 3. The group gates (#1911c)

Both gates are optional and default OFF; when set, they read the verified
`id_token`'s `groups` claim — never a live directory lookup, so a token
is the whole truth and its expiry is the gate's.

```sh
kanidm group create grappa_users -D idm_admin
kanidm group create grappa_admins -D idm_admin
kanidm group add-members grappa_users alice -D idm_admin
```

- **`GRAPPA_OIDC_USERS_GROUP` (Kanidm: `grappa_users`)** — who may log in.
  A member whose identity is not linked to any grappa account gets a
  passwordless account provisioned on first login, named after the
  `preferred_username` claim. A non-member who is not linked is refused
  with `not_linked`.
- **`GRAPPA_OIDC_ADMINS_GROUP` (Kanidm: `grappa_admins`)** — who is admin.
  Membership is synced to `is_admin` on every login, in both directions:
  joining the group grants, leaving revokes. Unset (the default) means
  OIDC never speaks about roles, and a hand-granted admin flag survives
  logins untouched.

grappa matches the bare name you set in the env var against the claim's
entry, which Kanidm spells as the spn (`grappa_users@<domain>`) — both
forms match, so the env var stays bare. No other group has any meaning to
grappa: a `sup-scope-map` or a claim map changes what Kanidm puts in the
token, not what grappa does with it (§6).

## 4. grappa's env vars

All seven live in `.env` (see `.env.example`); unset issuer means the OIDC
door does not exist on that deployment — no routes, no client button,
clean boot.

```sh
GRAPPA_OIDC_ISSUER=https://idm.example.com/oauth2/openid/grappa
GRAPPA_OIDC_CLIENT_ID=grappa
GRAPPA_OIDC_CLIENT_SECRET=<from show-basic-secret>
GRAPPA_OIDC_REDIRECT_URI=https://grappa.example.com/auth/oidc/callback
GRAPPA_OIDC_SCOPES=openid profile email groups   # groups only when §3 is used
GRAPPA_OIDC_USERS_GROUP=grappa_users    # optional — §3
GRAPPA_OIDC_ADMINS_GROUP=grappa_admins  # optional — §3
```

The issuer is Kanidm's per-client issuer, `<origin>/oauth2/openid/<name>`,
not the server origin. The redirect URI must be byte-identical to the one
registered above — it is never derived from the request. TLS to the
provider anchors on the system CA store: a private-CA Kanidm joins the
host's trust store, there is no skip-verification switch.

## 5. Why renames are safe

The account link is keyed on the `sub` claim alone — Kanidm's stable UUID.
`preferred_username` and `email` are verified and stored as a display-only
label; no decision ever reads them back. Rename the person in Kanidm and
the next login still resolves to the same local account, with the label
refreshed — a taken-over username cannot re-point the door, because the
name is not the key. (A rename can change what the gates see only by
moving the person between groups, which is the gate working, not a leak.)

## 6. What this door is not

Authentication plus the two membership booleans of §3 — nothing else.
grappa reads the `groups` claim only to answer "is this person in THIS
one group" twice; it maps no roles, invents no permissions, and grants
nothing beyond `is_admin`. Every other provider-side group stays
provider-side; any other privilege in grappa is granted in grappa.
